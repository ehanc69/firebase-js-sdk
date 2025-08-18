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

import {
  Field,
  isNormalizeable,
  isScalar,
  isShallowSelectionSet as isSelectionSet,
  QueryData,
  SelectionSet,
  StubDataObject,
  StubDataObjectList
} from './util';

/** Interface for a stub result tree, with fields which are stub data objects. */
export interface StubResultTree {
  [alias: string]:
    | SelectionSet
    | SelectionSet[]
    | StubDataObject
    | StubDataObjectList;
}

/** A class used to hold an entity's normalized cached values across all queries. */
class BackingDataObject {
  /** Stable unique key identifying the entity across types. Format: TypeName|ID */
  readonly typedKey: string;

  /** Represents values received from the server. */
  private serverValues: Map<string, Field>;

  /** Values modified locally for latency compensation. */
  private localValues: Map<string, Field> = new Map();

  /**
   * A map of (BDO field name --> StubDataObjects that need to be updated when the
   * value of field changes).
   */
  readonly listeners: Map<string, Set<StubDataObject>>;

  constructor(typedKey: string, serverValues: Map<string, Field>) {
    this.typedKey = typedKey;
    this.serverValues = serverValues;
    this.listeners = new Map<string, Set<StubDataObject>>();
  }

  /**
   * Retrieves the value for a given key.
   * @param key The key of the value to retrieve.
   * @returns The value associated with the key, or undefined if not found.
   */
  protected value(key: string): Field | undefined {
    return this.serverValues.get(key);
  }

  /** Update a field's listeners to notify them of a new value. */
  private updateListeners(fieldName: string, value: Field): number {
    const sdos = this.listeners.get(fieldName);
    if (!sdos) {
      return 0;
    }
    for (const sdo of sdos) {
      sdo[fieldName] = value;
    }
    return sdos.size;
  }

  /**
   * Updates the value for a named property from the server and notifies all listeners which depend
   * on that value.
   * @param value The new value from the server.
   * @param key The key of the property to update.
   */
  updateFromServer(fieldName: string, value: Field): number {
    this.serverValues.set(fieldName, value);
    return this.updateListeners(fieldName, value);
  }

  /**
   * Updates the value for a named property locally.
   * @param value The new local value.
   * @param key The key of the property to update.
   */
  updateLocal(fieldName: string, value: Field): number {
    this.localValues.set(fieldName, value);
    return this.updateListeners(fieldName, value);
  }
}

/** A class representing the cache for query results and entity data. */
export class Cache {
  /** A map of (srtCacheKey --> StubResultTree returned from that query). */
  private srtCache = new Map<string, StubResultTree>();

  /**
   * Creates a unique StrubResultTree cache key for a given query and its variables.
   * @param queryName The name of the query.
   * @param vars The variables used in the query.
   * @returns A unique cache key string.
   */
  static srtCacheKey(queryName: string, vars: unknown): string {
    const sortedVars = Object.entries(vars).sort();
    return queryName + '|' + JSON.stringify(sortedVars);
  }

  /** A map of [entity typename + id] --> BackingDataObject for that entity. */
  private bdoCache = new Map<string, BackingDataObject>();

  /**
   * Creates a unique BackingDataObject cache key for a given entity.
   * @param typename The typename of the entity being cached.
   * @param id The unique id / primary key of this entity.
   * @returns A unique cache key string.
   */
  static bdoCacheKey(typename: string, id: unknown): string {
    return typename + '|' + JSON.stringify(id);
  }

  // TODO: implement normalization algorithm from scratch!!! use the first pass implementation as a reference/guide

  /**
   * Updates the cache with the results of a query. This is the main entry point.
   * @param queryResult The result of the query.
   */
  updateCache<Data extends QueryData, Variables>(
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
   * Creates a StubResultTree based on the data returned from a query
   * @param data the data property of the query result
   * @returns the StubResultTree
   */
  private createSrt(data: QueryData): StubResultTree {
    const srt: StubResultTree = {};
    for (const [alias, selectionSet] of Object.entries(data)) {
      if (Array.isArray(selectionSet)) {
        srt[alias] = selectionSet.map(this.normalizeSelectionSet);
      } else {
        srt[alias] = this.normalizeSelectionSet(selectionSet);
      }
    }
    return srt;
  }

  /**
   * Attempts to normalize the set by recursively traversing it's, fields, normalizing them along
   * the way.
   *
   * @param selectionSet The data to attempt to normalize.
   * @returns the top-level selection set (which may be an SDO if it was normalizeable).
   */
  private normalizeSelectionSet(
    selectionSet: SelectionSet
  ): SelectionSet | StubDataObject {
    const cachedSelectionSet: SelectionSet = {};

    // recursively traverse selection set, creating a new selection set which will be cached.
    for (const [field, value] of Object.entries(selectionSet)) {
      if (Array.isArray(value)) {
        const cachedField = value.map(this.cacheField);
        // type assertion because typescript thinks this could be a mixed array
        if (cachedField.every(isScalar) || cachedField.every(isSelectionSet)) {
          cachedSelectionSet[field] = cachedField;
        } else {
          // mixed array, should never happen
          // TODO: what do we do in this case?
          cachedSelectionSet[field] = value;
        }
      } else {
        cachedSelectionSet[field] = this.cacheField(value);
      }
    }

    // link the current SelectionSet to a BDO
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

  /**
   * Caches a single field's value. If the value is a selection set, it recursively normalizes it.
   * @param value The field value to cache.
   * @returns The cached field value, which might be a StubDataObject if it was a normalizeable selection set.
   */
  private cacheField(value: Field): Field {
    if (isSelectionSet(value)) {
      // recurse, and replace cacheable selection sets with SDOs
      return this.normalizeSelectionSet(value);
    }
    // return scalars
    return value;
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
    const serverValues = new Map<string, Field>();
    const newBdo = new BackingDataObject(bdoCacheKey, serverValues);
    for (const field of Object.keys(data)) {
      newBdo.listeners.set(field, new Set([stubDataObject]));
    }
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
    for (const [fieldName, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        if (value.every(isScalar)) {
          // every item is a scalar
          backingDataObject.updateFromServer(fieldName, value);
        } else if (!value.every(isNormalizeable)) {
          // every item is a selection set that's non-normalizeable
          // TODO: there might be normalizeable selection sets nested inside this one...
          backingDataObject.updateFromServer(fieldName, value);
        }
        // else, item is an SDO which has it's own BDO
      } else if (isScalar(value)) {
        backingDataObject.updateFromServer(fieldName, value);
      } else if (isSelectionSet(value)) {
        if (isNormalizeable(value)) {
        }
      }
      // add this SDO as a listener to each BDO field
      backingDataObject.listeners.get(fieldName).add(stubDataObject);
    }
  }
}
