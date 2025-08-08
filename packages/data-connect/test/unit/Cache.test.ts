/* eslint-disable unused-imports/no-unused-imports-ts */
/* eslint-disable @typescript-eslint/no-unused-vars */
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
import * as sinon from 'sinon';

import {
  DataConnect,
  DataConnectOptions,
  DataSource,
  executeQuery,
  getDataConnect,
  mutationRef,
  queryRef,
  QueryResult,
  SerializedRef,
  SOURCE_SERVER
} from '../../src';
import { BackingDataObject, Cache, StubDataObject } from '../../src/core/Cache';
import { Code, DataConnectError } from '../../src/core/error';
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
  reviews: Review[];
}

const reviewer1: Reviewer = {
  __typename: 'Reviewer',
  __id: '101',
  id: '101',
  name: 'John Doe'
};

const review1: Review = {
  __typename: 'Review',
  __id: '201',
  id: '201',
  text: 'Amazing!',
  reviewer: reviewer1
};

const movie1: Movie = {
  __typename: 'Movie',
  __id: '1',
  id: '1',
  title: 'Inception',
  releaseYear: 2010,
  reviews: [review1]
};

const movie2: Movie = {
  __typename: 'Movie',
  __id: '2',
  id: '2',
  title: 'The Matrix',
  releaseYear: 1999,
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
    it('should create new BDOs for a list of new entities', () => {
      // This test validates the `createBdo` path for multiple entities.
      const queryResult = createMockQueryResult(
        'listMovies',
        { limit: 2 },
        { movies: [movie1, movie2] },
        options,
        dc
      );
      cache.updateCache(queryResult);

      // 1. Check Result Tree Cache for the list of stubs
      const resultTreeKey = Cache.makeResultTreeCacheKey('listMovies', {
        limit: 2
      });
      const resultTree = cache.resultTreeCache.get(resultTreeKey)!;
      const stubList = resultTree.movies;
      expect(stubList).to.be.an('array').with.lengthOf(2);
      expect(stubList[0].title).to.equal('Inception');
      expect(stubList[1].title).to.equal('The Matrix');

      // 2. Check that four new BDOs were created in the BDO Cache
      expect(cache.bdoCache.size).to.equal(4); // movie1, review1, reviewer1, movie2
      const bdo1 = cache.bdoCache.get(Cache.makeBdoCacheKey('Movie', '1'))!;
      const bdo2 = cache.bdoCache.get(Cache.makeBdoCacheKey('Movie', '2'))!;
      expect(bdo1).to.exist.and.be.an.instanceof(BackingDataObject);
      expect(bdo2).to.exist.and.be.an.instanceof(BackingDataObject);

      // 3. White-box test: Check that each BDO has the correct stub as a listener.
      const listeners1 = bdo1.listeners;
      const listeners2 = bdo2.listeners;
      expect(listeners1.has(stubList[0])).to.be.true;
      expect(listeners2.has(stubList[1])).to.be.true;
    });

    it('should update an existing BDO and propagate changes to all listeners', () => {
      // This test validates the `updateBdo` path and the reactivity mechanism.
      // Step 1: Cache a list of movies, implicitly calling `createBdo`.
      const listQueryResult = createMockQueryResult(
        'listMovies',
        {},
        {
          movies: [movie1]
        },
        options,
        dc
      );
      cache.updateCache(listQueryResult);

      // Get the original stub from the list to check it later
      const resultTreeKey = Cache.makeResultTreeCacheKey('listMovies', {});
      const originalStub = cache.resultTreeCache.get(resultTreeKey)!.movies[0];
      expect(originalStub.title).to.equal('Inception');
      expect(cache.bdoCache.size).to.equal(3); // movie1, review1, reviewer1

      // Step 2: A new query result comes in with updated data for the same movie.
      // This should trigger the `updateBdo` logic path.
      const updatedMovie1 = {
        ...movie1,
        title: "Inception (Director's Cut)"
      };
      const singleQueryResult = createMockQueryResult(
        'getMovie',
        { id: '1' },
        { movie: updatedMovie1 },
        options,
        dc
      );
      cache.updateCache(singleQueryResult);

      // Assertions
      // 1. No new BDO was created; the existing one was found and updated.
      expect(cache.bdoCache.size).to.equal(3);

      // 2. The new stub from the getMovie query has the new title.
      const newStub = cache.resultTreeCache.get(
        Cache.makeResultTreeCacheKey('getMovie', { id: '1' })
      )!.movie as StubDataObject;
      expect(newStub.title).to.equal("Inception (Director's Cut)");

      // 3. CRITICAL: The original stub in the list was also updated via the listener mechanism.
      // This confirms that `updateFromServer` correctly notified all listeners.
      expect(originalStub.title).to.equal("Inception (Director's Cut)");

      // 4. White-box test: The BDO now has two listeners (the original list stub and the new single-item stub).
      const bdo = cache.bdoCache.get(Cache.makeBdoCacheKey('Movie', '1'))!;
      const listeners = bdo.listeners;
      expect(listeners.size).to.equal(2);
      expect(listeners.has(originalStub)).to.be.true;
      expect(listeners.has(newStub)).to.be.true;
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

    it('should correctly normalize nested entities', () => {
      const queryResult = createMockQueryResult(
        'getMovieWithReviews',
        { id: '1' },
        { movie: movie1 },
        options,
        dc
      );
      cache.updateCache(queryResult);

      // 1. Check that BDOs were created for Movie, Review, and Reviewer
      expect(cache.bdoCache.size).to.equal(3);
      expect(cache.bdoCache.has(Cache.makeBdoCacheKey('Movie', '1'))).to.be
        .true;
      expect(cache.bdoCache.has(Cache.makeBdoCacheKey('Review', '201'))).to.be
        .true;
      expect(cache.bdoCache.has(Cache.makeBdoCacheKey('Reviewer', '101'))).to.be
        .true;

      // 2. Check the stub result tree for correct structure
      const resultTree = cache.resultTreeCache.get(
        Cache.makeResultTreeCacheKey('getMovieWithReviews', { id: '1' })
      )!;
      const movieStub = resultTree.movie as Movie;
      expect(movieStub.title).to.equal('Inception');
      expect(movieStub.reviews).to.be.an('array').with.lengthOf(1);
      const reviewStub = movieStub.reviews[0];
      expect(reviewStub.text).to.equal('Amazing!');
      expect(reviewStub.reviewer.name).to.equal('John Doe');

      // 3. Check that stubs are distinct objects from BDOs
      const movieBdo = cache.bdoCache.get(Cache.makeBdoCacheKey('Movie', '1'))!;
      expect(movieStub).to.not.equal(movieBdo);
      expect({...movieStub}).to.equal({...movieBdo});
    });

    it('should propagate changes from a nested entity to all parent listeners', () => {
      // 1. Cache a movie with its review
      const movieQueryResult = createMockQueryResult(
        'getMovie',
        { id: '1' },
        { movie: movie1 },
        options,
        dc
      );
      cache.updateCache(movieQueryResult);

      const movieStub = cache.resultTreeCache.get(
        Cache.makeResultTreeCacheKey('getMovie', { id: '1' })
      )!.movie as Movie;
      expect(movieStub.reviews[0].text).to.equal('Amazing!');

      // 2. A new query updates the review text
      const updatedReview = {
        ...review1,
        text: 'Actually, it was just okay.'
      };
      const reviewQueryResult = createMockQueryResult(
        'getReview',
        { id: '201' },
        { review: updatedReview },
        options,
        dc
      );
      cache.updateCache(reviewQueryResult);

      // 3. Assert that the original movie stub now reflects the updated review text
      expect(cache.bdoCache.size).to.equal(3); // BDOs should be updated, not created
      expect(movieStub.reviews[0].text).to.equal('Actually, it was just okay.');
    });

    it('should handle non-normalizable data by storing it on the stub', () => {
      // Movie with an aggregate field and a related object without a primary key
      const queryData = {
        movie: {
          ...movie1,
          __typename: 'Movie',
          __id: '1',
          // Non-normalizable aggregate field
          reviewCount: 1,
          // Related object without a primary key (__id)
          primaryGenre: {
            __typename: 'Genre',
            name: 'Sci-Fi'
          }
        }
      };

      const queryResult = createMockQueryResult(
        'getMovieWithExtra',
        { id: '1' },
        queryData,
        options,
        dc
      );
      cache.updateCache(queryResult);

      // 1. Check that BDOs were created for normalizable types only
      expect(cache.bdoCache.size).to.equal(3); // Movie, Review, Reviewer
      expect(cache.bdoCache.has(Cache.makeBdoCacheKey('Movie', '1'))).to.be
        .true;
      // CRITICAL: No BDO should be created for Genre
      expect(cache.bdoCache.has(Cache.makeBdoCacheKey('Genre', ''))).to.be
        .false;

      // 2. Check that non-normalizable fields are present on the stub
      const resultTree = cache.resultTreeCache.get(
        Cache.makeResultTreeCacheKey('getMovieWithExtra', { id: '1' })
      )!;
      const movieStub = resultTree.movie as Movie;
      expect(movieStub.reviewCount).to.equal(1);
      expect(movieStub.primaryGenre).to.deep.equal({
        __typename: 'Genre',
        name: 'Sci-Fi'
      });
    });

    it('should handle null values in query results gracefully', () => {
      const queryData = {
        movie: {
          ...movie1,
          reviews: null // The list of reviews is null
        }
      };
      const queryResult = createMockQueryResult(
        'getMovie',
        { id: '1' },
        queryData,
        options,
        dc
      );
      cache.updateCache(queryResult);

      const resultTree = cache.resultTreeCache.get(
        Cache.makeResultTreeCacheKey('getMovie', { id: '1' })
      )!;
      const movieStub = resultTree.movie as Movie;
      expect(movieStub.title).to.equal('Inception');
      expect(movieStub.reviews).to.be.null;
      // BDOs for movie, review, and reviewer from the original `movie1` object
      // should still be created, as the normalization happens recursively before nulling.
      expect(cache.bdoCache.size).to.equal(3);
    });
  });
});
