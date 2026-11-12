import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { openMemory } from './support.ts';

function setup(t: TestContext) {
  const repos = openMemory(t);
  repos.accounts.createAccount({ id: 'a1', username: 'Alice', passwordHash: 'h', salt: 's', createdAt: 7 });
  repos.accounts.createAccount({ id: 'a2', username: 'Bob', passwordHash: 'h', salt: 's', createdAt: 8 });
  return repos;
}

test('getAccountByToken returns the account without credentials', (t) => {
  const { tokens } = setup(t);
  tokens.saveAuthToken('tok', 'a1');
  assert.deepEqual(tokens.getAccountByToken('tok'), {
    id: 'a1',
    username: 'Alice',
    avatarColor: '#7655F5',
    avatarUrl: null,
    createdAt: 7
  });
});

test('getAccountByToken: null for empty, unknown, or orphaned tokens', (t) => {
  const { tokens } = setup(t);
  tokens.saveAuthToken('orphan', 'no-such-account');
  assert.equal(tokens.getAccountByToken(''), null);
  assert.equal(tokens.getAccountByToken(null), null);
  assert.equal(tokens.getAccountByToken('unknown'), null);
  assert.equal(tokens.getAccountByToken('orphan'), null);
});

test('saveAuthToken stores Date.now() and rejects duplicate tokens', (t) => {
  t.mock.method(Date, 'now', () => 42);
  const { tokens, database } = setup(t);
  tokens.saveAuthToken('tok', 'a1');
  assert.deepEqual(database.connection.prepare('SELECT * FROM auth_tokens').all(), [
    { token: 'tok', account_id: 'a1', created_at: 42 }
  ]);
  assert.throws(() => tokens.saveAuthToken('tok', 'a2'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
});

test('deleteAuthToken removes only that token; empty is a no-op', (t) => {
  const { tokens } = setup(t);
  tokens.saveAuthToken('t1', 'a1');
  tokens.saveAuthToken('t2', 'a1');
  assert.equal(tokens.deleteAuthToken(''), undefined);
  tokens.deleteAuthToken(null);
  tokens.deleteAuthToken('t1');
  assert.equal(tokens.getAccountByToken('t1'), null);
  assert.equal(tokens.getAccountByToken('t2')?.id, 'a1');
});

test('deleteAccountTokens removes every token of one account only', (t) => {
  const { tokens } = setup(t);
  tokens.saveAuthToken('t1', 'a1');
  tokens.saveAuthToken('t2', 'a1');
  tokens.saveAuthToken('t3', 'a2');
  tokens.deleteAccountTokens('');
  tokens.deleteAccountTokens(undefined);
  assert.equal(tokens.getAccountByToken('t1')?.id, 'a1');
  tokens.deleteAccountTokens('a1');
  assert.equal(tokens.getAccountByToken('t1'), null);
  assert.equal(tokens.getAccountByToken('t2'), null);
  assert.equal(tokens.getAccountByToken('t3')?.id, 'a2');
});
