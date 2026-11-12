import { ValidationError } from '../../core/errors/ValidationError.ts';
import { INVALID_PAYLOAD_MESSAGE } from '../../core/validation/PayloadReader.ts';
import { isPlainObject } from '../../core/validation/isPlainObject.ts';

/**
 * Field view of a payload the way a legacy handler's `({ a, b }) =>` parameter saw it:
 *
 * - `undefined` / `null` throw a ValidationError (destructuring them threw a TypeError in
 *   legacy, so the event did nothing; now it is rejected the same way, just logged at debug).
 * - Any other non-plain-object value (string, number, array, ...) reads as `{}` (destructuring
 *   a primitive yields `undefined` fields).
 * - Only own properties are visible, so prototype names never resolve to inherited values.
 *
 * Unlike PayloadReader, values are returned raw (`null` stays `null`), for the handlers that
 * relied on JavaScript coercion (`String(x)`, `typeof x === 'string'`, `x ?? null`, ...).
 */
export function legacyFields(payload: unknown): Readonly<Record<string, unknown>> {
  if (payload === undefined || payload === null) {
    throw new ValidationError(INVALID_PAYLOAD_MESSAGE, { reason: 'not_destructurable', message: 'Payload is missing.' });
  }
  if (!isPlainObject(payload)) return {};
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(payload)) fields[key] = payload[key];
  return fields;
}
