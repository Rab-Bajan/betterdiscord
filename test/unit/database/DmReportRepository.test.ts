import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemory } from './support.ts';

const report = { id: 'r1', messageId: 'm1', dmKey: 'a|b', reporterUsername: 'alice', reason: 'spam' };

test('createDmReport stores an open report; getDmReport returns the raw row', (t) => {
  t.mock.method(Date, 'now', () => 1000);
  const { reports } = openMemory(t);
  assert.equal(reports.createDmReport(report), true);
  assert.deepEqual(reports.getDmReport('r1'), {
    id: 'r1',
    message_id: 'm1',
    dm_key: 'a|b',
    reporter_username: 'alice',
    reason: 'spam',
    status: 'open',
    created_at: 1000,
    resolved_by: null,
    resolved_at: null,
    resolution: null
  });
});

test('createDmReport: missing reason stored as empty string', (t) => {
  const { reports } = openMemory(t);
  reports.createDmReport({ ...report, reason: undefined });
  assert.equal(reports.getDmReport('r1')?.reason, '');
});

test('createDmReport returns false for the same reporter+message or a reused id', (t) => {
  const { reports } = openMemory(t);
  assert.equal(reports.createDmReport(report), true);
  assert.equal(reports.createDmReport({ ...report, id: 'r2' }), false);
  assert.equal(reports.createDmReport({ ...report, reporterUsername: 'bob' }), false);
  assert.equal(reports.createDmReport({ ...report, id: 'r3', reporterUsername: 'bob' }), true);
  assert.equal(reports.getDmReport('r2'), null);
});

test('getDmReport returns null for an unknown id', (t) => {
  const { reports } = openMemory(t);
  assert.equal(reports.getDmReport('none'), null);
});

test('listDmReports filters by status (default open), newest first, max 100', (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => ++now);
  const { reports } = openMemory(t);
  for (let i = 1; i <= 105; i++) reports.createDmReport({ ...report, id: `r${i}`, messageId: `m${i}` });
  reports.resolveDmReport('r105', 'admin', 'ok');

  const open = reports.listDmReports();
  assert.equal(open.length, 100);
  assert.equal(open[0]?.id, 'r104');
  assert.equal(open[99]?.id, 'r5');
  assert.deepEqual(reports.listDmReports('resolved').map((r) => r.id), ['r105']);
  assert.deepEqual(reports.listDmReports('weird'), []);
});

test('resolveDmReport resolves only open reports', (t) => {
  t.mock.method(Date, 'now', () => 77);
  const { reports } = openMemory(t);
  reports.createDmReport(report);
  assert.equal(reports.resolveDmReport('r1', 'bajan', undefined), true);
  const row = reports.getDmReport('r1');
  assert.equal(row?.status, 'resolved');
  assert.equal(row?.resolved_by, 'bajan');
  assert.equal(row?.resolved_at, 77);
  assert.equal(row?.resolution, '');
  assert.equal(reports.resolveDmReport('r1', 'bajan', 'again'), false);
  assert.equal(reports.getDmReport('r1')?.resolution, '');
  assert.equal(reports.resolveDmReport('missing', 'bajan', 'x'), false);
});
