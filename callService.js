// Hanghívások állapotgépe (memóriában): egy felhasználónak egyszerre egy aktív hívása lehet.
// A hívás-azonosító véletlen (nem kitalálható), de a jogosultságot mindig a hitelesített
// munkamenet (accountId) alapján ellenőrizzük, nem az azonosító ismerete alapján.
const crypto = require('crypto');
const db = require('./database');

const RING_TIMEOUT_MS = 45_000;       // ennyi ideig csörög, utána "nem fogadta"
const RECONNECT_GRACE_MS = 20_000;    // hálózati megszakadás után ennyi ideig várunk a visszatérésre
const CONNECT_TIMEOUT_MS = 30_000;    // elfogadás után ennyi idő alatt kell létrejönnie a hangkapcsolatnak

const getDmKey = (a, b) => [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('::');

class CallService {
  constructor() {
    this.calls = new Map();      // callId -> call
    this.userCall = new Map();   // accountId -> callId
  }

  getCallOf(accountId) {
    const id = this.userCall.get(accountId);
    return id ? this.calls.get(id) || null : null;
  }

  isBusy(accountId) {
    return this.userCall.has(accountId);
  }

  create(caller, callee, callerSocketId) {
    const call = {
      id: crypto.randomBytes(16).toString('hex'),
      callerAccountId: caller.accountId,
      callerUsername: caller.username,
      calleeAccountId: callee.accountId,
      calleeUsername: callee.username,
      callerSocketId,
      calleeSocketId: null,
      status: 'ringing',            // ringing -> connecting -> connected -> ended
      createdAt: Date.now(),
      answeredAt: null,
      connectedAt: null,
      endedAt: null,
      timers: {}
    };
    this.calls.set(call.id, call);
    this.userCall.set(call.callerAccountId, call.id);
    this.userCall.set(call.calleeAccountId, call.id);
    return call;
  }

  // Azonnal lezárt, soha el nem indult hívás naplózása (pl. foglalt vagy offline címzett).
  // Nem érinti az aktív hívások nyilvántartását.
  logInstant(caller, callee, status, endReason) {
    const now = Date.now();
    const entry = {
      id: crypto.randomBytes(16).toString('hex'),
      callerAccountId: caller.accountId,
      callerUsername: caller.username,
      calleeAccountId: callee.accountId,
      calleeUsername: callee.username,
      createdAt: now
    };
    db.saveCall({
      ...entry,
      dmKey: getDmKey(caller.username, callee.username),
      status,
      endedAt: now,
      endReason: endReason || null
    });
    return { ...entry, endedAt: now, result: { status, endReason, durationSec: 0 } };
  }

  // A hívás résztvevője-e a megadott fiók (és melyik oldalon)
  roleOf(call, accountId) {
    if (!call || !accountId) return null;
    if (call.callerAccountId === accountId) return 'caller';
    if (call.calleeAccountId === accountId) return 'callee';
    return null;
  }

  otherSocketId(call, role) {
    return role === 'caller' ? call.calleeSocketId : call.callerSocketId;
  }

  clearTimer(call, name) {
    if (call.timers[name]) {
      clearTimeout(call.timers[name]);
      delete call.timers[name];
    }
  }

  setTimer(call, name, ms, fn) {
    this.clearTimer(call, name);
    call.timers[name] = setTimeout(() => {
      delete call.timers[name];
      fn();
    }, ms);
  }

  // Lezárás: pontosan egyszer fut le hívásonként. Visszaadja a végleges eseményt (vagy null, ha már lezárt).
  finish(call, status, endReason) {
    if (!call || call.status === 'ended') return null;
    const wasConnected = !!call.connectedAt;
    call.status = 'ended';
    call.endedAt = Date.now();
    Object.keys(call.timers).forEach((t) => this.clearTimer(call, t));
    if (this.userCall.get(call.callerAccountId) === call.id) this.userCall.delete(call.callerAccountId);
    if (this.userCall.get(call.calleeAccountId) === call.id) this.userCall.delete(call.calleeAccountId);
    this.calls.delete(call.id);

    const durationSec = wasConnected ? Math.max(0, Math.round((call.endedAt - call.connectedAt) / 1000)) : 0;
    const finalStatus = status === 'ended' ? (wasConnected ? 'completed' : 'failed') : status;
    const result = { status: finalStatus, endReason, durationSec };

    try {
      db.saveCall({
        id: call.id,
        dmKey: getDmKey(call.callerUsername, call.calleeUsername),
        callerAccountId: call.callerAccountId,
        callerUsername: call.callerUsername,
        calleeAccountId: call.calleeAccountId,
        calleeUsername: call.calleeUsername,
        status: finalStatus,
        createdAt: call.createdAt,
        answeredAt: call.answeredAt,
        endedAt: call.endedAt,
        durationSec,
        endReason: endReason || null
      });
    } catch (err) {
      console.error('[Call] Hívásnapló mentési hiba:', err.message);
    }
    return result;
  }
}

module.exports = { CallService, getDmKey, RING_TIMEOUT_MS, RECONNECT_GRACE_MS, CONNECT_TIMEOUT_MS };
