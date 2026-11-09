const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { createGameStore } = require('../store');

function setup(startAt = Date.UTC(2026, 10, 10, 12)) {
  const db = new Database(':memory:');
  const clock = { t: startAt, h: 12 };
  const store = createGameStore(db, { metaOptions: { now: () => clock.t, hour: () => clock.h } });
  const { meta } = store;
  for (const [id, name] of [['1', 'Anna'], ['2', 'Bela'], ['3', 'Cili']]) meta.ensurePlayer(id, name);
  return { db, clock, store, meta };
}
const rich = (meta, id, coins = 100000) => { meta.addCurrency(id, 'coins', coins); meta.addCurrency(id, 'gems', 1000); };
const err = (fn, re) => assert.throws(fn, re);
const result = (id, over = {}, players) => ({
  matchId: id, mode: 'team_deathmatch', winner: 'soap', reason: 'score', score: {}, durationS: 120, playerCount: 2,
  players: players || [
    { i: 0, key: 'k1', username: 'Anna', team: 'soap', side: 'soap', characterId: 'bar_trooper', kills: 5, deaths: 1, assists: 1, damage: 500, connected: true, activeShare: 1, counters: { kills_soap: 5 }, bonusXp: 0 },
    { i: 1, key: 'k2', username: 'Bela', team: 'grime', side: 'grime', characterId: 'mold_creeper', kills: 1, deaths: 5, assists: 0, damage: 100, connected: true, activeShare: 1, counters: {}, bonusXp: 0 }
  ],
  ...over
});
const accounts = new Map([['k1', '1'], ['k2', '2']]);
const money = (db) => db.prepare('SELECT SUM(coins) c FROM game_wallets').get().c;

test('meccs: érme, statisztika, évszak, ranglista egyszerre, duplán nem', () => {
  const { store, meta } = setup();
  const { rewards } = store.recordMatch(result('m1'), 'r', accounts);
  assert.ok(rewards[0].coins > 0);
  assert.deepStrictEqual(rewards[0].achievements, ['first_win']);
  const before = meta.wallet('1').coins;
  assert.strictEqual(store.recordMatch(result('m1'), 'r', accounts).duplicate, true);
  assert.strictEqual(meta.wallet('1').coins, before);
  const board = meta.leaderboard('soap');
  assert.deepStrictEqual(board.rows, [{ value: 5, username: 'Anna' }]);
  assert.strictEqual(meta.leaderboard('wins').rows[0].username, 'Anna');
  assert.ok(meta.leaderboard('season').rows.length === 2);
  err(() => meta.leaderboard('__proto__'), /Ismeretlen/);
});

test('bolt: nincs fedezet, nincs dupla vétel, csak saját tárgy vehető fel, a nem eladó nem vehető', () => {
  const { meta, db } = setup();
  err(() => meta.buy('1', 'hat_cap'), /fedezet/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM game_inventory').get().c, 0, 'visszagörgetve');
  rich(meta, '1');
  const { inventoryId } = meta.buy('1', 'hat_cap');
  assert.strictEqual(meta.wallet('1').coins, 100000 - 150);
  err(() => meta.buy('1', 'hat_cap'), /megvan/);
  err(() => meta.buy('1', 'hat_void'), /nem vásárolható/);
  err(() => meta.buy('1', 'constructor'), /nem vásárolható/);
  err(() => meta.equip('2', inventoryId, false), /nem a te/);
  meta.equip('1', inventoryId, false);
  assert.strictEqual(meta.cosmeticsOf('1').hat, 'cap');
  meta.equip('1', inventoryId, true);
  assert.strictEqual(meta.cosmeticsOf('1').hat, undefined);
});

test('küldetések: haladás meccsből, kész előtt nem vehető át, jutalom csak egyszer, másnap új', () => {
  const { store, meta, clock } = setup();
  const list = meta.missions('1');
  assert.strictEqual(list.filter((m) => m.kind === 'daily').length, 3);
  assert.strictEqual(list.filter((m) => m.kind === 'weekly').length, 2);
  const target = list[0];
  err(() => meta.claimMission('1', target.id), /nincs kész/);
  const big = { ...result('x').players[0], kills: 500, assists: 0, damage: 50000, counters: { boss_kills: 9, territories_captured: 9, clan_activity: 20 } };
  for (let i = 0; i < 20; i += 1) store.recordMatch(result(`g${i}`, {}, [big, result('x').players[1]]), 'r', accounts);
  meta.ensurePlayer('1', 'Anna');
  const done = meta.missions('1').find((m) => m.progress >= m.goal);
  assert.ok(done, 'valamelyik teljesült');
  const before = meta.wallet('1');
  meta.claimMission('1', done.id);
  assert.notDeepStrictEqual(meta.wallet('1'), before);
  err(() => meta.claimMission('1', done.id), /már átvetted/);
  err(() => meta.claimMission('1', 'nem_letezik'), /nem aktív/);
  clock.t += 86400000;
  const day2 = meta.missions('1').filter((m) => m.kind === 'daily');
  assert.ok(day2.every((m) => !m.claimed));
});

test('eredmények: titkos feltételek valódi eseményekből, titkosak rejtve maradnak', () => {
  const { store, meta, clock } = setup();
  assert.strictEqual(meta.achievements('1').find((a) => a.id === 'night_owl').name, '???');
  clock.h = 3;
  const titan = { ...result('x').players[0], counters: { titan_kills: 1, secret_boss_kills: 1 } };
  const { rewards } = store.recordMatch(result('a1', { playerCount: 11, chaos: true }, [titan, result('x').players[1]]), 'r', accounts, { muted: new Set(['k1']) });
  for (const id of ['night_owl', 'the_gathering', 'chaos_unlocked', 'titan_slayer', 'silence_master', 'void_hunter']) assert.ok(rewards[0].achievements.includes(id), id);
  assert.ok(rewards[1].achievements.includes('night_owl'));
  assert.ok(!rewards[1].achievements.includes('silence_master'), 'a vesztes nem kapja');
  assert.strictEqual(meta.achievements('1').find((a) => a.id === 'night_owl').name, 'ÉJSZAKAI BAGOLY');
  assert.ok(meta.inventory('1').some((i) => i.item.id === 'hat_void'), 'tárgyjutalom');
  const gems = meta.wallet('1').gems;
  store.recordMatch(result('a2', { playerCount: 11, chaos: true }, [titan, result('x').players[1]]), 'r', accounts);
  assert.strictEqual(meta.wallet('1').gems, gems, 'eredmény csak egyszer jár');
});

test('klán: létrehozás költséggel, rangok, jogosultságok, kilépéskor utódlás, feloszlás', () => {
  const { meta, db } = setup();
  err(() => meta.clanCreate('1', 'Hab', ''), /fedezet/);
  rich(meta, '1');
  const { clanId } = meta.clanCreate('1', 'Hab Harcosok', 'leírás');
  assert.strictEqual(meta.wallet('1').coins, 100000 - 500);
  err(() => meta.clanCreate('1', 'Masik', ''), /Már klán/);
  rich(meta, '2');
  err(() => meta.clanCreate('2', 'hab harcosok', ''), /foglalt/);
  assert.strictEqual(meta.wallet('2').coins, 100000, 'hiba esetén nem von le');

  meta.clanJoin('2', clanId);
  meta.clanJoin('3', clanId);
  err(() => meta.clanKick('2', 'Cili'), /rangod/);
  err(() => meta.clanSetRank('2', 'Cili', 'officer'), /rangod/);
  meta.clanSetRank('1', 'Bela', 'officer');
  meta.clanKick('2', 'Cili');
  assert.strictEqual(meta.clanOf('3'), null);
  err(() => meta.clanKick('2', 'Anna'), /alacsonyabb/);

  meta.clanUpdate('1', { open: false, logo: '🦆', description: 'új' });
  err(() => meta.clanJoin('3', clanId), /meghívással/);
  meta.clanInvite('2', 'Cili');
  meta.clanJoin('3', clanId);
  const info = meta.clanInfo('1');
  assert.strictEqual(info.clan.logo, '🦆');
  assert.strictEqual(info.members.length, 3);
  meta.clanChat('3', 'Cili', 'szia');
  assert.strictEqual(meta.clanInfo('2').chat[0].text, 'szia');
  err(() => meta.clanChat('1', 'Anna', ''), /karakter/);

  meta.clanLeave('1');
  assert.strictEqual(meta.clanInfo('2').myRank, 'leader', 'a legmagasabb rangú örököl');
  meta.clanLeave('2');
  meta.clanLeave('3');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM game_clans').get().c, 0);
});

const openTrade = (meta) => {
  const { tradeId } = meta.tradeCreate('1', 'Bela');
  meta.tradeAccept('2', tradeId);
  return tradeId;
};

test('csere: atomi, mindkét fél megerősítése kell, az érme nem keletkezik és nem vész el', () => {
  const { meta, db } = setup();
  rich(meta, '1');
  meta.addCurrency('2', 'coins', 1000);
  meta.addCurrency('2', 'gems', 100);
  const { inventoryId: hat } = meta.buy('1', 'hat_cap');
  meta.equip('1', hat, false);
  const { inventoryId: mint } = meta.buy('1', 'skin_mint');
  const total = money(db);
  const id = openTrade(meta);
  meta.tradeSetOffer('1', id, { items: [hat], coins: 0 });
  meta.tradeSetOffer('2', id, { items: [], coins: 400 });
  assert.strictEqual(meta.tradeConfirm('1', id).completed, false);
  assert.strictEqual(meta.tradeConfirm('2', id).completed, true);
  assert.ok(meta.inventory('2').some((i) => i.id === hat));
  assert.ok(!meta.inventory('1').some((i) => i.id === hat));
  assert.strictEqual(meta.wallet('2').coins, 600);
  assert.strictEqual(money(db), total);
  assert.strictEqual(meta.cosmeticsOf('1').hat, undefined, 'a felvett tárgy lekerül');
  err(() => meta.tradeConfirm('1', id), /nem aktív/);
  assert.ok(meta.inventory('1').some((i) => i.id === mint));
});

test('csere: ajánlatmódosítás törli a megerősítéseket, idegen tárgy, túlköltés és dupla lista tiltva', () => {
  const { meta } = setup();
  rich(meta, '1');
  rich(meta, '3');
  const { inventoryId: mine } = meta.buy('1', 'hat_cap');
  const { inventoryId: other } = meta.buy('3', 'hat_cap');
  const id = openTrade(meta);
  err(() => meta.tradeSetOffer('1', id, { items: [other] }), /nem a tiéd/);
  err(() => meta.tradeSetOffer('1', id, { items: [mine, mine] }), /kétszer/);
  err(() => meta.tradeSetOffer('2', id, { coins: 5 }), /Nincs ennyi/);
  err(() => meta.tradeSetOffer('1', id, { coins: -5 }), /Érvénytelen/);
  err(() => meta.tradeSetOffer('1', id, { coins: 1.5 }), /Érvénytelen/);
  err(() => meta.tradeSetOffer('3', id, { coins: 0 }), /nem a te cser/);
  meta.tradeSetOffer('1', id, { items: [mine] });
  meta.tradeConfirm('2', id);
  meta.tradeSetOffer('1', id, { items: [] });
  assert.strictEqual(meta.trades('2')[0].myConfirm, false, 'csali-csere védelem');
  assert.strictEqual(meta.tradeConfirm('1', id).completed, false);
  err(() => meta.tradeConfirm('2', id), /Üres/);
});

test('csere: közben elkelt tárgy miatt az egész visszagörgetődik, nem cserélhető tárgy tiltva', () => {
  const { meta, db } = setup();
  rich(meta, '1');
  const { inventoryId: hat } = meta.buy('1', 'hat_cap');
  const id = openTrade(meta);
  meta.tradeSetOffer('1', id, { items: [hat] });
  meta.tradeSetOffer('2', id, { coins: 0 });
  db.prepare('UPDATE game_inventory SET account_id = ? WHERE id = ?', ).run('3', hat);
  meta.tradeConfirm('1', id);
  err(() => meta.tradeConfirm('2', id), /nem a tiéd/);
  assert.strictEqual(meta.trades('2')[0].status, 'active');
  assert.strictEqual(meta.trades('2')[0].myConfirm, false, 'a sikertelen megerősítés visszagörgetve');
  meta.tradeCancel('2', id);
  err(() => meta.tradeCancel('1', id), /lezárult/);

  const id2 = openTrade(meta);
  db.prepare('INSERT INTO game_inventory (id, account_id, item_id, acquired_at) VALUES (900, ?, ?, 0)').run('1', 'title_season');
  err(() => meta.tradeSetOffer('1', id2, { items: [900] }), /nem cserélhető/);
});

test('csere: letiltott partnerrel nem indítható, csak a címzett fogadhatja el', () => {
  const { meta } = setup();
  meta.block('2', 'Anna');
  err(() => meta.tradeCreate('1', 'Bela'), /nem lehetséges/);
  const { tradeId } = meta.tradeCreate('1', 'Cili');
  err(() => meta.tradeAccept('1', tradeId), /címzett/);
  err(() => meta.tradeCreate('1', 'Cili'), /nyitott/);
  err(() => meta.tradeCreate('1', 'Anna'), /Magaddal/);
});

test('terület: szomszédság, egy nyitott csata, elfoglalás tartós és ütközésmentes', () => {
  const { store, meta, clock } = setup();
  err(() => meta.warAttack('1', 'mega_bath'), /frakciót/);
  meta.setFaction('1', 'Anna', 'soap');
  meta.setFaction('2', 'Bela', 'grime');
  err(() => meta.setFaction('1', 'Anna', 'grime'), /már választottál/);
  err(() => meta.warAttack('1', 'grime_capital'), /szomszédos/);
  err(() => meta.warAttack('1', 'soap_citadel'), /szomszédos/);
  const { battleId } = meta.warAttack('1', 'lather_heights');
  err(() => meta.warAttack('1', 'chlorine_lab'), /várj/);
  clock.t += 6 * 60000;
  err(() => meta.warAttack('1', 'lather_heights'), /már folyik/);

  const wa = () => meta.warMap().territories.find((t) => t.id === 'lather_heights');
  assert.strictEqual(wa().owner, null);
  assert.ok(wa().battle);
  store.recordMatch(result('b1'), 'r', accounts, { battleId, battleWinner: 'soap' });
  assert.strictEqual(wa().owner, 'soap');
  assert.strictEqual(wa().battle, null);
  assert.strictEqual(wa().history.length, 1);
  assert.ok(meta.wallet('1').war_tokens > 0);
  assert.strictEqual(meta.leaderboard('territories').rows[0].username, 'Anna');
  assert.strictEqual(meta.wallet('2').war_tokens, 0, 'a vesztes nem kap');
  const tokens = meta.wallet('1').war_tokens;
  assert.strictEqual(meta.resolveBattle(battleId, 'grime', ['2']), false, 'másodszor nem dől el');
  assert.strictEqual(wa().owner, 'soap');
  assert.strictEqual(meta.wallet('1').war_tokens, tokens);
  assert.strictEqual(meta.leaderboard('territories').rows[0].value, 1);
});

test('terület: sikeres védés erősít, lejárt csata lezárul', () => {
  const { store, meta, clock } = setup();
  meta.setFaction('1', 'Anna', 'grime');
  const a = meta.warAttack('1', 'sewer_kingdom');
  store.recordMatch(result('b2', { winner: 'grime' }), 'r', accounts, { battleId: a.battleId, battleWinner: null });
  assert.strictEqual(meta.warMap().territories.find((t) => t.id === 'sewer_kingdom').owner, null);
  clock.t += 6 * 60000;
  const b = meta.warAttack('1', 'hair_market');
  clock.t += 21 * 60000;
  meta.maintain();
  assert.strictEqual(meta.getBattle(b.battleId), null);
});

test('évszak: frakciógyőztes, jutalmak egyszer, archiválás, a tartós fejlődés marad', () => {
  const { store, meta, clock, db } = setup();
  meta.setFaction('1', 'Anna', 'soap');
  meta.setFaction('2', 'Bela', 'grime');
  store.recordMatch(result('s1'), 'r', accounts);
  const seasonId = meta.currentSeason().id;
  const xpBefore = meta.profile('1').xp;
  const { battleId } = meta.warAttack('1', 'lather_heights');
  store.recordMatch(result('s2'), 'r', accounts, { battleId, battleWinner: 'soap' });
  const xp = meta.profile('1').xp;
  assert.ok(xp > xpBefore);
  const gems = meta.wallet('1').gems;

  assert.strictEqual(meta.maintain(), null, 'még tart');
  clock.t += 31 * 86400000;
  const out = meta.maintain();
  assert.strictEqual(out.ended, seasonId);
  assert.strictEqual(out.winner, 'soap');
  assert.strictEqual(meta.endSeason(seasonId), null, 'kétszer nem zárul');
  assert.ok(meta.wallet('1').gems > gems + 100);
  assert.ok(meta.inventory('1').some((i) => i.item.id === 'title_season'));
  assert.notStrictEqual(meta.currentSeason().id, seasonId);
  assert.strictEqual(meta.profile('1').xp, xp, 'a tartós XP megmarad');
  assert.strictEqual(meta.leaderboard('season').rows.length, 0, 'az évszakos ranglista üres');
  assert.ok(meta.leaderboard('wins').rows.length > 0);
  assert.strictEqual(meta.warMap().territories.find((t) => t.id === 'lather_heights').owner, null);
  assert.strictEqual(meta.factionOf('1'), null);
  assert.strictEqual(db.prepare("SELECT status FROM game_seasons WHERE id = ?").get(seasonId).status, 'ended');
});

test('bázis: építés idővel és költséggel, termelés, fejlesztés, rajtaütés, javítás', () => {
  const { meta, clock } = setup();
  err(() => meta.baseBuild('1', 'Anna', 'generator'), /fedezet/);
  rich(meta, '1');
  rich(meta, '2', 5000);
  meta.baseBuild('1', 'Anna', 'generator');
  let state = meta.baseState('1');
  assert.strictEqual(state.buildings[0].ready, false);
  err(() => meta.baseUpgrade('1', state.buildings[0].id), /Még épül/);
  clock.t += 3600000 + 60000;
  err(() => meta.baseBuild('1', 'Anna', 'nope'), /Ismeretlen/);
  const coins = meta.wallet('1').coins;
  const { amount } = meta.baseCollect('1');
  assert.ok(amount >= 40 && amount <= 42, `${amount}`);
  assert.strictEqual(meta.wallet('1').coins, coins + amount);
  err(() => meta.baseCollect('1'), /nincs mit/);
  state = meta.baseState('1');
  meta.baseUpgrade('1', state.buildings[0].id);
  clock.t += 3600000;
  assert.strictEqual(meta.baseState('1').buildings[0].level, 2);
  meta.baseBuild('1', 'Anna', 'gym');
  clock.t += 400000;
  assert.strictEqual(meta.modifyXp('1', 100), 103, 'az edzőterem XP-bónuszt ad');

  err(() => meta.baseRaid('2', 'Bela', () => 0.5), /Saját/);
  const before = meta.wallet('1').coins;
  const raid = meta.baseRaid('2', 'Anna', () => 0.99);
  assert.ok(raid.success);
  assert.ok(raid.stolen > 0);
  assert.strictEqual(meta.wallet('1').coins, before - raid.stolen);
  assert.strictEqual(meta.wallet('2').coins, 5000 + raid.stolen);
  err(() => meta.baseRaid('2', 'Anna', () => 0.5), /újabb/);
  const hurt = meta.baseState('1').buildings.find((b) => b.health < b.maxHealth);
  assert.ok(hurt, 'egy épület sérült');
  meta.baseRepair('1', hurt.id);
  assert.strictEqual(meta.baseState('1').buildings.find((b) => b.id === hurt.id).health, hurt.maxHealth);
  err(() => meta.baseRepair('1', hurt.id), /ép/);
});

test('rajtaütés: erős védelem visszaveri, üres bázis nem támadható', () => {
  const { meta, clock } = setup();
  rich(meta, '1');
  err(() => meta.baseRaid('2', 'Anna', () => 0.5), /nincs támadható/);
  for (let i = 0; i < 4; i += 1) meta.baseBuild('1', 'Anna', 'tower');
  for (let i = 0; i < 8; i += 1) meta.baseBuild('1', 'Anna', 'wall');
  clock.t += 3600000;
  const coins = meta.wallet('1').coins;
  const r = meta.baseRaid('2', 'Anna', () => 0.5);
  assert.strictEqual(r.success, false);
  assert.strictEqual(meta.wallet('1').coins, coins);
});

test('közösség: barátság kétoldalú, letiltás bontja és tiltja, jelentés korlátozott', () => {
  const { meta } = setup();
  meta.friendRequest('1', 'Bela');
  err(() => meta.friendRequest('2', 'Anna'), /Már van/);
  assert.strictEqual(meta.isFriend('1', '2'), false);
  err(() => meta.friendAccept('1', 'Bela'), /Nincs ilyen/);
  meta.friendAccept('2', 'Anna');
  assert.strictEqual(meta.isFriend('2', '1'), true);
  meta.block('2', 'Anna');
  assert.strictEqual(meta.isFriend('1', '2'), false);
  err(() => meta.friendRequest('1', 'Bela'), /nem lehetséges/);
  for (let i = 0; i < 10; i += 1) meta.report('3', 'Anna', 'csalás');
  err(() => meta.report('3', 'Anna', 'csalás'), /Túl sok/);
});

test('admin: felfüggesztés, beállítások, terület, napló', () => {
  const { meta, clock } = setup();
  meta.admin.suspend('admin', 'Anna', 2);
  assert.ok(meta.isSuspended('1'));
  clock.t += 3 * 3600000;
  assert.ok(!meta.isSuspended('1'));
  meta.admin.setSeasonDays('admin', 45);
  err(() => meta.admin.setSeasonDays('admin', 0), /Érvénytelen/);
  meta.admin.setXpMultiplier('admin', 2);
  assert.strictEqual(meta.modifyXp('1', 50), 100);
  err(() => meta.admin.setXpMultiplier('admin', 1e9), /Érvénytelen/);
  meta.admin.setTerritory('admin', 'mega_bath', 'grime');
  assert.strictEqual(meta.warMap().territories.find((t) => t.id === 'mega_bath').owner, 'grime');
  meta.admin.setDisabledModes('admin', ['royale']);
  assert.ok(meta.isModeDisabled('royale'));
  const view = meta.admin.overview();
  assert.ok(view.audit.length >= 5);
  assert.strictEqual(view.seasonDays, 45);
  const first = meta.admin.endSeasonNow('admin');
  assert.ok(first.next);
});
