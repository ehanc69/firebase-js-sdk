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
import { BackingDataObject, Cache, StubDataObject } from '../../src/core/Cache';
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
      const key1 = Cache.makeResultTreeCacheKey('listMovies', { limit: 10 });
      const key2 = Cache.makeResultTreeCacheKey('listMovies', { limit: 10 });
      const key3 = Cache.makeResultTreeCacheKey('listMovies', { limit: 20 });
      expect(key1).to.equal(key2);
      expect(key1).to.not.equal(key3);
      expect(key1).to.equal('listMovies|{"limit":10}');
    });

    it('should create a consistent BDO cache key', () => {
      const key1 = Cache.makeBdoCacheKey('Movie', '1');
      const key2 = Cache.makeBdoCacheKey('Movie', '1');
      const key3 = Cache.makeBdoCacheKey('Actor', '1');
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

        const resultTreeKey = Cache.makeResultTreeCacheKey('getMovie', {
          id: movieSimple1.id
        });
        const resultTree = cache.resultTreeCache.get(resultTreeKey)!;
        const stubDataObject = resultTree.movie as StubDataObject;
        expect(stubDataObject.title).to.equal(movieSimple1.title);

        expect(cache.bdoCache.size).to.equal(1);
        const bdo = cache.bdoCache.get(
          Cache.makeBdoCacheKey(movieSimple1.__typename, movieSimple1.__id)
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

        const resultTreeKey = Cache.makeResultTreeCacheKey('listMovies', {
          limit: 2
        });
        const resultTree = cache.resultTreeCache.get(resultTreeKey)!;
        const stubList = resultTree.movies;
        expect(stubList).to.be.an('array').with.lengthOf(2);
        expect(stubList[0].title).to.equal(movieSimple1.title);
        expect(stubList[1].title).to.equal(movieSimple2.title);

        expect(cache.bdoCache.size).to.equal(2);
        const bdo1 = cache.bdoCache.get(
          Cache.makeBdoCacheKey(movieSimple1.__typename, movieSimple1.__id)
        )!;
        const bdo2 = cache.bdoCache.get(
          Cache.makeBdoCacheKey(movieSimple2.__typename, movieSimple2.__id)
        )!;
        expect(bdo1).to.exist;
        expect(bdo2).to.exist;
        expect(bdo1.listeners.has(stubList[0])).to.be.true;
        expect(bdo2.listeners.has(stubList[1])).to.be.true;
      });

      it('should update an existing BDO and propagate changes to all listeners', () => {
        const listQueryResult = createMockQueryResult(
          'listMovies',
          {},
          { movies: [movieSimple1] },
          options,
          dc
        );
        cache.updateCache(listQueryResult);

        const resultTreeKey = Cache.makeResultTreeCacheKey('listMovies', {});
        const originalStub =
          cache.resultTreeCache.get(resultTreeKey)!.movies[0];
        expect(originalStub.title).to.equal(movieSimple1.title);
        expect(cache.bdoCache.size).to.equal(1);

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

        expect(cache.bdoCache.size).to.equal(1);
        const newStub = cache.resultTreeCache.get(
          Cache.makeResultTreeCacheKey('getMovie', { id: movieSimple1.id })
        )!.movie as StubDataObject;
        expect(newStub.title).to.equal(updatedMovie.title);
        expect(originalStub.title).to.equal(updatedMovie.title);

        const bdo = cache.bdoCache.get(
          Cache.makeBdoCacheKey(movieSimple1.__typename, movieSimple1.__id)
        )!;
        expect(bdo.listeners.size).to.equal(2);
        expect(bdo.listeners.has(originalStub)).to.be.true;
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

        const resultTree = cache.resultTreeCache.get(
          Cache.makeResultTreeCacheKey('searchMovies', { title: 'NonExistent' })
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

        const resultTree = cache.resultTreeCache.get(
          Cache.makeResultTreeCacheKey('getMovie', { id: movieSimple1.id })
        )!;
        const movieStub = resultTree.movie as Movie;
        expect(movieStub.title).to.equal(movieSimple1.title);
        expect(movieStub.reviews).to.be.null;
        expect(cache.bdoCache.size).to.equal(1);
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
            Cache.makeBdoCacheKey(
              movieWithReviews.__typename,
              movieWithReviews.__id
            )
          )
        ).to.be.true;
        expect(
          cache.bdoCache.has(
            Cache.makeBdoCacheKey(review1.__typename, review1.__id)
          )
        ).to.be.true;
        expect(
          cache.bdoCache.has(
            Cache.makeBdoCacheKey(reviewer1.__typename, reviewer1.__id)
          )
        ).to.be.true;

        const resultTree = cache.resultTreeCache.get(
          Cache.makeResultTreeCacheKey('getMovieWithReviews', {
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

        const resultTree = cache.resultTreeCache.get(
          Cache.makeResultTreeCacheKey('listMovies', {})
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

        const movieStub = cache.resultTreeCache.get(
          Cache.makeResultTreeCacheKey('getMovie', { id: movieWithReviews.id })
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
        const queryData = {
          movie: {
            ...movieWithReviews,
            reviewCount: 2,
            primaryGenre: {
              __typename: 'Genre',
              name: 'Sci-Fi'
            }
          }
        };

        const queryResult = createMockQueryResult(
          'getMovieWithExtra',
          { id: movieWithReviews.id },
          queryData,
          options,
          dc
        );
        cache.updateCache(queryResult);

        expect(cache.bdoCache.size).to.equal(5); // Movie, 2 Reviews, 2 Reviewers
        expect(cache.bdoCache.has(Cache.makeBdoCacheKey('Genre', ''))).to.be
          .false;

        const resultTree = cache.resultTreeCache.get(
          Cache.makeResultTreeCacheKey('getMovieWithExtra', {
            id: movieWithReviews.id
          })
        )!;
        const movieStub = resultTree.movie as Movie;
        expect(movieStub.reviewCount).to.equal(2);
        expect(movieStub.primaryGenre).to.deep.equal({
          __typename: 'Genre',
          name: 'Sci-Fi'
        });
      });
    });
  });
});
