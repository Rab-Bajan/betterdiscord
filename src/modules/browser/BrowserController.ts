import type { Socket } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import { SocketController } from '../../core/socket/SocketController.ts';
import type { UserRegistry } from '../presence/UserRegistry.ts';
import { legacyDefaultedFields } from '../shared/legacyDefaultedPayload.ts';
import { BrowserError, type BrowserService } from './BrowserService.ts';
import type { BrowserPerson, BrowserSession } from './types.ts';

const FALLBACK_NAME = 'Felhasználó';
const FALLBACK_COLOR = '#7655F5';
const NOT_A_MEMBER = 'Csak a hangcsatornában lévő tagok indíthatnak böngészőt.';
const NOT_CONTROLLER = 'Jelenleg a kiválasztott irányító vezérelheti a böngészőt.';

type Fields = Readonly<Record<string, unknown>>;
/** `Math.round` with the ToNumber coercion it applies. */
const round = (value: unknown): number => Math.round(Number(value));
/** Legacy destructuring default: only `undefined` takes it. */
const orDefault = (value: unknown, fallback: unknown): unknown => (value === undefined ? fallback : value);

const mouseButton = (button: unknown): 'left' | 'right' | 'middle' =>
  button === 'right' || button === 2 ? 'right' : button === 'middle' || button === 1 ? 'middle' : 'left';

/** Socket events of legacy browserHandler.js (`browser:*`). Only voice-channel members may act. */
export class BrowserController extends SocketController {
  readonly #users: UserRegistry;
  readonly #browser: BrowserService;
  readonly #log: Logger;

  /** @param logger scoped `SharedBrowser` so console lines match legacy */
  constructor(users: UserRegistry, browser: BrowserService, logger: Logger) {
    super(logger);
    this.#users = users;
    this.#browser = browser;
    this.#log = logger;
  }

  register(socket: Socket): void {
    this.listen(socket, 'browser:get-state', (payload) => {
      const fields = legacyDefaultedFields(payload);
      if (!fields || !fields['channelId']) return;
      const session = this.#browser.get(fields['channelId']);
      socket.emit('browser:state', this.#browser.publicState(fields['channelId']));
      if (session?.lastFrame) socket.emit('browser:frame', session.lastFrame);
    });

    this.listen(socket, 'browser:view-enter', (payload) => {
      const fields = legacyDefaultedFields(payload);
      const channelId = fields?.['channelId'];
      if (!channelId || !this.#inRoom(socket, channelId)) return;
      const session = this.#browser.get(channelId);
      if (!session) return;
      this.#browser.addViewer(session, this.#person(socket));
      if (session.lastFrame) socket.emit('browser:frame', session.lastFrame);
    });

    this.listen(socket, 'browser:view-leave', (payload) => {
      const fields = legacyDefaultedFields(payload);
      const session = fields?.['channelId'] ? this.#browser.get(fields['channelId']) : undefined;
      if (session) this.#browser.removeViewer(session, socket.id);
    });

    this.listen(socket, 'browser:start', async (payload) => {
      const fields = legacyDefaultedFields(payload);
      if (!fields) return;
      const channelId = fields['channelId'];
      if (typeof channelId !== 'string' || !channelId || !this.#inRoom(socket, channelId)) {
        socket.emit('browser:error', { message: NOT_A_MEMBER });
        return;
      }
      try {
        await this.#browser.start(channelId, this.#person(socket), fields['initialUrl']);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#log.error('Indítási hiba:', message);
        socket.emit('browser:error', { message });
      }
    });

    this.listen(socket, 'browser:navigate', async (payload) => {
      const target = this.#member(socket, payload);
      if (!target) return;
      if (!this.#browser.canInteract(target.session, socket.id)) {
        socket.emit('browser:error', { message: NOT_CONTROLLER });
        return;
      }
      try {
        await this.#browser.navigate(target.session, target.fields['url']);
      } catch (err) {
        if (!(err instanceof BrowserError)) throw err;
        socket.emit('browser:error', { message: err.message });
      }
    });

    this.#control(socket, 'browser:back', (session) => this.#browser.goBack(session));
    this.#control(socket, 'browser:forward', (session) => this.#browser.goForward(session));
    this.#control(socket, 'browser:reload', (session) => this.#browser.reload(session));
    this.#control(socket, 'browser:reset', (session) => this.#browser.reset(session));

    this.listen(socket, 'browser:mouse-move', async (payload) => {
      const target = this.#member(socket, payload);
      if (!target) return;
      const { x, y } = target.fields;
      const me = this.#person(socket);
      socket.to(target.session.channelId).emit('browser:cursor-moved', { userId: me.id, username: me.username, color: me.color, x, y });
      if (this.#browser.canInteract(target.session, socket.id) && typeof x === 'number' && typeof y === 'number') {
        await this.#browser.input(target.session, 'mouse', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y) }, false);
      }
    });

    this.#control(socket, 'browser:mouse-click', async (session, f) => {
      const { x, y } = f;
      if (typeof x !== 'number' || typeof y !== 'number') return;
      const button = mouseButton(orDefault(f['button'], 'left'));
      const clickCount = orDefault(f['clickCount'], 1);
      const at = { x: Math.round(x), y: Math.round(y), button, clickCount };
      await this.#browser.input(session, 'mouse', { type: 'mousePressed', ...at });
      await this.#browser.input(session, 'mouse', { type: 'mouseReleased', ...at });
    });

    this.#control(socket, 'browser:scroll', (session, f) => this.#browser.input(session, 'mouse', {
      type: 'mouseWheel',
      x: round(orDefault(f['x'], 640)),
      y: round(orDefault(f['y'], 360)),
      deltaX: round(orDefault(f['deltaX'], 0)),
      deltaY: round(orDefault(f['deltaY'], 0))
    }));

    this.#control(socket, 'browser:key', (session, f) => {
      const type = orDefault(f['type'], 'keydown');
      const { key, code, text, keyCode, modifiers } = f;
      if (type === 'char' || text) return this.#browser.input(session, 'key', { type: 'char', text: text || key });
      const cdpType = type === 'keyup' ? 'keyUp' : type === 'keydown' ? 'rawKeyDown' : 'keyDown';
      return this.#browser.input(session, 'key', { type: cdpType, key, code, windowsVirtualKeyCode: keyCode || 0, modifiers: modifiers || 0 });
    });

    this.#control(socket, 'browser:insert-text', async (session, f) => {
      const text = f['text'];
      if (text && typeof text === 'string') await this.#browser.insertText(session, text);
    });

    this.listen(socket, 'browser:set-mode', (payload) => {
      const target = this.#member(socket, payload);
      const mode = target?.fields['mode'];
      if (!target || (mode !== 'free' && mode !== 'controller')) return;
      this.#browser.setMode(target.session, mode, this.#person(socket));
    });

    this.listen(socket, 'browser:take-control', (payload) => {
      const target = this.#member(socket, payload);
      if (target) this.#browser.takeControl(target.session, this.#person(socket));
    });

    this.listen(socket, 'browser:release-control', (payload) => {
      const target = this.#member(socket, payload);
      if (target) this.#browser.releaseControl(target.session, socket.id);
    });

    this.listen(socket, 'browser:stop', async (payload) => {
      const fields = legacyDefaultedFields(payload);
      const channelId = fields?.['channelId'];
      if (typeof channelId !== 'string' || !channelId || !this.#inRoom(socket, channelId)) return;
      await this.#browser.destroy(channelId);
    });

    socket.on('disconnect', () => { this.#browser.disconnect(socket.id); });
  }

  /** A steering action: the caller must be in the room and allowed to interact. */
  #control(socket: Socket, event: string, action: (session: BrowserSession, fields: Fields) => Promise<void> | void): void {
    this.listen(socket, event, async (payload) => {
      const target = this.#member(socket, payload);
      if (!target || !this.#browser.canInteract(target.session, socket.id)) return;
      await action(target.session, target.fields);
    });
  }

  /** The session the payload names, when it exists and the caller is in its voice channel. */
  #member(socket: Socket, payload: unknown): { session: BrowserSession; fields: Fields } | null {
    const fields = legacyDefaultedFields(payload);
    const session = fields ? this.#browser.get(fields['channelId']) : undefined;
    if (!fields || !session || !this.#inRoom(socket, session.channelId)) return null;
    return { session, fields };
  }

  #inRoom(socket: Socket, channelId: unknown): boolean {
    return this.#users.get(socket.id)?.voiceChannel === channelId;
  }

  #person(socket: Socket): BrowserPerson {
    const user = this.#users.get(socket.id);
    return { id: socket.id, username: user?.username || FALLBACK_NAME, color: user?.avatarColor || FALLBACK_COLOR };
  }
}
