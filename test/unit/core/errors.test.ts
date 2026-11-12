import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, ValidationError, NotFoundError, ForbiddenError } from '../../../src/core/errors/index.ts';

test('AppError carries code, message, details and its class name', () => {
  const err = new AppError('CUSTOM', 'boom', { a: 1 });
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'CUSTOM');
  assert.equal(err.message, 'boom');
  assert.deepEqual(err.details, { a: 1 });
  assert.equal(err.name, 'AppError');
  assert.ok(err.stack?.includes('boom'));
});

test('details and clientFields default to undefined', () => {
  const err = new AppError('X', 'y');
  assert.equal(err.details, undefined);
  assert.equal(err.clientFields, undefined);
});

test('clientFields are kept separately from details', () => {
  const err = new ForbiddenError('Ehhez be kell jelentkezned.', { accountId: null }, { needsLogin: true });
  assert.deepEqual(err.details, { accountId: null });
  assert.deepEqual(err.clientFields, { needsLogin: true });
  assert.deepEqual(new AppError('X', 'y', undefined, { a: 1 }).clientFields, { a: 1 });
});

for (const [Ctor, code, name] of [
  [ValidationError, 'VALIDATION_ERROR', 'ValidationError'],
  [NotFoundError, 'NOT_FOUND', 'NotFoundError'],
  [ForbiddenError, 'FORBIDDEN', 'ForbiddenError']
] as const) {
  test(`${name} is an AppError with code ${code}`, () => {
    const err = new Ctor('msg', { field: 'f' });
    assert.ok(err instanceof Error);
    assert.ok(err instanceof AppError);
    assert.ok(err instanceof Ctor);
    assert.equal(err.code, code);
    assert.equal(Ctor.CODE, code);
    assert.equal(err.name, name);
    assert.equal(err.message, 'msg');
    assert.deepEqual(err.details, { field: 'f' });
  });
}

test('subclasses are not instances of each other', () => {
  assert.ok(!(new ValidationError('x') instanceof NotFoundError));
  assert.ok(!(new ForbiddenError('x') instanceof ValidationError));
});
