use crate::{
    db::DynDB,
    github::{self, repo_view, DynGH},
};
use anyhow::{format_err, Context, Error, Result};
use config::Config;
use deadpool::unmanaged::{Object, Pool};
use futures::stream::{self, StreamExt};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use time::OffsetDateTime;
use tokio::time::timeout;
use tracing::{debug, info, instrument};
use uuid::Uuid;

/// Maximum time that can take tracking a single repository.
const REPOSITORY_TRACK_TIMEOUT: u64 = 300;

/// Repository information.
#[derive(Debug, Clone)]
pub(crate) struct Repository {
    pub repository_id: Uuid,
    pub url: String,
    pub topics: Option<Vec<String>>,
    pub languages: Option<Vec<String>>,
    pub stars: Option<i32>,
    pub digest: Option<String>,
}

impl Repository {
    /// Update repository's GitHub data.
    fn update_gh_data(&mut self, gh_repo: &repo_view::RepoViewRepository) -> Result<bool> {
        // Topics
        self.topics = gh_repo.repository_topics.nodes.as_ref().map(|nodes| {
            nodes
                .iter()
                .flatten()
                .map(|node| node.topic.name.clone())
                .collect()
        });

        // Languages
        self.languages = gh_repo.languages.as_ref().and_then(|languages| {
            languages.nodes.as_ref().map(|nodes| {
                nodes
                    .iter()
                    .flatten()
                    .map(|node| node.name.clone())
                    .collect()
            })
        });

        // Stars
        self.stars = Some(gh_repo.stargazer_count as i32);

        // Digest
        let prev_digest = self.digest.clone();
        self.update_digest()?;
        Ok(self.digest != prev_digest)
    }

    /// Update repository's digest.
    fn update_digest(&mut self) -> Result<()> {
        let data = bincode::serialize(&(&self.topics, &self.languages, &self.stars))?;
        let digest = hex::encode(Sha256::digest(data));
        self.digest = Some(digest);
        Ok(())
    }
}

/// Issue information.
#[derive(Debug, Clone)]
pub(crate) struct Issue {
    pub issue_id: i64,
    pub title: String,
    pub url: String,
    pub number: i32,
    pub labels: Vec<String>,
    pub published_at: OffsetDateTime,
    pub digest: Option<String>,
}

impl Issue {
    /// Update repository's digest.
    pub(crate) fn update_digest(&mut self) {
        let Ok(data) = bincode::serialize(&(&self.title, &self.labels)) else {
            return;
        };
        let digest = hex::encode(Sha256::digest(data));
        self.digest = Some(digest);
    }
}

/// Track repositories that need to be tracked.
pub(crate) async fn run(cfg: &Config, db: DynDB, gh: DynGH) -> Result<()> {
    // Setup GitHub tokens pool
    let gh_tokens = cfg.get::<Vec<String>>("creds.githubTokens")?;
    if gh_tokens.is_empty() {
        return Err(format_err!(
            "GitHub tokens not found in config file (creds.githubTokens)"
        ));
    }
    let gh_tokens_pool = Pool::from(gh_tokens.clone());

    // Get repositories to track
    debug!("getting repositories to track");
    let repositories_to_track = db.get_repositories_to_track().await?;
    if repositories_to_track.is_empty() {
        info!("no repositories to track");
        info!("tracker finished");
        return Ok(());
    }

    // Track repositories
    info!("tracking repositories");
    let result = stream::iter(repositories_to_track)
        .map(|repository| async {
            let db = db.clone();
            let gh = gh.clone();
            let gh_token = gh_tokens_pool.get().await.expect("token -when available-");
            let repo_url = repository.url.clone();

            match timeout(
                Duration::from_secs(REPOSITORY_TRACK_TIMEOUT),
                track_repository(db, gh, gh_token, repository),
            )
            .await
            {
                Ok(result) => result,
                Err(err) => Err(format_err!("{}", err)),
            }
            .context(format!("error tracking repository {}", repo_url))
        })
        .buffer_unordered(cfg.get("tracker.concurrency")?)
        .collect::<Vec<Result<()>>>()
        .await
        .into_iter()
        .fold(
            Ok::<(), Error>(()),
            |final_result, task_result| match task_result {
                Ok(()) => final_result,
                Err(task_err) => match final_result {
                    Ok(()) => Err(task_err).map_err(Into::into),
                    Err(final_err) => Err(format_err!("{:#}\n{:#}", final_err, task_err)),
                },
            },
        );

    // Check Github API rate limit status for each token
    for (i, gh_token) in gh_tokens.into_iter().enumerate() {
        let gh_client = github::setup_http_client(&gh_token)?;
        let response: Value = gh_client
            .get("https://api.github.com/rate_limit")
            .send()
            .await?
            .json()
            .await?;
        debug!(
            "token [{}] github rate limit info: [rate: {}] [graphql: {}]",
            i, response["rate"], response["resources"]["graphql"]
        );
    }

    info!("tracker finished");
    result
}

/// Track repository provided.
#[instrument(fields(url = %repo.url), skip_all, err)]
async fn track_repository(
    db: DynDB,
    gh: DynGH,
    gh_token: Object<String>,
    mut repo: Repository,
) -> Result<()> {
    let start = Instant::now();
    debug!("started");

    // Fetch repository data from GitHub
    let gh_repo = gh.repository(&gh_token, &repo.url).await?;
    // println!("{:?}", gh_repo);

    // Update repository's GitHub data in db if needed
    let changed = repo.update_gh_data(&gh_repo)?;
    if changed {
        db.update_repository_gh_data(&repo).await?;
        debug!("github data updated in database");
    }

    // Sync issues in GitHub with database
    let issues_in_gh = gh_repo.issues();
    let issues_in_db = db.get_repository_issues(repo.repository_id).await?;

    // Register/update new or outdated issues
    for issue in &issues_in_gh {
        let digest = find_issue(issue.issue_id, &issues_in_db);
        if digest.is_none() || digest != issue.digest {
            db.register_issue(repo.repository_id, issue).await?;
            debug!("registering issue #{}", issue.number);
        }
    }

    // Unregister issues no longer available in GitHub
    for issue in &issues_in_db {
        if find_issue(issue.issue_id, &issues_in_gh).is_none() {
            db.unregister_issue(issue.issue_id).await?;
            debug!("unregistering issue #{}", issue.number);
        }
    }

    // Update repository's last track timestamp in db
    db.update_repository_last_track_ts(repo.repository_id)
        .await?;

    debug!("completed in {}ms", start.elapsed().as_millis());
    Ok(())
}

/// Find an issue in the provided collection, returning its digest if found.
fn find_issue(issue_id: i64, issues: &[Issue]) -> Option<String> {
    issues
        .iter()
        .find(|i| i.issue_id == issue_id)
        .map(|i| i.digest.clone().expect("to be present"))
}