const test = require('node:test');
const assert = require('node:assert');
const { makeMatch, own, ownB } = require('./helpers');

test('a nehéz MI bázist épít, sereget képez és támad egy passzív ellenfél ellen', () => {
  const m = makeMatch({ seed: 21, ai: true, players: [{ name: 'Gép', team: 0, isAi: true, difficulty: 'hard' }, { name: 'Ember', team: 1 }] });
  let maxArmy = 0;
  let sawAttack = false;
  const kinds = new Set();
  let ended = -1;
  for (let i = 0; i < 12000 && m.status === 'playing'; i++) {
    m.step();
    if (i % 20 === 0) {
      maxArmy = Math.max(maxArmy, own(m, 0).filter((u) => u.def.class !== 'worker' && u.k !== 'builder').length);
      for (const b of ownB(m, 0)) kinds.add(b.k);
      const foe = [...m.units.values(), ...m.buildings.values()].find((e) => e.o === 1 && e.hp < e.maxHp - 0.5);
      if (foe) sawAttack = true;
    }
    ended = i;
  }
  assert.ok(kinds.has('barracks') && kinds.has('house') && kinds.has('tavern'), `épületek: ${[...kinds]}`);
  assert.ok(maxArmy >= 8, `sereg: ${maxArmy}`);
  assert.ok(sawAttack, 'támadás kellett az ellenfélre');
  assert.strictEqual(m.status, 'ended', `nem ért véget ${ended} tickig`);
  assert.strictEqual(m.winnerTeam, 0);
  assert.ok(m.players[0].stats.buildingsDestroyed >= 1);
  assert.ok(m.players[0].stats.gathered > 500);
});

test('MI a MI ellen: kijelölt tickszámon belül győztes születik, minden nehézségi szinten', () => {
  const pairs = [['hard', 'medium', 3], ['medium', 'easy', 9], ['easy', 'easy', 4]];
  for (const [a, b, seed] of pairs) {
    const m = makeMatch({ seed, ai: true, players: [{ name: 'A', team: 0, isAi: true, difficulty: a }, { name: 'B', team: 1, isAi: true, difficulty: b }] });
    let i = 0;
    for (; i < 30000 && m.status === 'playing'; i++) m.step();
    assert.strictEqual(m.status, 'ended', `${a} vs ${b}: nem ért véget`);
    assert.ok(m.winnerTeam === 0 || m.winnerTeam === 1, `${a} vs ${b}: nincs győztes`);
    assert.ok(m.results().some((r) => r.won));
  }
});

test('MI determinizmus: azonos mag azonos végeredményt ad', () => {
  const play = () => {
    const m = makeMatch({ seed: 12, ai: true, players: [{ name: 'A', team: 0, isAi: true, difficulty: 'hard' }, { name: 'B', team: 1, isAi: true, difficulty: 'medium' }] });
    for (let i = 0; i < 2500; i++) m.step();
    return JSON.stringify({ r: m.results(), s: m.snapshot(0), p: m.players.map((p) => p.res) });
  };
  assert.strictEqual(play(), play());
});

test('az MI nem csal: ugyanazt a parancsutat használja, ezért érvénytelen parancsot elutasítanak', () => {
  const m = makeMatch({ seed: 2, ai: true, players: [{ name: 'A', team: 0, isAi: true, difficulty: 'easy' }, { name: 'B', team: 1 }] });
  const ai = m.ais[0];
  const foe = own(m, 1)[0];
  assert.strictEqual(ai.cmd({ type: 'attack', unitIds: [own(m, 0)[0].id], target: { entityId: foe.id } }).ok, false); // látótéren kívül
  // easy/medium nem kap gyűjtési bónuszt
  assert.strictEqual(m.players[0].gatherBonus, 1);
});
