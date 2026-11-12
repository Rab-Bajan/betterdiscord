import { isPlainObject } from '../../core/validation/isPlainObject.ts';

/**
 * Field view of a payload the way a legacy handler's `({ a, b } = {}) =>`
 * parameter saw it (the `= {}`-defaulted form; see legacyPayload.ts for the
 * form without a default):
 *
 * - `undefined` reads as `{}` (the default applied);
 * - `null` gives `null`: destructuring it threw a TypeError in legacy, so the
 *   handler did nothing. Callers return early on `null`. No error is thrown,
 *   so no failure ack is sent either, exactly as before.
 * - any other non-plain-object value (string, number, array...) reads as `{}`;
 * - only own properties are visible.
 */
export function legacyDefaultedFields(payload: unknown): Readonly<Record<string, unknown>> | null {
  if (payload === null) return null;
  if (!isPlainObject(payload)) return {};
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(payload)) fields[key] = payload[key];
  return fields;
}
