import { ValidationError } from '../errors/ValidationError.ts';
import { isPlainObject } from './isPlainObject.ts';

/** Client-facing message of every ValidationError raised by {@link PayloadReader}. */
export const INVALID_PAYLOAD_MESSAGE = 'Érvénytelen adat.';

/** Options for string fields. */
export interface StringOptions {
  /** Strip surrounding whitespace before length checks. Default `false` (passwords!). */
  trim?: boolean;
  /** Maximum length in code points, after trimming (an emoji counts as 1). */
  maxLength?: number;
  /** Cut to `maxLength` code points instead of rejecting (never splits a surrogate pair). Default `false`. */
  truncate?: boolean;
  /** Accept `''` (after trimming). Default `false`. */
  allowEmpty?: boolean;
}

/** Inclusive bounds for integer fields. */
export interface IntOptions {
  min?: number;
  max?: number;
}

/** Options for array fields. */
export interface ArrayOptions<T> {
  /** Maximum number of items. */
  maxLength?: number;
  /** Parses each item; throw a ValidationError to reject it. */
  item?: (value: unknown, index: number) => T;
}

/**
 * Reads fields out of an untrusted socket payload ("parse, don't validate").
 *
 * Every accessor either returns a correctly typed value or throws
 * {@link ValidationError}. Its message is the generic client-facing
 * {@link INVALID_PAYLOAD_MESSAGE}; the English field-level explanation is in
 * `details` (`{ field, reason, message }`) for logs only. Only own properties are read, so keys such as
 * `__proto__` or `toString` never resolve to inherited values.
 */
export class PayloadReader {
  readonly #data: Record<string, unknown>;

  /**
   * Lenient constructor mirroring legacy `({ ... } = {})`: anything that is not
   * a plain object (undefined, null, string, array, ...) reads as `{}`.
   */
  constructor(payload: unknown) {
    this.#data = isPlainObject(payload) ? payload : {};
  }

  /** Strict variant: the payload itself must be a plain object. */
  static strict(payload: unknown): PayloadReader {
    if (!isPlainObject(payload)) {
      throw new ValidationError(INVALID_PAYLOAD_MESSAGE, { reason: 'not_object', message: 'Payload must be an object.' });
    }
    return new PayloadReader(payload);
  }

  /** True when the key is present with a value other than `undefined`/`null`. */
  has(key: string): boolean {
    return this.#raw(key) !== undefined;
  }

  /** Required string field. */
  requireString(key: string, options: StringOptions = {}): string {
    const value = this.optionalString(key, { ...options, allowEmpty: true });
    if (value === undefined) throw this.#fail(key, 'missing', 'is required');
    if (value === '' && options.allowEmpty !== true) throw this.#fail(key, 'empty', 'must not be empty');
    return value;
  }

  /**
   * Optional string field: absent/null → `undefined`; empty (after trim) →
   * `undefined` unless `allowEmpty`; present with another type → throws.
   */
  optionalString(key: string, options: StringOptions = {}): string | undefined {
    const raw = this.#raw(key);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') throw this.#fail(key, 'type', 'must be a string');
    let value = options.trim === true ? raw.trim() : raw;
    if (value === '' && options.allowEmpty !== true) return undefined;
    const max = options.maxLength;
    const codePoints = max === undefined ? undefined : Array.from(value);
    if (max !== undefined && codePoints !== undefined && codePoints.length > max) {
      if (options.truncate !== true) throw this.#fail(key, 'too_long', `must be at most ${max} characters`);
      value = codePoints.slice(0, max).join('');
    }
    return value;
  }

  /** Required safe integer (no NaN, Infinity, fractions, numeric strings or values beyond ±2^53-1). */
  requireInt(key: string, options: IntOptions = {}): number {
    const value = this.optionalInt(key, options);
    if (value === undefined) throw this.#fail(key, 'missing', 'is required');
    return value;
  }

  /** Optional integer; absent/null → `undefined`. */
  optionalInt(key: string, options: IntOptions = {}): number | undefined {
    const raw = this.#raw(key);
    if (raw === undefined) return undefined;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) throw this.#fail(key, 'type', 'must be a safe integer');
    if (options.min !== undefined && raw < options.min) throw this.#fail(key, 'range', `must be >= ${options.min}`);
    if (options.max !== undefined && raw > options.max) throw this.#fail(key, 'range', `must be <= ${options.max}`);
    return raw;
  }

  /** Optional boolean; absent/null → `fallback`. Truthy non-booleans are rejected. */
  optionalBoolean(key: string): boolean | undefined;
  optionalBoolean(key: string, fallback: boolean): boolean;
  optionalBoolean(key: string, fallback?: boolean): boolean | undefined {
    const raw = this.#raw(key);
    if (raw === undefined) return fallback;
    if (typeof raw !== 'boolean') throw this.#fail(key, 'type', 'must be a boolean');
    return raw;
  }

  /** Required field that must strictly equal one of `values`. */
  requireEnum<const T extends string | number>(key: string, values: readonly T[]): T {
    const raw = this.#raw(key);
    if (raw === undefined) throw this.#fail(key, 'missing', 'is required');
    const match = values.find((candidate) => candidate === raw);
    if (match === undefined) throw this.#fail(key, 'enum', `must be one of: ${values.join(', ')}`);
    return match;
  }

  /** Optional array; absent/null → `undefined`. Items are parsed by `options.item` when given. */
  optionalArray(key: string, options?: { maxLength?: number }): unknown[] | undefined;
  optionalArray<T>(key: string, options: ArrayOptions<T> & { item: (value: unknown, index: number) => T }): T[] | undefined;
  optionalArray<T>(key: string, options: ArrayOptions<T> = {}): unknown[] | undefined {
    const raw = this.#raw(key);
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) throw this.#fail(key, 'type', 'must be an array');
    const max = options.maxLength;
    if (max !== undefined && raw.length > max) throw this.#fail(key, 'too_long', `must have at most ${max} items`);
    const parse = options.item;
    return parse ? raw.map((item: unknown, index) => parse(item, index)) : [...raw];
  }

  /** Nested object field as its own reader; absent/null → `undefined`. */
  optionalObject(key: string): PayloadReader | undefined {
    const raw = this.#raw(key);
    if (raw === undefined) return undefined;
    if (!isPlainObject(raw)) throw this.#fail(key, 'type', 'must be an object');
    return new PayloadReader(raw);
  }

  #raw(key: string): unknown {
    if (!Object.hasOwn(this.#data, key)) return undefined;
    const value = this.#data[key];
    return value === null ? undefined : value;
  }

  #fail(field: string, reason: string, text: string): ValidationError {
    return new ValidationError(INVALID_PAYLOAD_MESSAGE, { field, reason, message: `"${field}" ${text}.` });
  }
}
