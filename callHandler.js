// DM hanghívások szignálozása a meglévő Socket.IO kapcsolaton.
// Minden esemény hitelesített (jelszavas/tokenes) munkamenetet igényel; a szerver a hívás
// résztvevőit az accountId alapján azonosítja, a hívás-azonosító ismerete önmagában nem elég.
// A hang peer-to-peer (WebRTC) megy, a szerver soha nem látja és nem tárolja.
const db = require('./database');
const { users } = require('./state');
const { getIceServers } = require('./turnCredentialService');
const {
  CallService, getDmKey, RING_TIMEOUT_MS, RECONNECT_GRACE_MS, CONNECT_TIMEOUT_MS
} = require('./callService');

const INVITE_LIMIT = { max: 6, windowMs: 30_000 };

function sanitizeSignal(s) {
  if (!s || typeof s !== 'object') return null;
  switch (s.type) {
    case 'offer':
    case 'answer':
      return typeof s.sdp === 'string' && s.sdp.length > 0 && s.sdp.length <= 30_000
        ? { type: s.type, sdp: s.sdp } : null;
    case 'candidate': {
      if (s.candidate === null) return { type: 'candidate', candidate: null };
      const c = s.candidate;
      if (!c || typeof c.candidate !== 'string' || c.candidate.length > 1000) return null;
      if (c.sdpMid != null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 64)) return null;
      if (c.sdpMLineIndex != null && !(Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 256)) return null;
      return {
        type: 'candidate',
        candidate: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null }
      };
    }
    case 'restart-request':
      return { type: 'restart-request' };
    case 'media':
      return typeof s.muted === 'boolean' ? { type: 'media', muted: s.muted } : null;
    default:
      return null;
  }
}

module.exports = function setupCalls(io) {
  const service = new CallService();

  // --- segédek ---
  const authedUser = (socket) => {
    const u = users.get(socket.id);
    return u && u.authenticated === true && u.accountId ? u : null;
  };

  const socketsOf = (accountId) => {
    const ids = [];
    for (const [sid, u] of users.entries()) {
      if (u.authenticated === true && u.accountId === accountId) ids.push(sid);
    }
    return ids;
  };

  const emitTo = (ids, event, payload) => ids.forEach((id) => id && io.to(id).emit(event, payload));

  const publicProfile = (acc) => ({
    accountId: acc.id,
    username: acc.username,
    displayName: acc.username,
    avatarColor: acc.avatarColor || '#7655F5',
    avatarUrl: acc.avatarUrl || null
  });

  // A hívás eredménye rendszerüzenetként bekerül a DM-be, és mindkét fél minden eszközére megy
  function postCallMessage(entry, result) {
    const callerAcc = db.getAccountById(entry.callerAccountId);
    const calleeAcc = db.getAccountById(entry.calleeAccountId);
    if (!callerAcc || !calleeAcc) return;
    const now = Date.now();
    const callerSockets = socketsOf(entry.callerAccountId);
    const calleeSockets = socketsOf(entry.calleeAccountId);
    const msg = {
      id: `dm_${now}_${Math.random().toString(36).slice(2, 11)}`,
      dmKey: getDmKey(callerAcc.username, calleeAcc.username),
      username: callerAcc.username,
      senderId: callerSockets[0] || callerAcc.id,
      senderAccountId: callerAcc.id,
      senderUsername: callerAcc.username,
      senderAvatarColor: callerAcc.avatarColor || '#7655F5',
      senderAvatarUrl: callerAcc.avatarUrl || null,
      recipientId: calleeSockets[0] || calleeAcc.id,
      recipientUsername: calleeAcc.username,
      recipientAvatarColor: calleeAcc.avatarColor || '#7655F5',
      recipientAvatarUrl: calleeAcc.avatarUrl || null,
      avatarColor: callerAcc.avatarColor || '#7655F5',
      avatarUrl: callerAcc.avatarUrl || null,
      text: '',
      attachments: [],
      timestamp: new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      createdAt: now,
      isPrivate: true,
      callEvent: {
        callId: entry.id,
        status: result.status,
        endReason: result.endReason || null,
        durationSec: result.durationSec || 0,
        callerUsername: callerAcc.username,
        calleeUsername: calleeAcc.username
      }
    };
    try {
      db.saveDmMessage(msg);
    } catch (err) {
      console.error('[Call] DM rendszerüzenet mentési hiba:', err.message);
      return;
    }
    emitTo([...callerSockets, ...calleeSockets], 'dm:new-message', msg);
  }

  // Egységes lezárás: naplózás + DM üzenet + értesítés minden érintett eszköznek
  function endCall(call, status, endReason) {
    const result = service.finish(call, status, endReason);
    if (!result) return null;
    postCallMessage(call, result);
    emitTo(
      [...socketsOf(call.callerAccountId), ...socketsOf(call.calleeAccountId)],
      'call:ended',
      { callId: call.id, status: result.status, reason: endReason || null, durationSec: result.durationSec }
    );
    console.log(`[Call] ${call.callerUsername} -> ${call.calleeUsername}: ${result.status} (${endReason || '-'}, ${result.durationSec}s)`);
    return result;
  }

  function startGrace(call, role) {
    const key = `grace_${role}`;
    service.setTimer(call, key, RECONNECT_GRACE_MS, () => {
      endCall(call, call.status === 'ringing' ? 'missed' : 'ended', 'connection-lost');
    });
  }

  io.on('connection', (socket) => {
    const inviteTimes = [];
    const reply = (ack) => (typeof ack === 'function' ? ack : () => {});

    // Hívás indítása a DM partnernek
    socket.on('call:invite', ({ targetUsername } = {}, ack) => {
      const done = reply(ack);
      const me = authedUser(socket);
      if (!me) return done({ ok: false, error: 'unauthenticated' });
      if (typeof targetUsername !== 'string' || !targetUsername.trim()) return done({ ok: false, error: 'not-found' });

      const targetAcc = db.getAccountByUsername(targetUsername.trim());
      if (!targetAcc) return done({ ok: false, error: 'not-found' });
      if (targetAcc.id === me.accountId) return done({ ok: false, error: 'self' });
      if (service.isBusy(me.accountId)) return done({ ok: false, error: 'already-in-call' });

      // Szűrés: csak a ténylegesen hívást/naplóbejegyzést létrehozó kísérletek számítanak
      const now = Date.now();
      while (inviteTimes.length && now - inviteTimes[0] > INVITE_LIMIT.windowMs) inviteTimes.shift();
      if (inviteTimes.length >= INVITE_LIMIT.max) return done({ ok: false, error: 'rate-limited' });
      inviteTimes.push(now);

      const callerRef = { accountId: me.accountId, username: me.username };
      const calleeRef = { accountId: targetAcc.id, username: targetAcc.username };

      if (service.isBusy(targetAcc.id)) {
        const entry = service.logInstant(callerRef, calleeRef, 'busy', 'busy');
        postCallMessage(entry, entry.result);
        return done({ ok: false, error: 'busy', peer: publicProfile(targetAcc) });
      }

      const calleeSockets = socketsOf(targetAcc.id);
      if (calleeSockets.length === 0) {
        const entry = service.logInstant(callerRef, calleeRef, 'missed', 'offline');
        postCallMessage(entry, entry.result);
        return done({ ok: false, error: 'offline', peer: publicProfile(targetAcc) });
      }

      const call = service.create(callerRef, calleeRef, socket.id);
      const callerAcc = db.getAccountById(me.accountId);
      emitTo(calleeSockets, 'call:incoming', {
        callId: call.id,
        caller: publicProfile(callerAcc || { id: me.accountId, username: me.username, avatarColor: me.avatarColor, avatarUrl: me.avatarUrl }),
        createdAt: call.createdAt
      });
      service.setTimer(call, 'ring', RING_TIMEOUT_MS, () => endCall(call, 'missed', 'no-answer'));

      console.log(`[Call] ${me.username} hívja: ${targetAcc.username} (${call.id.slice(0, 8)})`);
      done({
        ok: true,
        callId: call.id,
        peer: publicProfile(targetAcc),
        ringingDevices: calleeSockets.length,
        ...getIceServers(me.accountId)
      });
    });

    // A hívott fél elfogadja
    socket.on('call:accept', ({ callId } = {}, ack) => {
      const done = reply(ack);
      const me = authedUser(socket);
      const call = me && typeof callId === 'string' ? service.calls.get(callId) : null;
      if (!call || service.roleOf(call, me.accountId) !== 'callee') return done({ ok: false, error: 'not-found' });
      if (call.status !== 'ringing') return done({ ok: false, error: 'expired' });

      call.status = 'connecting';
      call.answeredAt = Date.now();
      call.calleeSocketId = socket.id;
      service.clearTimer(call, 'ring');
      service.setTimer(call, 'connect', CONNECT_TIMEOUT_MS, () => endCall(call, 'failed', 'connect-timeout'));

      // A többi eszköz csörgése leáll
      emitTo(socketsOf(me.accountId).filter((id) => id !== socket.id), 'call:handled-elsewhere', { callId, action: 'accepted' });
      emitTo([call.callerSocketId], 'call:accepted', { callId });
      done({ ok: true, ...getIceServers(me.accountId) });
    });

    socket.on('call:decline', ({ callId } = {}, ack) => {
      const done = reply(ack);
      const me = authedUser(socket);
      const call = me && typeof callId === 'string' ? service.calls.get(callId) : null;
      if (!call || service.roleOf(call, me.accountId) !== 'callee' || call.status !== 'ringing') {
        return done({ ok: false, error: 'not-found' });
      }
      endCall(call, 'declined', 'declined');
      done({ ok: true });
    });

    // Befejezés / lemondás (bármelyik résztvevő, csak a saját hívására)
    socket.on('call:end', ({ callId } = {}, ack) => {
      const done = reply(ack);
      const me = authedUser(socket);
      const call = me && typeof callId === 'string' ? service.calls.get(callId) : null;
      const role = call ? service.roleOf(call, me.accountId) : null;
      if (!role) return done({ ok: false, error: 'not-found' });

      if (call.status === 'ringing') {
        if (role === 'caller') endCall(call, 'missed', 'cancelled');
        else endCall(call, 'declined', 'declined');
      } else {
        endCall(call, 'ended', 'hangup');
      }
      done({ ok: true });
    });

    // SDP offer/answer, ICE candidate, médiaállapot továbbítása a hívás másik felének
    socket.on('call:signal', ({ callId, signal } = {}) => {
      const me = authedUser(socket);
      const call = me && typeof callId === 'string' ? service.calls.get(callId) : null;
      const role = call ? service.roleOf(call, me.accountId) : null;
      if (!role || call.status === 'ringing') return;
      const boundId = role === 'caller' ? call.callerSocketId : call.calleeSocketId;
      if (boundId !== socket.id) return; // csak a hívásba kötött eszköz szignálozhat
      const clean = sanitizeSignal(signal);
      if (!clean) return;
      const target = service.otherSocketId(call, role);
      if (target) io.to(target).emit('call:signal', { callId, signal: clean });
    });

    // A kliens jelzi, hogy a hangkapcsolat létrejött (a hívás idejének kezdete)
    socket.on('call:connected', ({ callId } = {}) => {
      const me = authedUser(socket);
      const call = me && typeof callId === 'string' ? service.calls.get(callId) : null;
      const role = call ? service.roleOf(call, me.accountId) : null;
      if (!role || call.status === 'ringing' || call.status === 'ended') return;
      service.clearTimer(call, 'connect');
      if (!call.connectedAt) {
        call.connectedAt = Date.now();
        call.status = 'connected';
      }
    });

    // Újracsatlakozás (hálózat-megszakadás után) vagy késői csörgés-szinkron új eszközön
    socket.on('call:sync', ({ callId } = {}, ack) => {
      const done = reply(ack);
      const me = authedUser(socket);
      if (!me) return done({ ok: false, error: 'unauthenticated' });
      const call = service.getCallOf(me.accountId);

      if (call && callId && call.id === callId) {
        const role = service.roleOf(call, me.accountId);
        const ringingCallee = role === 'callee' && call.status === 'ringing';
        if (!ringingCallee) {
          if (role === 'caller') call.callerSocketId = socket.id; else call.calleeSocketId = socket.id;
          service.clearTimer(call, `grace_${role}`);
          emitTo([service.otherSocketId(call, role)], 'call:peer-reconnected', { callId });
          return done({
            ok: true,
            resumed: true,
            role,
            status: call.status,
            elapsedSec: call.connectedAt ? Math.round((Date.now() - call.connectedAt) / 1000) : 0,
            ...getIceServers(me.accountId)
          });
        }
      }

      if (call && service.roleOf(call, me.accountId) === 'callee' && call.status === 'ringing') {
        const callerAcc = db.getAccountById(call.callerAccountId);
        if (callerAcc) {
          socket.emit('call:incoming', { callId: call.id, caller: publicProfile(callerAcc), createdAt: call.createdAt });
        }
      }
      done({ ok: true, resumed: false, stale: !!callId });
    });

    socket.on('call:get-ice-config', (_p, ack) => {
      const me = authedUser(socket);
      reply(ack)(me ? { ok: true, ...getIceServers(me.accountId) } : { ok: false, error: 'unauthenticated' });
    });

    // Hívások listája egy DM-hez (csak a saját beszélgetésekhez)
    socket.on('call:history', ({ targetUsername } = {}, ack) => {
      const done = reply(ack);
      const me = authedUser(socket);
      if (!me || typeof targetUsername !== 'string') return done({ ok: false, error: 'unauthenticated' });
      done({ ok: true, calls: db.getCallHistory(getDmKey(me.username, targetUsername.trim())) });
    });

    socket.on('disconnect', () => {
      for (const call of service.calls.values()) {
        if (call.callerSocketId === socket.id) {
          call.callerSocketId = null;
          emitTo([call.calleeSocketId], 'call:peer-reconnecting', { callId: call.id });
          startGrace(call, 'caller');
        } else if (call.calleeSocketId === socket.id) {
          call.calleeSocketId = null;
          emitTo([call.callerSocketId], 'call:peer-reconnecting', { callId: call.id });
          startGrace(call, 'callee');
        }
      }
    });
  });

  return { service };
};
