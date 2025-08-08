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

/** Value is any FDC scalar value. */ // TODO: make this more accurate
type Value = string | number | boolean | null | undefined | object | Value[];

/**
 * Defines the shape of query result data that represents a single entity.
 * It must have __typename and __id for normalization.
 */
export interface QueryResultData {
  [key: string]: Value;
  __typename: string;
  __id: string;
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
  private listeners: Set<StubDataObject>;

  /**
   * Adds a StubDataObject to the set of listeners for this BackingDataObject.
   * @param listener The StubDataObject to add.
   */
  addListener(listener: StubDataObject): void {
    this.listeners.add(listener);
  }

  /**
   * Removes a StubDataObject from the set of listeners.
   * @param listener The StubDataObject to remove.
   */
  removeListener(listener: StubDataObject): void {
    this.listeners.delete(listener);
  }

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
    // notify listeners
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
    const stubResultTree: StubResultTree = {};

    // eslint-disable-next-line guard-for-in
    for (const key in queryResult.data) {
      const entityOrEntityList = (queryResult.data as Record<string, unknown>)[
        key
      ];
      if (Array.isArray(entityOrEntityList)) {
        const sdoList: StubDataObjectList = [];
        entityOrEntityList.forEach(entity => {
          if (isCacheableQueryResultData(entity)) {
            const stubDataObject = this.cacheData(entity);
            sdoList.push(stubDataObject);
          }
        });
        stubResultTree[key] = sdoList;
      } else if (isCacheableQueryResultData(entityOrEntityList)) {
        const stubDataObject = this.cacheData(entityOrEntityList);
        stubResultTree[key] = stubDataObject;
      }
    }
    this.resultTreeCache.set(resultTreeCacheKey, stubResultTree);
  }

  /**
   * Caches a single entity: gets or creates its BDO and returns a linked stub.
   * @param data A single entity object from the query result.
   * @returns A StubDataObject linked to the entity's BackingDataObject.
   */
  private cacheData(data: QueryResultData): StubDataObject {
    const stubDataaObject: StubDataObject = { ...data };
    const bdoCacheKey = Cache.makeBdoCacheKey(data.__typename, data.__id);
    const existingBdo = this.bdoCache.get(bdoCacheKey);

    if (existingBdo) {
      this.updateBdo(existingBdo, data, stubDataaObject);
    } else {
      this.createBdo(bdoCacheKey, data, stubDataaObject);
    }
    return stubDataaObject;
  }

  /**
   * Creates a new BackingDataObject and adds it to the cache.
   * @param bdoCacheKey The cache key for the new BDO.
   * @param data The entity data from the server.
   * @param stubDataObject The first stub to listen to this BDO.
   */
  private createBdo(
    bdoCacheKey: string,
    data: QueryResultData,
    stubDataObject: StubDataObject
  ): void {
    // TODO: don't cache non-cacheable fields!
    const serverValues = new Map<string, Value>(Object.entries(data));
    const newBdo = new BackingDataObject(bdoCacheKey, serverValues);
    newBdo.addListener(stubDataObject);
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
    for (const [key, value] of Object.entries(data)) {
      backingDataObject.updateFromServer(value, key);
    }
    backingDataObject.addListener(stubDataObject);
  }
}
