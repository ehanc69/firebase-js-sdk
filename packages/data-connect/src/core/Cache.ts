/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * @license
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { QueryResult } from '../api';

/** Value is any FDC scalar value. */
// TODO: make this more accurate... what type should we use to represent any FDC scalar value?
type Value = string | number | boolean | null | undefined | object | Value[];

/**
 * Defines the shape of query result data that represents a single entity.
 * It must have __typename and __id for normalization.
 */
// TODO: this is just a StubDataObject isn't it...?
export interface QueryResultData {
  [key: string]: Value;
  __typename?: string;
  __id?: string;
}

/**
 * A type guard to check if a value is a QueryResultData object.
 * @param value The value to check.
 * @returns True if the value is a QueryResultData object.
 */
function isCacheableQueryResultData(value: unknown): value is QueryResultData {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    '__typename' in value &&
    '__id' in value
  );
}

/**
 * Interface for a stub result tree, with fields which are stub data objects
 */
// TODO: need a better way to represent that a query may return a single entity or a list of entities
// ! ex: queryResult.data =
// !   {
// !     movies: [                    <-- list
// !               {...movie1...},
// !               {...movie2...},
// !               {...movie3...}
// !             ],
// !     currentUser: {               <-- singleton
// !       ...user...
// !     }
// !   }
interface StubResultTree {
  [key: string]: StubDataObject | StubDataObjectList;
}

/**
 * Interface for a stub data object, which acts as a "live" view into cached data.
 * Generated Data implements this interface.
 * @public
 */
export interface StubDataObject {
  [key: string]: Value | StubDataObject;
}

/**
 * A custom class for holding lists of objects.
 * This is used to support operations like append, delete, and pagination.
 * @public
 */
class StubDataObjectList extends Array<StubDataObject> {}

/**
 * A class used to hold the single source of truth for an entity's values across all queries.
 * @public
 */
export class BackingDataObject {
  /**
   * Stable unique key identifying the entity across types.
   * Format: TypeName|ID
   */
  readonly typedKey: string;

  /** Represents values received from the server. */
  private serverValues: Map<string, Value>;

  /** A set of listeners (StubDataObjects) that need to be updated when values change. */
  readonly listeners: Set<StubDataObject>;

  constructor(typedKey: string, serverValues: Map<string, Value>) {
    this.typedKey = typedKey;
    this.listeners = new Set();
    this.serverValues = serverValues;
  }

  /**
   * Updates the value for a named property from the server and notifies all listeners.
   * @param value The new value from the server.
   * @param key The key of the property to update.
   */
  updateFromServer(value: Value, key: string): void {
    this.serverValues.set(key, value);
    for (const listener of this.listeners) {
      listener[key] = value;
    }
  }

  /**
   * Retrieves the value for a given key.
   * @param key The key of the value to retrieve.
   * @returns The value associated with the key, or undefined if not found.
   */
  protected value(key: string): Value | undefined {
    return this.serverValues.get(key);
  }

  /** Values modified locally for latency compensation. */
  private localValues: Map<string, Value> = new Map();

  /**
   * Updates the value for a named property locally.
   * @param value The new local value.
   * @param key The key of the property to update.
   */
  updateLocal(value: Value, key: string): void {
    this.localValues.set(key, value);
    for (const listener of this.listeners) {
      listener[key] = value;
    }
  }
}

/**
 * A class representing the cache for query results and entity data.
 * @public
 */
export class Cache {
  /** A map of [query + variables] --> StubDataObjects returned from that query. */
  resultTreeCache = new Map<string, StubResultTree>();

  /** A map of [entity typename + id] --> BackingDataObject for that entity. */
  bdoCache = new Map<string, BackingDataObject>();

  /**
   * Creates a unique StrubResultTree cache key for a given query and its variables.
   * @param queryName The name of the query.
   * @param vars The variables used in the query.
   * @returns A unique cache key string.
   */
  static makeResultTreeCacheKey(queryName: string, vars: unknown): string {
    return queryName + '|' + JSON.stringify(vars);
  }

  /**
   * Creates a unique BackingDataObject cache key for a given entity.
   * @param typename The typename of the entity being cached.
   * @param id The unique id / primary key of this entity.
   * @returns A unique cache key string.
   */
  static makeBdoCacheKey(typename: string, id: unknown): string {
    return typename + '|' + JSON.stringify(id);
  }

  /**
   * Updates the cache with the results of a query. This is the main entry point.
   * @param queryResult The result of the query.
   */
  updateCache<Data extends object, Variables>(
    queryResult: QueryResult<Data, Variables>
  ): void {
    const resultTreeCacheKey = Cache.makeResultTreeCacheKey(
      queryResult.ref.name,
      queryResult.ref.variables
    );
    const stubResultTree = this.normalize(queryResult.data) as StubResultTree;
    this.resultTreeCache.set(resultTreeCacheKey, stubResultTree);
  }

  /**
   * Recursively traverses a data object, normalizing cacheable entities into BDOs
   * and replacing them with stubs.
   * @param data The data to normalize (can be an object, array, or primitive).
   * @returns The normalized data with stubs.
   */
  private normalize(data: QueryResultData | Value): Value | StubDataObject {
    if (Array.isArray(data)) {
      return data.map(item => this.normalize(item));
    }

    if (isCacheableQueryResultData(data)) {
      const stub: StubDataObject = {};
      const bdoCacheKey = Cache.makeBdoCacheKey(data.__typename, data.__id);
      const existingBdo = this.bdoCache.get(bdoCacheKey);

      // data is a single "movie" or "actor"
      // key is a field of the returned data, such as "name"
      for (const key in data) {
        // eslint-disable-next-line no-prototype-builtins
        if (data.hasOwnProperty(key)) {
          stub[key] = this.normalize(data[key]);
        }
      }

      if (existingBdo) {
        this.updateBdo(existingBdo, stub, stub);
      } else {
        this.createBdo(bdoCacheKey, stub, stub);
      }
      return stub;
    }

    if (typeof data === 'object' && data !== null) {
      const newObj: { [key: string]: Value } = {};
      for (const key in data) {
        // eslint-disable-next-line no-prototype-builtins
        if (data.hasOwnProperty(key)) {
          newObj[key] = this.normalize(data[key]);
        }
      }
      return newObj;
    }

    return data;
  }

  /**
   * Creates a new BackingDataObject and adds it to the cache. This obejct
   * @param bdoCacheKey The cache key for the new BDO.
   * @param data The entity data from the server.
   * @param stubDataObject The first stub to listen to this BDO.
   */
  private createBdo(
    bdoCacheKey: string,
    data: QueryResultData,
    stubDataObject: StubDataObject
  ): void {
    const serverValues = new Map<string, Value>(Object.entries(data));
    const newBdo = new BackingDataObject(bdoCacheKey, serverValues);
    newBdo.listeners.add(stubDataObject);
    this.bdoCache.set(bdoCacheKey, newBdo);
  }

  /**
   * Updates an existing BackingDataObject with new data and a new listener.
   * @param backingDataObject The existing BackingDataObject to update.
   * @param data The new entity data from the server.
   * @param stubDataObject The new stub to add as a listener.
   */
  private updateBdo(
    backingDataObject: BackingDataObject,
    data: QueryResultData,
    stubDataObject: StubDataObject
  ): void {
    // TODO: don't cache non-cacheable fields!
    // ! how do we know that a field is not cacheable...?
    // ! are we assuming entities themselves will be entirely not cacheable?
    // ! ex: queryResult.data = {movies: {...cacheable...}, currentRating: {...not cacheable...}}
    for (const [key, value] of Object.entries(data)) {
      backingDataObject.updateFromServer(value, key);
    }
    backingDataObject.listeners.add(stubDataObject);
  }
}
