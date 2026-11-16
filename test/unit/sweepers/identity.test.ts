import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifiedAccountId } from '../../../src/modules/sweepers/SweepersController.ts';

test('the accountId counts only for an authenticated session', () => {
  assert.equal(verifiedAccountId({ accountId: 'acc-1', authenticated: true }), 'acc-1');
  assert.equal(verifiedAccountId({ accountId: 'acc-1', authenticated: false }), null);
  assert.equal(verifiedAccountId({ accountId: 'acc-1' }), null);
  assert.equal(verifiedAccountId({ accountId: null, authenticated: true }), null);
});
