import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import { io as connectClient } from 'socket.io-client';
import { SocketServer } from '../../../src/infrastructure/socket/index.ts';
import { SocketController } from '../../../src/core/socket/index.ts';
import { PayloadReader } from '../../../src/core/validation/index.ts';
import type { Logger } from '../../../src/core/logging/index.ts';
import { captureLogger } from './fakes.ts';

/** Echo controller: validates, acks, and pushes room state on join. */
class RoomController extends SocketController {
  readonly #server: SocketServer;

  constructor(logger: Logger, server: SocketServer) {
    super(logger);
    this.#server = server;
  }

  register(socket: Socket): void {
    this.listen(socket, 'init', () => this.#server.buildInitialState());
    this.listen(socket, 'join', (payload) => {
      const channelId = new PayloadReader(payload).requireString('channelId', { trim: true, maxLength: 32 });
      this.#server.emitRoomState(socket, channelId);
      return { ok: true, channelId };
    });
    this.listen(socket, 'crash', () => { throw new Error('internal detail'); });
  }
}

test('real socket.io round trip: acks, validation, room state, error containment', async (t) => {
  const http = createServer();
  const io = new Server(http);
  const { logger, logs } = captureLogger();
  const server = new SocketServer(io, logger);
  server
    .addController(new RoomController(logger, server))
    .addInitialStateProvider({ getInitialState: () => ({ chessSessions: {} }) })
    .addRoomStateProvider({ getRoomState: (id) => [{ event: 'watch:state', payload: { channelId: id } }] });
  server.start();

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  const client = connectClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
  t.after(async () => {
    client.close();
    await io.close();
  });
  await new Promise<void>((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
  });

  assert.deepEqual(await client.timeout(2000).emitWithAck('init', {}), { chessSessions: {} });

  const watchState = new Promise((resolve) => client.once('watch:state', resolve));
  assert.deepEqual(await client.timeout(2000).emitWithAck('join', { channelId: ' hang-chill ' }), { ok: true, channelId: 'hang-chill' });
  assert.deepEqual(await watchState, { channelId: 'hang-chill' });

  assert.deepEqual(await client.timeout(2000).emitWithAck('join', { channelId: 7 }), {
    ok: false, error: 'Érvénytelen adat.', code: 'VALIDATION_ERROR'
  });
  assert.deepEqual(await client.timeout(2000).emitWithAck('crash', null), { ok: false, error: 'Váratlan hiba történt.' });

  assert.ok(logs.some((l) => l.level === 'error' && l.message.includes('"crash" handler failed')));
  assert.equal(io.sockets.listenerCount('connection'), 1);
});
