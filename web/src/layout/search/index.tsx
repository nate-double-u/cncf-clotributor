import classNames from 'classnames';
import { Loading, NoData, Pagination, PaginationLimitOptions, SortOptions } from 'clo-ui';
import { isEmpty, isUndefined } from 'lodash';
import { Dispatch, SetStateAction, useContext, useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import API from '../../api';
import { AppContext, updateLimit, updateSort } from '../../context/AppContextProvider';
import { DEFAULT_SORT_BY, SORT_OPTIONS } from '../../data';
import { Issue, SearchFiltersURL, SortBy } from '../../types';
import buildSearchParams from '../../utils/buildSearchParams';
import prepareQueryString from '../../utils/prepareQueryString';
import Card from '../common/Card';
// import Filters from './Filters';
import styles from './Search.module.css';
import SelectedFilters from './SelectedFilters';

interface FiltersProp {
  [key: string]: string[];
}

interface Props {
  scrollPosition?: number;
  setScrollPosition: Dispatch<SetStateAction<number | undefined>>;
}

const Search = (props: Props) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { ctx, dispatch } = useContext(AppContext);
  const { limit, sort } = ctx.prefs.search;
  const [searchParams] = useSearchParams();
  const [text, setText] = useState<string | undefined>();
  const [filters, setFilters] = useState<FiltersProp>({});
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [total, setTotal] = useState<number>(0);
  const [issues, setIssues] = useState<Issue[] | null | undefined>();
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const currentState = location.state as { resetScrollPosition?: boolean };

  const onResetFilters = (): void => {
    props.setScrollPosition(0);
    navigate({
      pathname: '/search',
      search: prepareQueryString({
        pageNumber: 1,
        ts_query_web: text,
        filters: {},
      }),
    });
  };

  const onFiltersChange = (name: string, value: string, checked: boolean): void => {
    const currentFilters = filters || {};
    let newFilters = isUndefined(currentFilters[name]) ? [] : currentFilters[name].slice();
    if (checked) {
      newFilters.push(value);
    } else {
      newFilters = newFilters.filter((el) => el !== value);
    }

    updateCurrentPage({
      filters: { ...currentFilters, [name]: newFilters },
    });
  };

  const onPaginationLimitChange = (newLimit: number): void => {
    props.setScrollPosition(0);
    navigate({
      pathname: '/search',
      search: prepareQueryString({
        ...getCurrentFilters(),
        pageNumber: 1,
      }),
    });
    dispatch(updateLimit(newLimit));
  };

  const onSortChange = (by: string): void => {
    props.setScrollPosition(0);
    // Load pageNumber is forced before update Sorting criteria
    navigate(
      {
        pathname: '/search',
        search: prepareQueryString({
          ...getCurrentFilters(),
          pageNumber: 1,
        }),
      },
      { replace: true }
    );
    dispatch(updateSort(by as SortBy));
  };

  const onPageNumberChange = (pageNumber: number): void => {
    updateCurrentPage({
      pageNumber: pageNumber,
    });
  };

  const updateCurrentPage = (searchChanges: any) => {
    props.setScrollPosition(0);
    navigate({
      pathname: '/search',
      search: prepareQueryString({
        ...getCurrentFilters(),
        pageNumber: 1,
        ...searchChanges,
      }),
    });
  };

  const getCurrentFilters = (): SearchFiltersURL => {
    return {
      pageNumber: pageNumber,
      ts_query_web: text,
      filters: filters,
    };
  };

  const calculateOffset = (pNumber: number): number => {
    return pNumber && limit ? (pNumber - 1) * limit : 0;
  };

  const updateWindowScrollPosition = (newPosition: number) => {
    window.scrollTo(0, newPosition);
  };

  useEffect(() => {
    const formattedParams = buildSearchParams(searchParams);
    setText(formattedParams.ts_query_web);
    setFilters(formattedParams.filters || {});
    setPageNumber(formattedParams.pageNumber);

    async function searchIssues() {
      setIsLoading(true);
      try {
        const newSearchResults = await API.searchIssues({
          ts_query_web: formattedParams.ts_query_web,
          sort_by: sort.by,
          filters: formattedParams.filters || {},
          offset: calculateOffset(formattedParams.pageNumber),
          limit: limit,
        });
        setTotal(parseInt(newSearchResults['Pagination-Total-Count']));
        setIssues(newSearchResults.items);
      } catch {
        setApiError('An error occurred searching issues.');
      } finally {
        setIsLoading(false);
        let currentScrollPosition = props.scrollPosition || 0;
        if (currentState && currentState.resetScrollPosition) {
          currentScrollPosition = 0;
        }
        // Update scroll position
        updateWindowScrollPosition(currentScrollPosition);
      }
    }

    // When a new text is search, sort.by is updated to default before searching
    if (text !== formattedParams.ts_query_web && sort.by !== DEFAULT_SORT_BY) {
      dispatch(updateSort(DEFAULT_SORT_BY));
    } else {
      searchIssues();
    }

    // prettier-ignore
    /* eslint-disable react-hooks/exhaustive-deps */
  }, [searchParams, limit, sort.by]);
  /* eslint-enable react-hooks/exhaustive-deps */

  return (
    <>
      {/* Subnavbar */}
      <nav className={`navbar navbar-expand-sm ${styles.navbar}`} role="navigation">
        <div className="container-lg">
          <div className="d-flex flex-column w-100">
            <div className="d-flex flex-row align-items-center justify-content-between">
              <div className="text-truncate fw-bold w-100 Search_searchResults__hU0s2" role="status">
                {total > 0 && (
                  <span className="pe-1">
                    {calculateOffset(pageNumber) + 1} - {total < limit * pageNumber ? total : limit * pageNumber}{' '}
                    <span className="ms-1">of</span>{' '}
                  </span>
                )}
                {total}
                <span className="ps-1"> results </span>
                {text && text !== '' && (
                  <span className="d-none d-sm-inline ps-1">
                    for "<span className="fw-bold">{text}</span>"
                  </span>
                )}
              </div>

              <div className="d-flex flex-wrap flex-row justify-content-sm-end mt-3 mt-sm-0 ms-0 ms-md-3 w-100">
                {/* Only display sort options when ts_query_web is defined */}
                {text && text !== '' && <SortOptions options={SORT_OPTIONS} by={sort.by} onSortChange={onSortChange} />}
                <PaginationLimitOptions limit={limit} onPaginationLimitChange={onPaginationLimitChange} />
              </div>
            </div>

            <SelectedFilters filters={filters} onChange={onFiltersChange} />
          </div>
        </div>
      </nav>

      <main role="main" className="container-lg flex-grow-1 mb-4 mb-md-5">
        {isLoading && <Loading className={styles.loading} position="fixed" transparentBg />}
        <div
          className={classNames('h-100 position-relative d-flex flex-row align-items-start', {
            'opacity-75': isLoading,
          })}
        >
          <div className="w-100">
            {apiError && (
              <NoData className={styles.extraMargin}>
                <div className="mb-4 mb-lg-5 h2">{apiError}</div>
                <p className="h5 mb-0">Please try again later.</p>
              </NoData>
            )}

            {issues && (
              <>
                {isEmpty(issues) ? (
                  <NoData>
                    <div className="h4">
                      We're sorry!
                      <p className="h6 mb-0 mt-3 lh-base">
                        <span> We can't seem to find any issues that match your search </span>
                        {text && (
                          <span className="ps-1">
                            for "<span className="fw-bold">{text}</span>"
                          </span>
                        )}
                        {!isEmpty(filters) ? <span className="ps-1">with the selected filters</span> : <>.</>}
                      </p>
                      <p className="h6 mb-0 mt-5 lh-base">
                        You can{' '}
                        {!isEmpty(filters) ? (
                          <button
                            className="btn btn-link text-dark fw-bold py-0 pb-1 px-0"
                            onClick={onResetFilters}
                            aria-label="Reset filters"
                          >
                            <u>reset the filters</u>
                          </button>
                        ) : (
                          <button
                            className="btn btn-link text-dark fw-bold py-0 pb-1 px-0"
                            onClick={() => {
                              props.setScrollPosition(0);
                              navigate({
                                pathname: '/search',
                                search: prepareQueryString({
                                  pageNumber: 1,
                                  filters: {},
                                }),
                              });
                            }}
                            aria-label="Browse all issues"
                          >
                            <u>browse all issues</u>
                          </button>
                        )}
                        <> or try a new search.</>
                      </p>
                    </div>
                  </NoData>
                ) : (
                  <div className={`row g-0 w-100 ${styles.list}`} role="list">
                    {issues.map((issue: Issue, index: number) => {
                      return <Card key={`issue_${issue.number}_${index}`} issue={issue} />;
                    })}
                  </div>
                )}
              </>
            )}

            <div className="mt-auto mx-auto">
              <Pagination
                limit={limit}
                offset={0}
                total={total}
                active={pageNumber}
                className="mt-4 mt-md-5 mb-0 mb-md-2"
                onChange={onPageNumberChange}
              />
            </div>
          </div>
        </div>
      </main>
    </>
  );
};

export default Search;