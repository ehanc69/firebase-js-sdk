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

/** Internal utility type. Scalar is any FDC scalar value. */
type Scalar = undefined | null | boolean | number | string;

/**
 * Checks if the provided value is a valid SelectionSet.
 *
 * Note that this does not check the contents of fields in the selection set, so it's possible that
 * one of the fields, or a nested field, contains an invalid type (such as an array of mixed types).
 * @param value the value to check
 * @returns True if the value is a valid SelectionSet
 */
function isScalar(value: unknown): value is Scalar {
  if (Array.isArray(value)) {
    return false;
  }
  switch (typeof value) {
    case 'undefined':
    case 'boolean':
    case 'number':
    case 'string':
      return true;
    case 'object':
      // null has typeof === 'object' for historical reasons.
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/typeof#typeof_null
      return value === null;
    default:
      return false;
  }
}

/**
 * Internal utility type. Defines the shape of selection set for a table. It must have
 * __typename and __id for normalization.
 */
interface SelectionSet {
  [field: string]: Scalar | Scalar[] | SelectionSet | SelectionSet[];
}

/**
 * A type guard to check if a value is, at the top level, a valid SelectionSet (it is an object,
 * which is not an array, and which has at least one field).
 *
 * Note that this is only a "top-level" check - this does not check the selection set recursively,
 * or the contents of arrays in the selection set, so it's possible  that one of the fields, or a
 * nested field, contains a type which would make it an invalid FDC selection set (such as an array
 * of mixed types).
 * @param value the value to check
 * @returns True if the value is a valid SelectionSet at the top level of the object
 */
function isTopLevelSelectionSet(value: unknown): value is SelectionSet {
  // null has typeof === 'object' for historical reasons.
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/typeof#typeof_null
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length >= 1
  );
}

/**
 * Internal utility type. Defines the shape of query result data, made up of selection sets on tables.
 */
interface QueryResultData {
  [tableName: string]: SelectionSet | SelectionSet[];
}

/**
 * A type guard to check if a value is cacheable (it has the fields __typename and __id).
 * @param value The value to check.
 * @returns True if the value is cacheable (it has the fields __typename and __id).
 */
function isNormalizeable(
  value: SelectionSet | Scalar
): value is StubDataObject {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    '__typename' in value &&
    '__id' in value
  );
}

/**
 * Interface for a stub result tree, with fields which are stub data objects.
 * @public
 */
export interface StubResultTree {
  [key: string]: StubDataObject | StubDataObjectList;
}

/**
 * Interface for a stub data object, which acts as a snapshot view of cached data.
 * Selection sets in cached generated data types extend this interface.
 * @public
 */
export interface StubDataObject extends SelectionSet {
  [key: string]: Scalar | SelectionSet;
  __typename: string;
  __id: string;
}

/**
 * A custom class for holding lists of objects.
 * This is used to support operations like append, delete, and pagination.
 * @public
 */
class StubDataObjectList extends Array<StubDataObject> {}

/**
 * A class used to hold an entity's normalized cached values across all queries.
 * @public
 */
export class BackingDataObject {
  /**
   * Stable unique key identifying the entity across types.
   * Format: TypeName|ID
   */
  readonly typedKey: string;

  /** Represents values received from the server. */
  private serverValues: Map<string, Scalar>;

  /** A set of listeners (StubDataObjects) that need to be updated when values change. */
  readonly listeners: Set<StubDataObject>;

  constructor(typedKey: string, serverValues: Map<string, Scalar>) {
    this.typedKey = typedKey;
    this.listeners = new Set();
    this.serverValues = serverValues;
  }

  /**
   * Updates the value for a named property from the server and notifies all listeners which depend
   * on that value.
   * @param value The new value from the server.
   * @param key The key of the property to update.
   */
  updateFromServer(value: Scalar, key: string): void {
    this.serverValues.set(key, value);
    for (const listener of this.listeners) {
      if (key in listener) {
        listener[key] = value;
      }
    }
  }

  /**
   * Retrieves the value for a given key.
   * @param key The key of the value to retrieve.
   * @returns The value associated with the key, or undefined if not found.
   */
  protected value(key: string): Scalar | undefined {
    return this.serverValues.get(key);
  }

  /** Values modified locally for latency compensation. */
  private localValues: Map<string, Scalar> = new Map();

  /**
   * Updates the value for a named property locally.
   * @param value The new local value.
   * @param key The key of the property to update.
   */
  updateLocal(value: Scalar, key: string): void {
    this.localValues.set(key, value);
    for (const listener of this.listeners) {
      if (key in listener) {
        listener[key] = value;
      }
    }
  }
}

/**
 * A class representing the cache for query results and entity data.
 * @public
 */
export class Cache {
  /** A map of [query + variables] --> StubResultTree returned from that query. */
  srtCache = new Map<string, StubResultTree>();

  /**
   * Creates a unique StrubResultTree cache key for a given query and its variables.
   * @param queryName The name of the query.
   * @param vars The variables used in the query.
   * @returns A unique cache key string.
   */
  static srtCacheKey(queryName: string, vars: unknown): string {
    return queryName + '|' + JSON.stringify(vars);
  }

  /** A map of [entity typename + id] --> BackingDataObject for that entity. */
  bdoCache = new Map<string, BackingDataObject>();

  /**
   * Creates a unique BackingDataObject cache key for a given entity.
   * @param typename The typename of the entity being cached.
   * @param id The unique id / primary key of this entity.
   * @returns A unique cache key string.
   */
  static bdoCacheKey(typename: string, id: unknown): string {
    return typename + '|' + JSON.stringify(id);
  }

  /**
   * Updates the cache with the results of a query. This is the main entry point.
   * @param queryResult The result of the query.
   */
  updateCache<Data extends QueryResultData, Variables>(
    queryResult: QueryResult<Data, Variables>
  ): void {
    const resultTreeCacheKey = Cache.srtCacheKey(
      queryResult.ref.name,
      queryResult.ref.variables
    );
    const stubResultTree = this.createSrt(queryResult.data);
    this.srtCache.set(resultTreeCacheKey, stubResultTree);
  }

  /**
   * Caches the provided selection set. Attempts to normalize the set by recursively traversing it's,
   * fields, caching them along the way.
   *
   * @param selectionSet The data to ATTEMPT TO normalize.
   * @returns the top-level selection set (which may be an SDO if it was normalizeable).
   */
  private cacheSelectionSet(
    selectionSet: SelectionSet
  ): SelectionSet | StubDataObject {
    const cachedSelectionSet: SelectionSet = {};

    // recursively traverse selection set, creating a new selection set which will be cached.
    for (const [field, value] of Object.entries(selectionSet)) {
      if (Array.isArray(value)) {
        const cachedField = value.map(this.cacheField);
        // type assertion because typescript thinks this could be a mixed array
        if (
          cachedField.every(isScalar) ||
          cachedField.every(isTopLevelSelectionSet)
        ) {
          cachedSelectionSet[field] = cachedField;
        } else {
          // mixed array, should never happen
          cachedSelectionSet[field] = value;
        }
      } else {
        cachedSelectionSet[field] = this.cacheField(value);
      }
    }

    if (isNormalizeable(cachedSelectionSet)) {
      const bdoCacheKey = Cache.bdoCacheKey(
        cachedSelectionSet.__typename,
        cachedSelectionSet.__id
      );
      const existingBdo = this.bdoCache.get(bdoCacheKey);
      if (existingBdo) {
        this.updateBdo(existingBdo, selectionSet, cachedSelectionSet);
      } else {
        this.createBdo(bdoCacheKey, selectionSet, cachedSelectionSet);
      }
      return cachedSelectionSet;
    }

    return cachedSelectionSet;
  }

  private cacheField(value: Scalar | SelectionSet): Scalar | SelectionSet {
    if (isTopLevelSelectionSet(value)) {
      // recurse, and replace cacheable selection sets with SDOs
      return this.cacheSelectionSet(value);
    }
    // return scalars
    return value;
  }

  /**
   * Creates a StubResultTree based on the data returned from a query
   * @param data the data property of the query result
   * @returns
   */
  private createSrt(data: QueryResultData): StubResultTree {
    const srt: StubResultTree = {};
    for (const [tableName, selectionSet] of Object.entries(data)) {
      if (Array.isArray(selectionSet)) {
        srt[tableName] = selectionSet.map(this.cacheSelectionSet);
      } else {
        srt[tableName] = this.cacheSelectionSet(selectionSet);
      }
    }
    return srt;
  }

  /**
   * Creates a new BackingDataObject and adds it to the cache. This obejct
   * @param bdoCacheKey The cache key for the new BDO.
   * @param data The entity data from the server.
   * @param stubDataObject The first stub to listen to this BDO.
   */
  private createBdo(
    bdoCacheKey: string,
    data: SelectionSet,
    stubDataObject: StubDataObject
  ): void {
    const test = Object.entries(data);
    const serverValues = new Map<string, Scalar>();
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
    data: SelectionSet,
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
