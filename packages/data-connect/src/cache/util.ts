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

/** Scalar is any FDC scalar value. */
export type Scalar = undefined | null | boolean | number | string;

/**
 * Checks if the provided value is a valid SelectionSet.
 *
 * Note that this does not check the contents of fields in the selection set, so it's possible that
 * one of the fields, or a nested field, contains an invalid type (such as an array of mixed types).
 * @param value the value to check
 * @returns True if the value is a valid SelectionSet
 */
export function isScalar(value: unknown): value is Scalar {
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
 * Defines the shape of a entity's fields / field of a selection set.
 */
export type Field = Scalar | Scalar[] | SelectionSet | SelectionSet[];

/**
 * Defines the shape of selection set for a table. If it's normalizeable, it's considered
 * a StubDataObject.
 */
export interface SelectionSet {
  [fieldName: string]: Field;
}

/**
 * A type guard to check if a value is, at the top level, a valid SelectionSet (it is not an object,
 * which is not an array, and which has at least one field).
 *
 * Note that this is only a "shallow" check - this does not check the selection set recursively,
 * or the contents of arrays in the selection set - so it's possible  that one of the fields, or a
 * nested field, contains a type which would make it an invalid FDC selection set (such as an array
 * of mixed types).
 * @param value the value to check
 * @returns True if the value is a SelectionSet
 */
export function isShallowSelectionSet(value: unknown): value is SelectionSet {
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
 * Defines the shape of data returned from queries, made up of at least one selection set
 * on at least one table.
 */
export interface QueryData {
  [tableName: string]: SelectionSet | SelectionSet[];
}

/**
 * A type guard to check if a value is cacheable (it has the fields __typename and __id).
 * @param value The value to check.
 * @returns True if the value is cacheable (it has the fields __typename and __id).
 */
export function isNormalizeable(
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
 * Interface for a stub data object, which acts as a snapshot view of cached data.
 * Normalizeable selection sets in cached generated data types extend this interface.
 * @public
 */
export interface StubDataObject extends SelectionSet {
  __typename: string;
  __id: string;
}

/**
 * A custom class for holding lists of objects.
 * This is used to support operations like append, delete, and pagination.
 * @public
 */
export class StubDataObjectList extends Array<StubDataObject> {}
