import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemory } from './support.ts';

const base = { id: 'a1', username: 'Alice', passwordHash: 'h', salt: 's' };

test('createAccount applies defaults and returns the stored account', (t) => {
  t.mock.method(Date, 'now', () => 1234);
  const { accounts } = openMemory(t);
  assert.deepEqual(accounts.createAccount(base), {
    id: 'a1',
    username: 'Alice',
    passwordHash: 'h',
    salt: 's',
    avatarColor: '#7655F5',
    avatarUrl: null,
    createdAt: 1234
  });
});

test('createAccount keeps explicit values; empty strings fall back to defaults', (t) => {
  const { accounts } = openMemory(t);
  assert.deepEqual(accounts.createAccount({ ...base, avatarColor: '#fff', avatarUrl: '/u.png', createdAt: 5 }), {
    ...{ id: 'a1', username: 'Alice', passwordHash: 'h', salt: 's' },
    avatarColor: '#fff',
    avatarUrl: '/u.png',
    createdAt: 5
  });
  const b = accounts.createAccount({ id: 'b', username: 'B', passwordHash: 'h', salt: 's', avatarColor: '', avatarUrl: '' });
  assert.equal(b?.avatarColor, '#7655F5');
  assert.equal(b?.avatarUrl, null);
});

test('createAccount rejects duplicate usernames case-insensitively', (t) => {
  const { accounts } = openMemory(t);
  accounts.createAccount(base);
  assert.throws(() => accounts.createAccount({ ...base, id: 'a2', username: 'ALICE' }), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
  assert.throws(() => accounts.createAccount({ ...base, username: 'other' }), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
});

test('getAccountById returns null for an unknown id', (t) => {
  const { accounts } = openMemory(t);
  assert.equal(accounts.getAccountById('nope'), null);
});

test('getAccountByUsername is case-insensitive and null for empty/unknown', (t) => {
  const { accounts } = openMemory(t);
  accounts.createAccount(base);
  assert.equal(accounts.getAccountByUsername('aLiCe')?.id, 'a1');
  assert.equal(accounts.getAccountByUsername('bob'), null);
  assert.equal(accounts.getAccountByUsername(''), null);
  assert.equal(accounts.getAccountByUsername(null), null);
  assert.equal(accounts.getAccountByUsername(undefined), null);
});

test('updateAccount overwrites username and avatar fields', (t) => {
  const { accounts } = openMemory(t);
  accounts.createAccount({ ...base, createdAt: 9 });
  assert.deepEqual(accounts.updateAccount('a1', { username: 'Alicia', avatarColor: '#000', avatarUrl: null }), {
    id: 'a1',
    username: 'Alicia',
    passwordHash: 'h',
    salt: 's',
    avatarColor: '#000',
    avatarUrl: null,
    createdAt: 9
  });
  assert.equal(accounts.getAccountByUsername('alice'), null);
});

test('updateAccount on an unknown id returns null', (t) => {
  const { accounts } = openMemory(t);
  assert.equal(accounts.updateAccount('ghost', { username: 'x', avatarColor: null, avatarUrl: null }), null);
});
