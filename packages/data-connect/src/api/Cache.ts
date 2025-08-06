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

type Value = string | number | boolean | null | undefined | object | Value[]; // Value is any FDC scalar value // ! this is just for debugging/testing!!! 

/**
 * map of [query + variables] --> stubs returned from that query
 */
const stubCache = new Map<string, StubDataObject>();

/**
 * map of [entity primary key] --> data for that entity
 */
const bdoCache = new Map<string, BackingDataObject>();

// operation stub result tree
export interface StubResultTree {
  [key: string]: StubDataObject | StubDataObjectList;
}

// StubDataObject contains a reference to its BackingDataObject
// Generated Data implements this interface
export interface StubDataObject {
  readonly typedKey: string;
  [key: string]: Value | StubDataObject;
}

// Custom class for holding lists of objects.
// We will need this for supporting operations like append, delete, paginate
// not strictly necessary for caching but might be good to get it ready.
class StubDataObjectList extends Array<StubDataObject> {}

// Class used to hold entity values across all queries
// public because its referenced from Gen SDK
export class BackingDataObject {
  // Stable unique key identifying the entity across types.
  // TypeName + CompositePrimaryKey
  private typedKey: string;

  // Represent values received from server
  private serverValues: Map<string, Value> = new Map(); // Value is any FDC scalar value

  private listeners: StubDataObject[] = [];

  // Updates value for named property
  updateFromServer(value: Value, key: string): void {
    this.serverValues.set(key, value);
    // update listeners
    for (const listener of this.listeners) {
      listener[key] = value;
    }
  }

  protected value(key: string): Value | undefined {
    return this.serverValues.get(key);

    // FUTURE - for latency comp
    // return this.localValues.get(key) ?? this.serverValues.get(key)
  }

  // ----- FUTURE - for latency comp

  // Values modified locally
  private localValues: Map<string, Value> = new Map(); // Value is any FDC scalar value

  updateLocal(value: Value, key: string): void {
    this.localValues.set(key, value);
    // notify listeners
  }
}
