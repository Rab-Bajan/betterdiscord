import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NewDirectMessage } from '../../../src/infrastructure/database/index.ts';
import { openMemory } from './support.ts';

function dm(id: string, createdAt: number, extra: Partial<NewDirectMessage> = {}): NewDirectMessage {
  return {
    id,
    dmKey: 'alice|bob',
    senderId: 'sock-a',
    senderAccountId: 'acc-a',
    senderUsername: 'Alice',
    recipientId: 'sock-b',
    recipientUsername: 'Bob',
    text: `msg ${id}`,
    timestamp: `t${createdAt}`,
    createdAt,
    ...extra
  };
}

test('saveDmMessage echo is built from the input (legacy quirk)', (t) => {
  const { directMessages } = openMemory(t);
  const saved = directMessages.saveDmMessage(dm('m1', 0, { createdAt: undefined, text: undefined, attachments: [{ a: 1 }] }));
  assert.deepEqual(saved, {
    id: 'm1',
    dmKey: 'alice|bob',
    username: 'Alice',
    senderId: undefined,
    senderAccountId: undefined,
    senderUsername: 'Alice',
    senderAvatarColor: undefined,
    senderAvatarUrl: undefined,
    recipientId: undefined,
    recipientUsername: 'Bob',
    recipientAvatarColor: undefined,
    recipientAvatarUrl: undefined,
    avatarColor: undefined,
    avatarUrl: undefined,
    text: undefined,
    attachments: [{ a: 1 }],
    timestamp: 't0',
    createdAt: undefined,
    removedByAdmin: false,
    callEvent: null,
    isPrivate: true
  });
});

test('saveDmMessage stores defaults; getDmMessageById reads the stored row', (t) => {
  t.mock.method(Date, 'now', () => 500);
  const { directMessages } = openMemory(t);
  directMessages.saveDmMessage({ id: 'm1', dmKey: 'k', senderUsername: 'Alice', recipientUsername: 'Bob' });
  assert.deepEqual(directMessages.getDmMessageById('m1'), {
    id: 'm1',
    dmKey: 'k',
    username: 'Alice',
    senderId: null,
    senderAccountId: null,
    senderUsername: 'Alice',
    senderAvatarColor: '#7655F5',
    senderAvatarUrl: null,
    recipientId: null,
    recipientUsername: 'Bob',
    recipientAvatarColor: '#7655F5',
    recipientAvatarUrl: null,
    avatarColor: '#7655F5',
    avatarUrl: null,
    text: '',
    attachments: [],
    timestamp: null,
    createdAt: 500,
    removedByAdmin: false,
    callEvent: null,
    isPrivate: true
  });
});

test('call events round-trip as JSON in both echo and stored row', (t) => {
  const { directMessages } = openMemory(t);
  const callEvent = { callId: 'c1', status: 'missed', durationSec: 0, callerUsername: 'Alice' };
  assert.deepEqual(directMessages.saveDmMessage(dm('m1', 1, { callEvent })).callEvent, callEvent);
  assert.deepEqual(directMessages.getDmMessageById('m1')?.callEvent, callEvent);
});

test('getDmMessageById returns null for an unknown id', (t) => {
  const { directMessages } = openMemory(t);
  assert.equal(directMessages.getDmMessageById('none'), null);
});

test('removeDmMessage blanks content and flags the row', (t) => {
  const { directMessages } = openMemory(t);
  directMessages.saveDmMessage(dm('m1', 1, { attachments: [{ x: 1 }] }));
  assert.equal(directMessages.removeDmMessage('m1'), true);
  const row = directMessages.getDmMessageById('m1');
  assert.equal(row?.text, '');
  assert.deepEqual(row?.attachments, []);
  assert.equal(row?.removedByAdmin, true);
  assert.equal(directMessages.removeDmMessage('missing'), false);
});

test('getDmMessages: one conversation, oldest first, capped at the oldest 250', (t) => {
  const { directMessages } = openMemory(t);
  for (let i = 260; i >= 1; i--) directMessages.saveDmMessage(dm(`m${i}`, i));
  directMessages.saveDmMessage(dm('x', 1, { dmKey: 'other' }));
  const list = directMessages.getDmMessages('alice|bob');
  assert.equal(list.length, 250);
  assert.equal(list[0]?.id, 'm1');
  assert.equal(list[249]?.id, 'm250');
  assert.deepEqual(directMessages.getDmMessages('nobody'), []);
});

test('getDmContext: before+1 at-or-before, after strictly after, oldest first', (t) => {
  const { directMessages } = openMemory(t);
  for (let i = 1; i <= 30; i++) directMessages.saveDmMessage(dm(`m${i}`, i * 10));
  directMessages.saveDmMessage(dm('other', 150, { dmKey: 'other' }));

  const ids = (list: { id: string }[]) => list.map((m) => m.id);
  const defaults = directMessages.getDmContext('alice|bob', 150);
  assert.deepEqual(ids(defaults), Array.from({ length: 21 }, (_, i) => `m${i + 5}`));

  assert.deepEqual(ids(directMessages.getDmContext('alice|bob', 150, 2, 3)), ['m13', 'm14', 'm15', 'm16', 'm17', 'm18']);
  assert.deepEqual(ids(directMessages.getDmContext('alice|bob', 150, 0, 0)), ['m15']);
  assert.deepEqual(ids(directMessages.getDmContext('alice|bob', 25, 5, 1)), ['m1', 'm2', 'm3']);
  assert.deepEqual(ids(directMessages.getDmContext('alice|bob', 295, 1, 5)), ['m28', 'm29', 'm30']);
  assert.deepEqual(directMessages.getDmContext('nobody', 150), []);
});

test('getUserDmConversations: case-insensitive, newest first, one entry per partner', (t) => {
  const { directMessages } = openMemory(t);
  directMessages.saveDmMessage(dm('m1', 1, { dmKey: 'a|b', text: 'old to bob' }));
  directMessages.saveDmMessage(
    dm('m2', 2, {
      dmKey: 'a|c',
      senderUsername: 'Carol',
      senderId: 'sock-c',
      senderAvatarColor: '#c0c',
      senderAvatarUrl: '/c.png',
      recipientUsername: 'alice',
      text: 'hey'
    })
  );
  directMessages.saveDmMessage(dm('m3', 3, { dmKey: 'a|b', recipientUsername: 'BOB', text: '', callEvent: { callId: 'x' } }));
  directMessages.saveDmMessage(dm('m4', 4, { dmKey: 'a|d', recipientUsername: 'Dave', recipientId: null, text: '' }));
  directMessages.saveDmMessage(dm('m5', 5, { dmKey: 'x|y', senderUsername: 'X', recipientUsername: 'Y' }));

  assert.deepEqual(directMessages.getUserDmConversations('ALICE'), [
    { id: 'Dave', username: 'Dave', avatarColor: '#7655F5', avatarUrl: null, lastMessage: 'Fájl csatolmány', lastTimestamp: 't4' },
    { id: 'sock-b', username: 'BOB', avatarColor: '#7655F5', avatarUrl: null, lastMessage: 'Hanghívás', lastTimestamp: 't3' },
    { id: 'sock-c', username: 'Carol', avatarColor: '#c0c', avatarUrl: '/c.png', lastMessage: 'hey', lastTimestamp: 't2' }
  ]);
  assert.deepEqual(directMessages.getUserDmConversations(''), []);
  assert.deepEqual(directMessages.getUserDmConversations(null), []);
  assert.deepEqual(directMessages.getUserDmConversations('nobody'), []);
});

test('saveDmMessage rejects duplicate ids', (t) => {
  const { directMessages } = openMemory(t);
  directMessages.saveDmMessage(dm('m1', 1));
  assert.throws(() => directMessages.saveDmMessage(dm('m1', 2)), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
});

test('getDmContext with a NULL createdAt matches nothing (legacy SQL semantics)', (t) => {
  const { directMessages } = openMemory(t);
  directMessages.saveDmMessage(dm('m1', 10));
  assert.deepEqual(directMessages.getDmContext('alice|bob', null), []);
});
