import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserService, DEFAULT_URL, IDLE_TIMEOUT_MS, type IdleScheduler } from '../../../src/modules/browser/BrowserService.ts';
import { findChromeExecutable } from '../../../src/modules/browser/chromePath.ts';
import { isPrivateIp, validateAndSanitizeUrl } from '../../../src/modules/browser/urlSecurity.ts';
import type { BrowserLauncher, InputParams, PageEvents, PublicBrowserState, RemotePage } from '../../../src/modules/browser/types.ts';
import { captureLogger, flush } from '../socket/fakes.ts';

class FakePage implements RemotePage {
  readonly calls: Array<[string, unknown]> = [];
  current = 'about:blank';
  async goto(url: string): Promise<void> { this.calls.push(['goto', url]); this.current = url; }
  async goBack(): Promise<void> { this.calls.push(['back', null]); }
  async goForward(): Promise<void> { this.calls.push(['forward', null]); }
  async reload(): Promise<void> { this.calls.push(['reload', null]); }
  url(): string { return this.current; }
  async title(): Promise<string> { return `Title of ${this.current}`; }
  async dispatchMouseEvent(params: InputParams): Promise<void> { this.calls.push(['mouse', params]); }
  async dispatchKeyEvent(params: InputParams): Promise<void> { this.calls.push(['key', params]); }
  async insertText(text: string): Promise<void> { this.calls.push(['text', text]); }
  async close(): Promise<void> { this.calls.push(['close', null]); }
}

class FakeLauncher implements BrowserLauncher {
  readonly page = new FakePage();
  launches = 0;
  events: PageEvents | undefined;
  async launch(_path: string, events: PageEvents): Promise<RemotePage> {
    this.launches += 1;
    this.events = events;
    return this.page;
  }
}

class ManualScheduler implements IdleScheduler {
  readonly pending = new Map<number, () => void>();
  #id = 0;
  set(cb: () => void): unknown { this.pending.set(++this.#id, cb); return this.#id; }
  clear(handle: unknown): void { this.pending.delete(handle as number); }
  fireAll(): void { for (const [id, cb] of [...this.pending]) { this.pending.delete(id); cb(); } }
}

const ann = { id: 's1', username: 'Ann', color: '#111' };
const bob = { id: 's2', username: 'Bob', color: '#222' };

const setup = (chromePath: string | null = '/chrome') => {
  const launcher = new FakeLauncher();
  const scheduler = new ManualScheduler();
  const states: Array<[string, PublicBrowserState | null]> = [];
  const frames: string[] = [];
  const { logger, logs } = captureLogger();
  const browser = new BrowserService({
    chromePath, launcher, scheduler, logger, now: () => 7,
    validateUrl: (raw) => validateAndSanitizeUrl(raw, async () => ({ address: '93.184.216.34' })),
    broadcaster: { state: (id, s) => { states.push([id, s]); }, frame: (id) => { frames.push(id); } }
  });
  return { browser, launcher, scheduler, states, frames, logs };
};

test('isPrivateIp covers loopback, private ranges, link-local, IPv6 local and multicast', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:10.0.0.1', 'fd00::1', '', null]) {
    assert.equal(isPrivateIp(ip), true, String(ip));
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1']) assert.equal(isPrivateIp(ip), false, ip);
});

test('validateAndSanitizeUrl: scheme, internal names, private IPs and DNS rebinding', async () => {
  const publicDns = async (): Promise<{ address: string }> => ({ address: '93.184.216.34' });
  assert.deepEqual(await validateAndSanitizeUrl('example.com', publicDns), { valid: true, url: 'https://example.com/' });
  assert.deepEqual(await validateAndSanitizeUrl('about:blank', publicDns), { valid: true, url: 'about:blank' });
  assert.equal((await validateAndSanitizeUrl(42, publicDns)).valid, false);
  assert.deepEqual(await validateAndSanitizeUrl('  ', publicDns), { valid: false, reason: 'Üres URL' });
  // As in legacy, a non-http scheme just gets `https://` prepended.
  assert.deepEqual(await validateAndSanitizeUrl('ftp://x.org', publicDns), { valid: true, url: 'https://ftp//x.org' });
  assert.deepEqual(await validateAndSanitizeUrl('javascript:alert(1)', publicDns), { valid: false, reason: 'Érvénytelen URL formátum' });
  assert.match((await validateAndSanitizeUrl('http://printer.local', publicDns) as { reason: string }).reason, /Belső hálózati/);
  assert.match((await validateAndSanitizeUrl('http://192.168.0.1', publicDns) as { reason: string }).reason, /Privát/);
  assert.match((await validateAndSanitizeUrl('evil.test', async () => ({ address: '127.0.0.1' })) as { reason: string }).reason, /belső privát/);
  assert.equal((await validateAndSanitizeUrl('nx.test', async () => { throw new Error('ENOTFOUND'); })).valid, true);
});

test('findChromeExecutable: configured path first, then known locations, else null', () => {
  assert.equal(findChromeExecutable('/opt/chrome', {}, (f) => f === '/opt/chrome'), '/opt/chrome');
  assert.equal(findChromeExecutable('/missing', {}, (f) => f === '/usr/bin/chromium'), '/usr/bin/chromium');
  assert.equal(findChromeExecutable(null, {}, () => false), null);
});

test('start without Chrome or with a refused URL fails without launching', async () => {
  const none = setup(null);
  await assert.rejects(none.browser.start('r', ann, undefined), /nem található futtatható Google Chrome/);
  const bad = setup();
  await assert.rejects(bad.browser.start('r', ann, 'http://10.0.0.1'), /Privát/);
  assert.equal(bad.launcher.launches, 0);
});

test('start launches once per channel, loads the start page and adds the viewer', async () => {
  const { browser, launcher, states } = setup();
  await Promise.all([browser.start('r', ann, undefined), browser.start('r', bob, undefined)]);
  assert.equal(launcher.launches, 1);
  assert.deepEqual(launcher.page.calls[0], ['goto', `${DEFAULT_URL}/`]);
  const state = browser.publicState('r');
  assert.equal(state?.startedBy, 'Ann');
  assert.deepEqual(state?.viewers.map((v) => v.id), ['s1', 's2']);
  assert.equal(state?.title, 'Böngésző betöltése...');
  assert.ok(states.every(([id]) => id === 'r'));
});

test('page events update the session: frames, navigation title, load', async () => {
  const { browser, launcher, frames } = setup();
  await browser.start('r', ann, 'example.com');
  launcher.events?.frame({ data: 'jpeg', metadata: {} });
  assert.deepEqual(frames, ['r']);
  assert.equal(browser.get('r')?.lastFrame?.timestamp, 7);
  launcher.page.current = 'https://example.org/';
  launcher.events?.loaded();
  await flush();
  assert.deepEqual([browser.publicState('r')?.isLoading, browser.publicState('r')?.title], [false, 'Title of https://example.org/']);
});

test('control modes decide who may steer', async () => {
  const { browser } = setup();
  await browser.start('r', ann, undefined);
  const session = browser.get('r');
  assert.ok(session);
  assert.equal(browser.canInteract(session, 's2'), true);
  browser.setMode(session, 'controller', bob);
  assert.equal(session.controller?.id, 's2');
  assert.equal(browser.canInteract(session, 's1'), false);
  browser.releaseControl(session, 's1');
  assert.equal(session.controller?.id, 's2');
  browser.takeControl(session, ann);
  assert.equal(browser.canInteract(session, 's1'), true);
  browser.disconnect('s1');
  assert.equal(session.controller, null);
  assert.equal(session.viewers.size, 0);
});

test('navigate checks the URL; input and text go to the page', async () => {
  const { browser, launcher } = setup();
  await browser.start('r', ann, undefined);
  const session = browser.get('r');
  assert.ok(session);
  await assert.rejects(browser.navigate(session, 'localhost'), /Belső hálózati/);
  await browser.navigate(session, 'example.org');
  assert.equal(session.currentUrl, 'https://example.org/');
  await browser.input(session, 'mouse', { type: 'mouseMoved', x: 1, y: 2 }, false);
  await browser.insertText(session, 'hi');
  await browser.reset(session);
  assert.deepEqual(launcher.page.calls.slice(-3), [['mouse', { type: 'mouseMoved', x: 1, y: 2 }], ['text', 'hi'], ['goto', DEFAULT_URL]]);
});

test('an unwatched session closes after the idle timeout; destroy broadcasts null', async () => {
  const { browser, launcher, scheduler, states, logs } = setup();
  await browser.start('r', ann, undefined);
  const session = browser.get('r');
  assert.ok(session);
  assert.equal(scheduler.pending.size, 0);
  browser.removeViewer(session, 's1');
  assert.equal(scheduler.pending.size, 1);
  scheduler.fireAll();
  await flush();
  assert.equal(browser.get('r'), undefined);
  assert.deepEqual(states.at(-1), ['r', null]);
  assert.deepEqual(launcher.page.calls.at(-1), ['close', null]);
  assert.ok(logs.some((l) => l.message.startsWith('Inaktivitási időkorlát lejárt')));
  assert.equal(IDLE_TIMEOUT_MS, 300_000);
});
