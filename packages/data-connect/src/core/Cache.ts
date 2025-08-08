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
 * Defines the shape of query result data - "movies", "actor", etc.
 */
export interface QueryResultData {
  [key: string]: Value;
  __typename: string;
  __id: string;
}

/**
 * Interface for a stub result tree, with fields which are stub data objects
 */
interface StubResultTree {
  [key: string]: StubDataObject | StubDataObjectList;
}

/**
 * Interface for a stub data object, which contains a reference to its BackingDataObject.
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
 * A class used to hold entity values across all queries.
 * @public
 */
export class BackingDataObject {
  /**
   * Stable unique key identifying the entity across types.
   * TypeName + CompositePrimaryKey.
   */
  readonly typedKey: string;

  /** Represents values received from the server. */
  private serverValues: Map<string, Value>;

  /** A list of listeners (StubDataObjects) that need to be updated when values change. */
  private listeners: Set<StubDataObject>;
  /** Add a listener to this BDO */
  addListener(listener: StubDataObject): void {
    this.listeners.add(listener);
  }
  /** Remove a listener from this BDO */
  removeListener(listener: StubDataObject): void {
    this.listeners.delete(listener);
  }

  constructor(
    typedKey: string,
    listeners: StubDataObject[],
    serverValues: Map<string, Value>
  ) {
    this.typedKey = typedKey;
    this.listeners = new Set(listeners);
    this.serverValues = serverValues;
  }

  /**
   * Updates the value for a named property from the server.
   * @param value The new value from the server.
   * @param key The key of the property to update.
   */
  updateFromServer(value: Value, key: string): void {
    this.serverValues.set(key, value);
    // update listeners
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
  /**
   * A map of ([query + variables] --> stubs returned from that query).
   * @public
   */
  resultTreeCache = new Map<string, StubResultTree>();

  /**
   * A map of ([entity typename + id] --> BackingDataObject for that entity).
   * @public
   */
  bdoCache = new Map<string, BackingDataObject>();

  /**
   * Creates a unique StrubResultTree cache key for a given query and its variables.
   * @param queryName The name of the query.
   * @param vars The variables used in the query.
   * @returns A unique cache key string.
   * @public
   */
  static makeResultTreeCacheKey(queryName: string, vars: unknown): string {
    return queryName + '|' + JSON.stringify(vars);
  }

  /**
   * Creates a unique BackingDataObject cache key for a given entity.
   * @param typename The typename of the entity being cached.
   * @param id The unique id / primary key of this entity.
   * @returns A unique cache key string.
   * @public
   */
  static makeBdoCacheKey(typename: string, id: unknown): string {
    return typename + '|' + JSON.stringify(id);
  }

  /**
   * Updates the cache with the results of a query.
   * @param queryResult The result of the query.
   * @public
   */
  updateCache<Data extends QueryResultData | QueryResultData[], Variables>(
    queryResult: QueryResult<Data, Variables>
  ): void {
    const resultTreeCacheKey = Cache.makeResultTreeCacheKey(
      queryResult.ref.name,
      queryResult.ref.variables
    );
    const stubResultTree: StubResultTree = {};
    // key = "movies" or "actor", etc.
    // eslint-disable-next-line guard-for-in
    for (const key in queryResult.data) {
      const queryData = queryResult.data[key];
      if (Array.isArray(queryData)) {
        const sdoList: StubDataObjectList = [];
        queryData.forEach(qd => {
          const sdo: StubDataObject = {
            ...qd
            // todo: add in non-cacheable fields
          };
          sdoList.push(sdo);
          const bdo: BackingDataObject = this.updateBdoCache(qd, sdo);
          stubResultTree[key] = sdoList;
        });
      } else {
        const sdo: StubDataObject = {
          ...(queryData as QueryResultData) // ! i don't think i should need a type assertion here, yet TS complains without it...
          // todo: add in non-cacheable fields
        };
        stubResultTree[key] = sdo;
        const bdo = this.updateBdoCache(queryData as QueryResultData, sdo); // ! i don't think i should need a type assertion here, yet TS complains without it...
      }
    }
    this.resultTreeCache.set(resultTreeCacheKey, stubResultTree);
  }

  /**
   * Update the BackingDataObject cache, either adding a new BDO or updating an existing BDO
   * @param data A single entity from the database.
   * @returns the BackingDataObject created/upated.
   */
  private updateBdoCache<Data extends QueryResultData>(
    data: Data,
    stubDataObject: StubDataObject
  ): BackingDataObject {
    const bdoCacheKey = Cache.makeBdoCacheKey(data['__typename'], data['__id']);
    let backingDataObject = this.bdoCache.get(bdoCacheKey);

    if (backingDataObject) {
      // BDO already exists, so update its values from the new data.
      for (const [key, value] of Object.entries(data)) {
        // key = "id" or "title", etc.
        backingDataObject.updateFromServer(value, key);
      }
      backingDataObject.addListener(stubDataObject);
    } else {
      // BDO does not exist, so create a new one.
      const serverValues = new Map<string, Value>(Object.entries(data));
      backingDataObject = new BackingDataObject(
        bdoCacheKey,
        [stubDataObject],
        serverValues
      );
      this.bdoCache.set(bdoCacheKey, backingDataObject);
    }
    return backingDataObject;
  }
}
