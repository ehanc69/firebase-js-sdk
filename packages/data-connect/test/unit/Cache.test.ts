/**
 * @license
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { deleteApp, FirebaseApp, initializeApp } from '@firebase/app';
import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import {
  DataConnect,
  DataConnectOptions,
  DataSource,
  getDataConnect,
  QueryResult,
  SerializedRef,
  SOURCE_SERVER
} from '../../src';
import {
  BackingDataObject,
  Cache,
  StubDataObject,
  StubResultTree
} from '../../src/core/Cache';
chai.use(chaiAsPromised);

// Helper to create a mock QueryResult object for tests
function createMockQueryResult<Data extends object, Variables>(
  queryName: string,
  variables: Variables,
  data: Data,
  dataConnectOptions: DataConnectOptions,
  dataconnect: DataConnect,
  source: DataSource = SOURCE_SERVER
): QueryResult<Data, Variables> {
  const fetchTime = 'NOW';

  return {
    ref: {
      name: queryName,
      variables,
      refType: 'query',
      dataConnect: dataconnect
    },
    data,
    source,
    fetchTime,
    toJSON(): SerializedRef<Data, Variables> {
      return {
        data,
        source,
        fetchTime,
        refInfo: {
          name: queryName,
          variables,
          connectorConfig: dataConnectOptions
        }
      };
    }
  };
}

const options: DataConnectOptions = {
  connector: 'c',
  location: 'l',
  projectId: 'p',
  service: 's'
};

// Sample entity data for testing
interface Reviewer extends StubDataObject {
  __typename: 'Reviewer';
  __id: string;
  id: string;
  name: string;
}

interface Review extends StubDataObject {
  __typename: 'Review';
  __id: string;
  id: string;
  text: string;
  reviewer: Reviewer;
}

interface Movie extends StubDataObject {
  __typename: 'Movie';
  __id: string;
  id: string;
  title: string;
  releaseYear: number;
  description?: string;
  reviews?: Review[];
  reviewCount?: number;
  primaryGenre?: object;
}

// Test Data - Reviewers
const reviewer1: Reviewer = {
  __typename: 'Reviewer',
  __id: '101',
  id: '101',
  name: 'John Doe'
};
const reviewer2: Reviewer = {
  __typename: 'Reviewer',
  __id: '102',
  id: '102',
  name: 'Jane Smith'
};

// Test Data - Reviews
const review1: Review = {
  __typename: 'Review',
  __id: '201',
  id: '201',
  text: 'Amazing!',
  reviewer: reviewer1
};
const review2: Review = {
  __typename: 'Review',
  __id: '202',
  id: '202',
  text: 'A must-see.',
  reviewer: reviewer2
};

// Test Data - Movies
const movieSimple1: Movie = {
  __typename: 'Movie',
  __id: '1',
  id: '1',
  title: 'The Matrix',
  releaseYear: 1999
};

const movieSimple2: Movie = {
  __typename: 'Movie',
  __id: '2',
  id: '2',
  title: 'The Dark Knight',
  releaseYear: 2008
};

const movieWithReviews: Movie = {
  __typename: 'Movie',
  __id: '3',
  id: '3',
  title: 'Inception',
  releaseYear: 2010,
  reviews: [review1, review2]
};

const movieWithEmptyReviews: Movie = {
  __typename: 'Movie',
  __id: '4',
  id: '4',
  title: 'Pulp Fiction',
  releaseYear: 1994,
  reviews: []
};

describe('Normalized Cache Tests', () => {
  let dc: DataConnect;
  let app: FirebaseApp;
  let cache: Cache;
  const APPID = 'MYAPPID';
  const APPNAME = 'MYAPPNAME';

  beforeEach(() => {
    app = initializeApp({ projectId: 'p', appId: APPID }, APPNAME);
    dc = getDataConnect(app, {
      connector: 'c',
      location: 'l',
      service: 's'
    });
    cache = new Cache();
  });
  afterEach(async () => {
    await dc._delete();
    await deleteApp(app);
  });

  describe('Key Generation', () => {
    it('should create a consistent result tree cache key', () => {
      const key1 = Cache.srtCacheKey('listMovies', { limit: 10 });
      const key2 = Cache.srtCacheKey('listMovies', { limit: 10 });
      const key3 = Cache.srtCacheKey('listMovies', { limit: 20 });
      expect(key1).to.equal(key2);
      expect(key1).to.not.equal(key3);
      expect(key1).to.equal('listMovies|{"limit":10}');
    });

    it('should create a consistent BDO cache key', () => {
      const key1 = Cache.bdoCacheKey('Movie', '1');
      const key2 = Cache.bdoCacheKey('Movie', '1');
      const key3 = Cache.bdoCacheKey('Actor', '1');
      expect(key1).to.equal(key2);
      expect(key1).to.not.equal(key3);
      expect(key1).to.equal('Movie|"1"');
    });
  });

  describe('updateCache', () => {
    describe('with flat, non-nested entities', () => {
      it('should create a new BDO for a new returned entity', () => {
        const queryResult = createMockQueryResult(
          'getMovie',
          { id: movieSimple1.id },
          { movie: movieSimple1 },
          options,
          dc
        );
        cache.updateCache(queryResult);

        const resultTreeKey = Cache.srtCacheKey('getMovie', {
          id: movieSimple1.id
        });
        const resultTree = cache.srtCache.get(resultTreeKey)!;
        const stubDataObject = resultTree.movie as StubDataObject;
        expect(stubDataObject.title).to.equal(movieSimple1.title);

        expect(cache.bdoCache.size).to.equal(1);
        const bdo = cache.bdoCache.get(
          Cache.bdoCacheKey(movieSimple1.__typename, movieSimple1.__id)
        )!;
        expect(bdo).to.exist.and.be.an.instanceof(BackingDataObject);
        expect(bdo.listeners.has(stubDataObject)).to.be.true;
      });

      it('should create new BDOs for a list of new returned entities', () => {
        const movies = [movieSimple1, movieSimple2];
        const queryResult = createMockQueryResult(
          'listMovies',
          { limit: 2 },
          { movies },
          options,
          dc
        );
        cache.updateCache(queryResult);

        const resultTreeKey = Cache.srtCacheKey('listMovies', {
          limit: 2
        });
        const resultTree = cache.srtCache.get(resultTreeKey)!;
        const stubList = resultTree.movies;
        expect(stubList).to.be.an('array').with.lengthOf(2);
        expect(stubList[0].title).to.equal(movieSimple1.title);
        expect(stubList[1].title).to.equal(movieSimple2.title);

        expect(cache.bdoCache.size).to.equal(2);
        const bdo1 = cache.bdoCache.get(
          Cache.bdoCacheKey(movieSimple1.__typename, movieSimple1.__id)
        )!;
        const bdo2 = cache.bdoCache.get(
          Cache.bdoCacheKey(movieSimple2.__typename, movieSimple2.__id)
        )!;
        expect(bdo1).to.exist;
        expect(bdo2).to.exist;
        expect(bdo1.listeners.has(stubList[0])).to.be.true;
        expect(bdo2.listeners.has(stubList[1])).to.be.true;
      });

      it('should update an existing BDO and propagate changes to all listeners', async () => {
        const listQueryResult = createMockQueryResult(
          'listMovies',
          {},
          { movies: [movieSimple1] },
          options,
          dc
        );
        cache.updateCache(listQueryResult);

        const resultTreeKey = Cache.srtCacheKey('listMovies', {});
        const cachedStubs = cache.srtCache.get(resultTreeKey)!.movies;
        const cachedStub: Movie = cachedStubs[0];

        expect(cachedStub.title).to.equal(movieSimple1.title);
        expect(cache.bdoCache.size).to.equal(1);

        // expect BDO cache to be updated
        expect(cache.bdoCache.size).to.equal(1);
        const bdo = cache.bdoCache.get(
          Cache.bdoCacheKey(movieSimple1.__typename, movieSimple1.__id)
        )!;
        expect(bdo.listeners.size).to.equal(1);
        expect(bdo.listeners.has(cachedStub)).to.be.true;

        const updatedMovie = {
          ...movieSimple1,
          title: 'The Matrix Reloaded'
        };
        const singleQueryResult = createMockQueryResult(
          'getMovie',
          { id: movieSimple1.id },
          { movie: updatedMovie },
          options,
          dc
        );
        cache.updateCache(singleQueryResult);

        // expect stubs to have been updated
        const newStub = cache.srtCache.get(
          Cache.srtCacheKey('getMovie', { id: movieSimple1.id })
        )!.movie as StubDataObject;
        expect(newStub.title).to.equal(updatedMovie.title);
        expect(cachedStub.title).to.equal(updatedMovie.title);

        // expect BDO cache to be updated
        expect(bdo.listeners.size).to.equal(2);
        expect(bdo.listeners.has(cachedStub)).to.be.true;
        expect(bdo.listeners.has(newStub)).to.be.true;
      });

      it('should handle empty lists in query results gracefully', () => {
        const queryResult = createMockQueryResult(
          'searchMovies',
          { title: 'NonExistent' },
          { movies: [] },
          options,
          dc
        );
        cache.updateCache(queryResult);

        const resultTree = cache.srtCache.get(
          Cache.srtCacheKey('searchMovies', { title: 'NonExistent' })
        );
        expect(resultTree).to.exist;
        const stubList = resultTree!.movies as StubDataObject[];
        expect(stubList).to.be.an('array').with.lengthOf(0);
        expect(cache.bdoCache.size).to.equal(0);
      });

      it('should handle null values in query results gracefully', () => {
        const queryData = {
          movie: {
            ...movieSimple1,
            reviews: null
          }
        };
        const queryResult = createMockQueryResult(
          'getMovie',
          { id: movieSimple1.id },
          queryData,
          options,
          dc
        );
        cache.updateCache(queryResult);

        const resultTree = cache.srtCache.get(
          Cache.srtCacheKey('getMovie', { id: movieSimple1.id })
        )!;
        const movieStub = resultTree.movie as Movie;
        expect(movieStub.title).to.equal(movieSimple1.title);
        expect(movieStub.reviews).to.be.null;
        expect(cache.bdoCache.size).to.equal(1);
      });

      it('should only update stubs that depend on the updated value', () => {
        // 1. Cache a query that gets a movie with title and release year.
        const movieWithDescription: Movie = {
          __typename: 'Movie',
          __id: '5',
          id: '5',
          title: 'Forrest Gump',
          description:
            "Life is like a box of chocolates - you never know what you're going to get!",
          releaseYear: 1994
        };
        const fullQueryResult = createMockQueryResult(
          'getMovieWithDescription',
          { id: '5' },
          { movie: movieWithDescription },
          options,
          dc
        );
        cache.updateCache(fullQueryResult);

        // Get the stub for the full movie data.
        const fullStub = cache.srtCache.get(
          Cache.srtCacheKey('getMovieWithDescription', { id: '5' })
        )!.movie as Movie;
        expect(fullStub.title).to.equal(movieWithDescription.title);
        expect(fullStub.releaseYear).to.equal(movieWithDescription.releaseYear);
        expect(fullStub.description).to.equal(movieWithDescription.description);

        // 2. Cache another query that gets the same movie but only with the title.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { description, ...movieWithoutDescription } =
          movieWithDescription;
        const partialQueryResult = createMockQueryResult(
          'getMovieWithoutDescription',
          { id: '5' },
          { movie: movieWithoutDescription },
          options,
          dc
        );
        cache.updateCache(partialQueryResult);

        // Get the stub for the partial movie data.
        const partialStub = cache.srtCache.get(
          Cache.srtCacheKey('getMovieWithoutDescription', {
            id: '5'
          })
        )!.movie as Movie;
        expect(partialStub.title).to.equal(movieWithDescription.title);
        expect(partialStub.releaseYear).to.equal(
          movieWithDescription.releaseYear
        );
        expect(partialStub).to.not.have.property('description');

        // 3. A new query result comes in that updates the release year.
        const updatedMovie = {
          ...movieWithDescription,
          releaseYear: movieWithDescription.releaseYear + 10, // Year updated
          description: 'A feel-good remake of a family classic!'
        };
        const checkForUpdatedMovieResult = createMockQueryResult(
          'checkForUpdatedMovie',
          { id: '5' },
          { movie: updatedMovie },
          options,
          dc
        );
        cache.updateCache(checkForUpdatedMovieResult);

        // 4. Assert that the stubs are updated.
        expect(fullStub.releaseYear).to.equal(updatedMovie.releaseYear);
        expect(fullStub.description).to.equal(updatedMovie.description);
        expect(partialStub.releaseYear).to.equal(updatedMovie.releaseYear);

        // 5. Assert that the stub without releaseYear did not have its description property updated.
        expect(partialStub).to.not.have.property('description');

        // 6. White-box test: Check that the BDO has both stubs as listeners.
        const bdo = cache.bdoCache.get(Cache.bdoCacheKey('Movie', '5'))!;
        expect(bdo.listeners.size).to.equal(3); // fullStub, partialStub, and the stub from updateMovie
        expect(bdo.listeners.has(fullStub)).to.be.true;
        expect(bdo.listeners.has(partialStub)).to.be.true;
      });

      it('should handle non-normalizable data by storing it on the stub', () => {
        const { __typename, __id, ...nonNormalizeableMovie } =
          movieWithEmptyReviews;

        const queryData = {
          movie: {
            ...nonNormalizeableMovie,
            typenameCopy: __typename,
            idCopy: __id
          }
        };

        const queryResult = createMockQueryResult(
          'getMovieWithExtra',
          { id: nonNormalizeableMovie.id },
          queryData,
          options,
          dc
        );
        cache.updateCache(queryResult);

        const resultTree = cache.srtCache.get(
          Cache.srtCacheKey('getMovieWithExtra', {
            id: nonNormalizeableMovie.id
          })
        )!;

        // Single movie StubResultTree
        const stub = resultTree.movie as Movie;
        expect(stub.id).to.equal(nonNormalizeableMovie.id);
        expect(stub.title).to.equal(nonNormalizeableMovie.title);
        expect(stub.releaseYear).to.equal(nonNormalizeableMovie.releaseYear);

        // No BDOs should be cached
        expect(cache.bdoCache.size).to.equal(0);
      });
    });

    describe('with nested entities', () => {
      it('should correctly normalize a single entity with nested objects', () => {
        const queryResult = createMockQueryResult(
          'getMovieWithReviews',
          { id: movieWithReviews.id },
          { movie: movieWithReviews },
          options,
          dc
        );
        cache.updateCache(queryResult);

        expect(cache.bdoCache.size).to.equal(5); // Movie, 2 Reviews, 2 Reviewers
        expect(
          cache.bdoCache.has(
            Cache.bdoCacheKey(
              movieWithReviews.__typename,
              movieWithReviews.__id
            )
          )
        ).to.be.true;
        expect(
          cache.bdoCache.has(
            Cache.bdoCacheKey(review1.__typename, review1.__id)
          )
        ).to.be.true;
        expect(
          cache.bdoCache.has(
            Cache.bdoCacheKey(reviewer1.__typename, reviewer1.__id)
          )
        ).to.be.true;

        const resultTree = cache.srtCache.get(
          Cache.srtCacheKey('getMovieWithReviews', {
            id: movieWithReviews.id
          })
        )!;
        const movieStub = resultTree.movie as Movie;
        expect(movieStub.title).to.equal(movieWithReviews.title);
        expect(movieStub.reviews).to.be.an('array').with.lengthOf(2);
        const reviewStub = movieStub.reviews![0];
        expect(reviewStub.text).to.equal(review1.text);
        expect(reviewStub.reviewer.name).to.equal(reviewer1.name);
      });

      it('should correctly normalize a list of entities with nested objects', () => {
        const movies = [movieWithReviews, movieWithEmptyReviews];
        const queryResult = createMockQueryResult(
          'listMovies',
          {},
          { movies },
          options,
          dc
        );
        cache.updateCache(queryResult);

        // movieWithReviews (1 movie, 2 reviews, 2 reviewers) + movieWithEmptyReviews (1 movie) = 6 BDOs
        expect(cache.bdoCache.size).to.equal(6);

        const resultTree = cache.srtCache.get(
          Cache.srtCacheKey('listMovies', {})
        )!;
        const stubs = resultTree.movies as Movie[];
        expect(stubs[0].title).to.equal(movieWithReviews.title);
        expect(stubs[0].reviews).to.have.lengthOf(2);
        expect(stubs[0].reviews![0].text).to.equal(review1.text);
        expect(stubs[1].title).to.equal(movieWithEmptyReviews.title);
        expect(stubs[1].reviews).to.have.lengthOf(0);
      });

      it('should propagate changes from a nested entity to all parent listeners', () => {
        const movieQueryResult = createMockQueryResult(
          'getMovie',
          { id: movieWithReviews.id },
          { movie: movieWithReviews },
          options,
          dc
        );
        cache.updateCache(movieQueryResult);

        const movieStub = cache.srtCache.get(
          Cache.srtCacheKey('getMovie', { id: movieWithReviews.id })
        )!.movie as Movie;
        expect(movieStub.reviews![0].text).to.equal(review1.text);

        const updatedReview = {
          ...review1,
          text: 'Actually, it was just okay.'
        };
        const reviewQueryResult = createMockQueryResult(
          'getReview',
          { id: review1.id },
          { review: updatedReview },
          options,
          dc
        );
        cache.updateCache(reviewQueryResult);

        expect(cache.bdoCache.size).to.equal(5); // Movie, 2 Reviews, 2 Reviewers
        expect(movieStub.reviews![0].text).to.equal(updatedReview.text);
      });

      it('should handle non-normalizable data by storing it on the stub', () => {
        const { __typename, __id, ...nonNormalizeableMovie } = movieWithReviews;

        const queryData = {
          movie: {
            ...nonNormalizeableMovie,
            typenameCopy: __typename,
            idCopy: __id
          }
        };

        const queryResult = createMockQueryResult(
          'getMovieWithExtra',
          { id: nonNormalizeableMovie.id },
          queryData,
          options,
          dc
        );
        cache.updateCache(queryResult);

        const resultTree = cache.srtCache.get(
          Cache.srtCacheKey('getMovieWithExtra', {
            id: nonNormalizeableMovie.id
          })
        )!;

        // Single movie StubResultTree
        const stub = resultTree.movie as Movie;
        expect(stub.id).to.equal(nonNormalizeableMovie.id);
        expect(stub.title).to.equal(nonNormalizeableMovie.title);
        expect(stub.releaseYear).to.equal(nonNormalizeableMovie.releaseYear);

        // 4 BDOs should be cached - Review1, Review2, Reviewer1, Reviewer2
        expect(cache.bdoCache.size).to.equal(4);
        expect(
          cache.bdoCache.has(
            Cache.bdoCacheKey(
              movieWithReviews.__typename,
              movieWithReviews.__id
            )
          )
        ).to.be.false;
      });
    });
  });
});

// eslint-disable-next-line @typescript-eslint/naming-convention
export interface Movie_Key {
  id: string;
  __typename?: 'Movie_Key';
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export interface Actor_Key {
  id: string;
  __typename?: 'Actor_Key';
}

/** The selection set for the movies field of the ListMovies query */
// eslint-disable-next-line @typescript-eslint/naming-convention
interface ListMovies_Movies extends StubDataObject {
  id: string;
  title: string;
  imageUrl: string;
  releaseYear?: number | null;
  genre?: string | null;
  rating?: number | null;
  tags?: string[] | null;
  description?: string | null;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
interface ListMovies_Actor extends StubDataObject {
  id: string;
  name: string;
}

/** The shape of the data returned from this query */
export interface ListMoviesData extends StubResultTree {
  // eslint-disable-next-line @typescript-eslint/array-type
  movies: (ListMovies_Movies & Movie_Key)[];
  actor: ListMovies_Actor & Actor_Key;
}
