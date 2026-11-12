import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PayloadReader, isPlainObject, INVALID_PAYLOAD_MESSAGE } from '../../../src/core/validation/index.ts';
import { ValidationError } from '../../../src/core/errors/index.ts';

const rejects = (fn: () => unknown, field: string, reason: string): void => {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.message, INVALID_PAYLOAD_MESSAGE);
    assert.equal(err.details?.['field'], field);
    assert.equal(err.details?.['reason'], reason);
    assert.match(String(err.details?.['message']), new RegExp(`^"${field.replace(/[[\]]/g, '\\$&')}" `));
    return true;
  });
};

describe('isPlainObject', () => {
  test('accepts object literals and null-prototype objects', () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject(Object.create(null)), true);
  });
  test('rejects null, arrays, primitives, class instances', () => {
    for (const v of [null, undefined, [], 'x', 1, true, new Date(), new Map(), () => {}]) {
      assert.equal(isPlainObject(v), false, String(v));
    }
  });
});

describe('construction', () => {
  test('lenient constructor treats non-objects as empty', () => {
    for (const payload of [undefined, null, 'str', 42, [1, 2], () => {}]) {
      const r = new PayloadReader(payload);
      assert.equal(r.has('length'), false);
      assert.equal(r.optionalString('x'), undefined);
      rejects(() => r.requireString('x'), 'x', 'missing');
    }
  });
  test('strict() rejects non-objects', () => {
    for (const payload of [undefined, null, 'str', [], 3]) {
      assert.throws(() => PayloadReader.strict(payload), ValidationError);
    }
    assert.equal(PayloadReader.strict({ a: 'b' }).requireString('a'), 'b');
  });
  test('inherited keys never resolve', () => {
    const r = new PayloadReader({});
    assert.equal(r.has('toString'), false);
    assert.equal(r.has('__proto__'), false);
    rejects(() => r.requireString('constructor'), 'constructor', 'missing');
    const parsed = new PayloadReader(JSON.parse('{"__proto__":"own"}'));
    assert.equal(parsed.requireString('__proto__'), 'own');
  });
  test('has() is false for null and undefined values', () => {
    const r = new PayloadReader({ a: null, b: undefined, c: 0 });
    assert.equal(r.has('a'), false);
    assert.equal(r.has('b'), false);
    assert.equal(r.has('c'), true);
  });
});

describe('requireString / optionalString', () => {
  test('returns the value untrimmed by default', () => {
    assert.equal(new PayloadReader({ p: '  pw ' }).requireString('p'), '  pw ');
  });
  test('trims when asked', () => {
    assert.equal(new PayloadReader({ n: '  bob ' }).requireString('n', { trim: true }), 'bob');
  });
  test('missing, null and wrong types are rejected', () => {
    rejects(() => new PayloadReader({}).requireString('n'), 'n', 'missing');
    rejects(() => new PayloadReader({ n: null }).requireString('n'), 'n', 'missing');
    rejects(() => new PayloadReader({ n: 5 }).requireString('n'), 'n', 'type');
    rejects(() => new PayloadReader({ n: ['a'] }).requireString('n'), 'n', 'type');
    rejects(() => new PayloadReader({ n: 5 }).optionalString('n'), 'n', 'type');
  });
  test('empty strings: rejected when required, undefined when optional, allowed on request', () => {
    rejects(() => new PayloadReader({ n: '' }).requireString('n'), 'n', 'empty');
    rejects(() => new PayloadReader({ n: '   ' }).requireString('n', { trim: true }), 'n', 'empty');
    assert.equal(new PayloadReader({ n: '' }).optionalString('n'), undefined);
    assert.equal(new PayloadReader({ n: '  ' }).optionalString('n', { trim: true }), undefined);
    assert.equal(new PayloadReader({ n: '' }).requireString('n', { allowEmpty: true }), '');
    assert.equal(new PayloadReader({ n: '' }).optionalString('n', { allowEmpty: true }), '');
  });
  test('maxLength rejects or truncates, measured after trim', () => {
    rejects(() => new PayloadReader({ n: 'abcd' }).requireString('n', { maxLength: 3 }), 'n', 'too_long');
    assert.equal(new PayloadReader({ n: 'abc' }).requireString('n', { maxLength: 3 }), 'abc');
    assert.equal(new PayloadReader({ n: ' abc ' }).requireString('n', { maxLength: 3, trim: true }), 'abc');
    assert.equal(new PayloadReader({ n: 'abcdef' }).requireString('n', { maxLength: 3, truncate: true }), 'abc');
    assert.equal(new PayloadReader({ n: 'abcdef' }).optionalString('n', { maxLength: 2, truncate: true }), 'ab');
  });
  test('optionalString absent → undefined', () => {
    assert.equal(new PayloadReader({}).optionalString('n'), undefined);
    assert.equal(new PayloadReader({ n: null }).optionalString('n'), undefined);
  });
  test('client message is generic Hungarian; English field detail stays in details', () => {
    assert.throws(() => new PayloadReader({}).requireString('channelId'), (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.message, 'Érvénytelen adat.');
      assert.deepEqual(err.details, { field: 'channelId', reason: 'missing', message: '"channelId" is required.' });
      return true;
    });
  });
  test('strict() rejection also uses the generic message', () => {
    assert.throws(() => PayloadReader.strict(null), (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.message, 'Érvénytelen adat.');
      assert.deepEqual(err.details, { reason: 'not_object', message: 'Payload must be an object.' });
      return true;
    });
  });
  test('maxLength counts code points and truncation never splits an emoji', () => {
    const r = new PayloadReader({ e: 'ab😀c', two: '😀😀' });
    assert.equal(r.requireString('e', { maxLength: 3, truncate: true }), 'ab😀');
    assert.equal(r.requireString('e', { maxLength: 2, truncate: true }), 'ab');
    assert.equal(r.requireString('two', { maxLength: 2 }), '😀😀');
    rejects(() => r.requireString('two', { maxLength: 1 }), 'two', 'too_long');
    const cut = r.requireString('two', { maxLength: 1, truncate: true });
    assert.equal(cut, '😀');
    assert.equal(cut.length, 2);
  });
});

describe('requireInt / optionalInt', () => {
  test('accepts integers within bounds (inclusive)', () => {
    const r = new PayloadReader({ a: 0, b: -3, c: 10 });
    assert.equal(r.requireInt('a'), 0);
    assert.equal(r.requireInt('b', { min: -3 }), -3);
    assert.equal(r.requireInt('c', { min: 0, max: 10 }), 10);
  });
  test('rejects NaN, Infinity, fractions, numeric strings, booleans', () => {
    for (const v of [Number.NaN, Infinity, -Infinity, 1.5, '3', true, {}, 1e300, -1e300, Number.MAX_SAFE_INTEGER + 1]) {
      rejects(() => new PayloadReader({ v }).requireInt('v'), 'v', 'type');
    }
  });
  test('accepts the safe-integer extremes', () => {
    assert.equal(new PayloadReader({ v: Number.MAX_SAFE_INTEGER }).requireInt('v'), Number.MAX_SAFE_INTEGER);
    assert.equal(new PayloadReader({ v: Number.MIN_SAFE_INTEGER }).optionalInt('v'), Number.MIN_SAFE_INTEGER);
  });
  test('rejects out-of-range values', () => {
    rejects(() => new PayloadReader({ v: -1 }).requireInt('v', { min: 0 }), 'v', 'range');
    rejects(() => new PayloadReader({ v: 11 }).requireInt('v', { max: 10 }), 'v', 'range');
  });
  test('missing is rejected when required, undefined when optional', () => {
    rejects(() => new PayloadReader({}).requireInt('v'), 'v', 'missing');
    assert.equal(new PayloadReader({ v: null }).optionalInt('v'), undefined);
    assert.equal(new PayloadReader({ v: 7 }).optionalInt('v', { max: 7 }), 7);
    rejects(() => new PayloadReader({ v: 8 }).optionalInt('v', { max: 7 }), 'v', 'range');
  });
});

describe('optionalBoolean', () => {
  test('returns booleans, undefined or fallback when absent', () => {
    const r = new PayloadReader({ t: true, f: false, n: null });
    assert.equal(r.optionalBoolean('t'), true);
    assert.equal(r.optionalBoolean('f', true), false);
    assert.equal(r.optionalBoolean('n'), undefined);
    assert.equal(r.optionalBoolean('missing', false), false);
  });
  test('rejects truthy/falsy non-booleans', () => {
    for (const v of [1, 0, 'true', '', []]) {
      rejects(() => new PayloadReader({ v }).optionalBoolean('v'), 'v', 'type');
    }
  });
});

describe('requireEnum', () => {
  const COLORS = ['white', 'black'] as const;
  test('returns the matching literal', () => {
    const color: 'white' | 'black' = new PayloadReader({ c: 'black' }).requireEnum('c', COLORS);
    assert.equal(color, 'black');
    assert.equal(new PayloadReader({ n: 2 }).requireEnum('n', [1, 2, 3]), 2);
  });
  test('rejects unknown values, case differences and type coercion', () => {
    rejects(() => new PayloadReader({ c: 'red' }).requireEnum('c', COLORS), 'c', 'enum');
    rejects(() => new PayloadReader({ c: 'White' }).requireEnum('c', COLORS), 'c', 'enum');
    rejects(() => new PayloadReader({ n: '2' }).requireEnum('n', [1, 2]), 'n', 'enum');
    rejects(() => new PayloadReader({}).requireEnum('c', COLORS), 'c', 'missing');
  });
});

describe('optionalArray', () => {
  test('returns a copy of the array', () => {
    const source = [1, 'a'];
    const out = new PayloadReader({ a: source }).optionalArray('a');
    assert.deepEqual(out, [1, 'a']);
    assert.notEqual(out, source);
  });
  test('absent → undefined, non-array → rejected', () => {
    assert.equal(new PayloadReader({}).optionalArray('a'), undefined);
    assert.equal(new PayloadReader({ a: null }).optionalArray('a'), undefined);
    rejects(() => new PayloadReader({ a: 'abc' }).optionalArray('a'), 'a', 'type');
    rejects(() => new PayloadReader({ a: { 0: 'x', length: 1 } }).optionalArray('a'), 'a', 'type');
  });
  test('maxLength bounds the item count', () => {
    rejects(() => new PayloadReader({ a: [1, 2, 3] }).optionalArray('a', { maxLength: 2 }), 'a', 'too_long');
    assert.deepEqual(new PayloadReader({ a: [1, 2] }).optionalArray('a', { maxLength: 2 }), [1, 2]);
  });
  test('item parser maps and may reject items', () => {
    const toStr = (v: unknown, i: number): string => {
      if (typeof v !== 'string') throw new ValidationError(INVALID_PAYLOAD_MESSAGE, { field: `a[${i}]`, reason: 'type', message: `"a[${i}]" bad` });
      return v.toUpperCase();
    };
    assert.deepEqual(new PayloadReader({ a: ['x', 'y'] }).optionalArray('a', { item: toStr }), ['X', 'Y']);
    rejects(() => new PayloadReader({ a: ['x', 1] }).optionalArray('a', { item: toStr }), 'a[1]', 'type');
  });
});

describe('optionalObject', () => {
  test('returns a nested reader', () => {
    const nested = new PayloadReader({ o: { k: 'v' } }).optionalObject('o');
    assert.equal(nested?.requireString('k'), 'v');
  });
  test('absent → undefined, non-object → rejected', () => {
    assert.equal(new PayloadReader({}).optionalObject('o'), undefined);
    rejects(() => new PayloadReader({ o: [] }).optionalObject('o'), 'o', 'type');
    rejects(() => new PayloadReader({ o: 'x' }).optionalObject('o'), 'o', 'type');
  });
});
