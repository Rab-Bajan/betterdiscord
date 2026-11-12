import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemory } from './support.ts';

test('saveChannelMessage returns the same input object', (t) => {
  const { channelMessages } = openMemory(t);
  const msg = { id: 'm1', channelId: 'gaming', senderId: 's1', username: 'A', text: 'hi', timestamp: '10:00', createdAt: 1 };
  assert.equal(channelMessages.saveChannelMessage(msg), msg);
});

test('getChannelMessages maps rows and applies insert defaults', (t) => {
  t.mock.method(Date, 'now', () => 99);
  const { channelMessages } = openMemory(t);
  channelMessages.saveChannelMessage({ id: 'm1', channelId: 'c', username: 'A' });
  assert.deepEqual(channelMessages.getChannelMessages('c'), [
    {
      id: 'm1',
      channelId: 'c',
      senderId: null,
      username: 'A',
      avatarColor: '#7655F5',
      avatarUrl: null,
      text: '',
      attachments: [],
      timestamp: null,
      createdAt: 99
    }
  ]);
});

test('attachments round-trip through JSON; NULL attachments become []', (t) => {
  const { channelMessages, database } = openMemory(t);
  const attachments = [{ url: '/f.png', name: 'f.png', size: 3 }];
  channelMessages.saveChannelMessage({ id: 'm1', channelId: 'c', username: 'A', attachments, createdAt: 1 });
  database.connection.prepare("INSERT INTO channel_messages (id, channel_id, username, created_at) VALUES ('m2', 'c', 'B', 2)").run();
  const [first, second] = channelMessages.getChannelMessages('c');
  assert.deepEqual(first?.attachments, attachments);
  assert.deepEqual(second?.attachments, []);
  assert.equal(second?.text, null);
});

test('getChannelMessages: oldest first, only that channel, capped at the oldest 200', (t) => {
  const { channelMessages } = openMemory(t);
  for (let i = 250; i >= 1; i--) channelMessages.saveChannelMessage({ id: `m${i}`, channelId: 'c', username: 'A', createdAt: i });
  channelMessages.saveChannelMessage({ id: 'other', channelId: 'd', username: 'A', createdAt: 1 });
  const list = channelMessages.getChannelMessages('c');
  assert.equal(list.length, 200);
  assert.equal(list[0]?.id, 'm1');
  assert.equal(list[199]?.id, 'm200');
  assert.deepEqual(channelMessages.getChannelMessages('empty'), []);
});

test('loadAllChannelMessages keys results by channel id', (t) => {
  const { channelMessages } = openMemory(t);
  channelMessages.saveChannelMessage({ id: 'm1', channelId: 'a', username: 'A', createdAt: 1 });
  const all = channelMessages.loadAllChannelMessages(['a', 'b']);
  assert.deepEqual(Object.keys(all), ['a', 'b']);
  assert.equal(all['a']?.length, 1);
  assert.deepEqual(all['b'], []);
  assert.deepEqual(channelMessages.loadAllChannelMessages([]), {});
});

test('saveChannelMessage rejects duplicate ids', (t) => {
  const { channelMessages } = openMemory(t);
  channelMessages.saveChannelMessage({ id: 'm1', channelId: 'a', username: 'A' });
  assert.throws(() => channelMessages.saveChannelMessage({ id: 'm1', channelId: 'a', username: 'A' }), {
    code: 'SQLITE_CONSTRAINT_PRIMARYKEY'
  });
});
