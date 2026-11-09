// Mozgás és sugárkövetés. A stepMovement másolata a frontenden is fut (src/game/movement.js)
// a kliensoldali előrejelzéshez, az egyezést a physics.test.js ellenőrzi.

const GRAVITY = 26;
const JUMP_SPEED = 9.5;
const SPRINT_MULTIPLIER = 1.35;
const KNOCKBACK_DECAY = 5;
const BODY_RADIUS = 0.5;
const BODY_HEIGHT = 1.8;

function overlaps(b, c) {
  return (
    b.x + BODY_RADIUS > c.min[0] && b.x - BODY_RADIUS < c.max[0] &&
    b.y + BODY_HEIGHT > c.min[1] && b.y < c.max[1] &&
    b.z + BODY_RADIUS > c.min[2] && b.z - BODY_RADIUS < c.max[2]
  );
}

function moveAxis(b, axis, delta, world) {
  b[axis] += delta;
  for (const c of world.colliders) {
    if (!overlaps(b, c)) continue;
    if (axis === 'x') b.x = delta > 0 ? c.min[0] - BODY_RADIUS : c.max[0] + BODY_RADIUS;
    else if (axis === 'z') b.z = delta > 0 ? c.min[2] - BODY_RADIUS : c.max[2] + BODY_RADIUS;
    else if (delta > 0) {
      b.y = c.min[1] - BODY_HEIGHT;
      b.vy = 0;
    } else {
      b.y = c.max[1];
      b.vy = 0;
      b.onGround = true;
    }
  }
}

// body: { x, y, z, vy, kx, kz, onGround, dashTime, dashX, dashZ }
// input: { mx, mz, yaw, jump, sprint }
function stepMovement(b, input, speed, world, dt) {
  let mx = input.mx;
  let mz = input.mz;
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }

  const moveSpeed = speed * (input.sprint && len > 0 ? SPRINT_MULTIPLIER : 1);
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  let vx = (mx * cos - mz * sin) * moveSpeed + b.kx;
  let vz = (-mx * sin - mz * cos) * moveSpeed + b.kz;

  if (b.dashTime > 0) {
    vx = b.dashX;
    vz = b.dashZ;
    b.dashTime = Math.max(0, b.dashTime - dt);
  }

  const decay = Math.exp(-KNOCKBACK_DECAY * dt);
  b.kx *= decay;
  b.kz *= decay;
  if (Math.abs(b.kx) < 0.01) b.kx = 0;
  if (Math.abs(b.kz) < 0.01) b.kz = 0;

  if (input.jump && b.onGround) b.vy = JUMP_SPEED;
  b.vy -= GRAVITY * dt;
  b.onGround = false;

  moveAxis(b, 'x', vx * dt, world);
  moveAxis(b, 'z', vz * dt, world);
  moveAxis(b, 'y', b.vy * dt, world);

  const { bounds } = world;
  b.x = Math.min(bounds.maxX - BODY_RADIUS, Math.max(bounds.minX + BODY_RADIUS, b.x));
  b.z = Math.min(bounds.maxZ - BODY_RADIUS, Math.max(bounds.minZ + BODY_RADIUS, b.z));
  if (b.y <= 0) {
    b.y = 0;
    b.vy = 0;
    b.onGround = true;
  }
}

const VEHICLE = { maxSpeed: 30, accel: 24, brake: 36, drag: 8, steer: 2.5, offroad: 0.45, nitroMult: 1.4, boostMult: 1.6, nitroBurn: 35, nitroRegen: 6, reverse: 8, stunDrag: 6 };

function segmentDistance(px, pz, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = dx * dx + dz * dz;
  const t = len ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / len)) : 0;
  return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
}

function onTrack(track, x, z) {
  if (!track) return true;
  for (const route of track.routes) {
    for (let i = 0; i < route.points.length; i += 1) {
      const next = route.points[(i + 1) % route.points.length];
      if (i === route.points.length - 1 && route.open) break;
      if (segmentDistance(x, z, route.points[i], next) <= route.width / 2) return true;
    }
  }
  return false;
}

// Jármű: b.speed, b.heading, b.nitro, b.boostTime, b.stunTime. A mz gáz/fék, mx kormány, sprint a nitró.
function stepVehicle(b, input, world, dt) {
  const stunned = b.stunTime > 0;
  if (stunned) b.stunTime = Math.max(0, b.stunTime - dt);
  const mz = stunned ? 0 : input.mz;
  const mx = stunned ? 0 : input.mx;

  let max = VEHICLE.maxSpeed;
  if (!onTrack(world.track, b.x, b.z)) max *= VEHICLE.offroad;
  const nitro = input.sprint && b.nitro > 0 && !stunned && mz > 0;
  b.nitro = nitro ? Math.max(0, b.nitro - VEHICLE.nitroBurn * dt) : Math.min(100, b.nitro + VEHICLE.nitroRegen * dt);
  if (nitro) max *= VEHICLE.nitroMult;
  if (b.boostTime > 0) {
    max *= VEHICLE.boostMult;
    b.boostTime = Math.max(0, b.boostTime - dt);
  }

  if (stunned) b.speed *= Math.exp(-VEHICLE.stunDrag * dt);
  else if (mz > 0) b.speed += VEHICLE.accel * (nitro || b.boostTime > 0 ? 1.7 : 1) * mz * dt;
  else if (mz < 0) b.speed += VEHICLE.brake * mz * dt;
  else b.speed -= Math.sign(b.speed) * Math.min(Math.abs(b.speed), VEHICLE.drag * dt);

  if (b.speed > max) b.speed = Math.max(max, b.speed - 32 * dt);
  b.speed = Math.max(-VEHICLE.reverse, b.speed);

  b.heading -= mx * VEHICLE.steer * Math.min(1, Math.abs(b.speed) / 10) * Math.sign(b.speed || 1) * dt;
  const dx = -Math.sin(b.heading) * b.speed * dt;
  const dz = -Math.cos(b.heading) * b.speed * dt;
  const wantX = b.x + dx;
  const wantZ = b.z + dz;
  b.y = 0;
  moveAxis(b, 'x', dx, world);
  moveAxis(b, 'z', dz, world);
  const { bounds } = world;
  b.x = Math.min(bounds.maxX - BODY_RADIUS, Math.max(bounds.minX + BODY_RADIUS, b.x));
  b.z = Math.min(bounds.maxZ - BODY_RADIUS, Math.max(bounds.minZ + BODY_RADIUS, b.z));
  if (Math.abs(b.x - wantX) > 1e-6 || Math.abs(b.z - wantZ) > 1e-6) b.speed *= 0.55;
  b.y = 0;
  b.vy = 0;
  b.onGround = true;
}

// Sugár és tengelyhez igazított doboz metszése: a találat távolsága vagy null
function rayBox(o, d, min, max, maxT) {
  let tMin = 0;
  let tMax = maxT;
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < min[i] || o[i] > max[i]) return null;
    } else {
      let t1 = (min[i] - o[i]) / d[i];
      let t2 = (max[i] - o[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }
  }
  return tMin;
}

function rayWorld(o, d, world, maxT) {
  let nearest = maxT;
  for (const c of world.colliders) {
    const t = rayBox(o, d, c.min, c.max, nearest);
    if (t !== null && t < nearest) nearest = t;
  }
  return nearest;
}

module.exports = { stepMovement, stepVehicle, onTrack, VEHICLE, rayBox, rayWorld, BODY_RADIUS, BODY_HEIGHT, SPRINT_MULTIPLIER };
