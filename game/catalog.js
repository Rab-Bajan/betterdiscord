// Bolt, küldetések, eredmények, területek és épületek adatai.

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'secret'];
const c = (amount) => ({ currency: 'coins', amount });
const g = (amount) => ({ currency: 'gems', amount });
const w = (amount) => ({ currency: 'war_tokens', amount });
const s = (amount) => ({ currency: 'season_tokens', amount });

const item = (id, name, slot, rarity, price, visual = {}, tradable = true) => ({ id, name, slot, rarity, price, visual, tradable });

const ITEMS = Object.fromEntries([
  item('hat_cap', 'Zuhanysapka', 'hat', 'common', c(150), { hat: 'cap', color: '#7dd3fc' }),
  item('hat_cone', 'Bója Sapka', 'hat', 'uncommon', c(400), { hat: 'cone', color: '#fb923c' }),
  item('hat_crown', 'Gumikacsa Korona', 'hat', 'epic', g(40), { hat: 'crown', color: '#facc15' }),
  item('hat_halo', 'Buborék Glória', 'hat', 'legendary', g(120), { hat: 'halo', color: '#e0f2fe' }),
  item('hat_void', 'Üresség Fazék', 'hat', 'secret', null, { hat: 'crown', color: '#581c87' }),
  item('skin_mint', 'Menta Tónus', 'tint', 'common', c(200), { tint: '#5eead4' }),
  item('skin_rose', 'Rózsa Tónus', 'tint', 'uncommon', c(450), { tint: '#fb7185' }),
  item('skin_gold', 'Arany Tónus', 'tint', 'legendary', g(150), { tint: '#fbbf24' }),
  item('skin_war', 'Háborús Festés', 'tint', 'rare', w(30), { tint: '#64748b' }),
  item('skin_season', 'Évszak Csillám', 'tint', 'mythic', s(60), { tint: '#c084fc' }),
  item('trail_foam', 'Hab Nyom', 'trail', 'rare', c(900), { trail: '#e0f2fe' }),
  item('trail_toxic', 'Mérgező Nyom', 'trail', 'epic', g(60), { trail: '#84cc16' }),
  item('car_red', 'Tűzpiros Kád', 'vehicle', 'common', c(300), { car: '#ef4444' }),
  item('car_chrome', 'Krómozott Kád', 'vehicle', 'epic', g(70), { car: '#cbd5e1' }),
  item('car_gold', 'Aranykád', 'vehicle', 'mythic', g(300), { car: '#fbbf24' }),
  item('emote_bubble', 'Buborékfújás', 'emote', 'uncommon', c(350), { emote: '🫧' }),
  item('emote_duck', 'Kacsa Tánc', 'emote', 'rare', c(800), { emote: '🦆' }),
  item('emote_skull', 'Elmosva', 'emote', 'epic', g(50), { emote: '💀' }),
  item('title_rookie', 'Újonc Súroló', 'title', 'common', c(100), { title: 'Újonc Súroló' }),
  item('title_warlord', 'Lefolyó Hadúr', 'title', 'legendary', w(120), { title: 'Lefolyó Hadúr' }),
  item('title_season', 'Évszak Bajnok', 'title', 'mythic', null, { title: 'Évszak Bajnok' }, false),
  item('relic_soap', 'Őskori Szappan', 'collectible', 'rare', c(1500), {}),
  item('relic_plug', 'Arany Dugó', 'collectible', 'legendary', g(200), {}),
  item('relic_duck', 'Titkos Kacsa', 'collectible', 'secret', null, {})
].map((i) => [i.id, i]));

const CURRENCIES = ['coins', 'gems', 'war_tokens', 'season_tokens'];

const mission = (id, name, metric, goal, reward) => ({ id, name, metric, goal, reward });
const DAILY_MISSIONS = [
  mission('d_win3', 'Nyerj 3 meccset', 'wins', 3, { coins: 200 }),
  mission('d_kill20', 'Győzz le 20 ellenfelet', 'kills', 20, { coins: 150 }),
  mission('d_dmg10k', 'Okozz 10 000 sebzést', 'damage', 10000, { coins: 200 }),
  mission('d_boss', 'Fejezz be egy főellenséget', 'boss_kills', 1, { coins: 250, gems: 2 }),
  mission('d_race', 'Vegyél részt egy versenyen', 'races', 1, { coins: 120 }),
  mission('d_match5', 'Játssz 5 meccset', 'matches', 5, { coins: 160 }),
  mission('d_terr', 'Foglalj el egy területet', 'territories_captured', 1, { war_tokens: 10, coins: 150 })
];
const WEEKLY_MISSIONS = [
  mission('w_win15', 'Nyerj 15 meccset', 'wins', 15, { coins: 900, gems: 10 }),
  mission('w_boss3', 'Győzz le 3 főellenséget', 'boss_kills', 3, { coins: 700, gems: 8 }),
  mission('w_terr5', 'Foglalj el 5 területet', 'territories_captured', 5, { war_tokens: 40 }),
  mission('w_clan10', 'Teljesíts 10 klántevékenységet', 'clan_activity', 10, { coins: 600, war_tokens: 15 }),
  mission('w_kill100', 'Győzz le 100 ellenfelet', 'kills', 100, { coins: 800 })
];

const ACHIEVEMENTS = [
  { id: 'first_win', name: 'Első Tisztítás', desc: 'Nyerj egy meccset.' },
  { id: 'night_owl', name: 'ÉJSZAKAI BAGOLY', desc: 'Fejezz be egy meccset hajnali 3 órakor.', secret: true },
  { id: 'the_gathering', name: 'A GYÜLEKEZÉS', desc: 'Játssz egy meccset legalább 10 játékossal.', secret: true },
  { id: 'silence_master', name: 'A CSEND MESTERE', desc: 'Nyerj meccset úgy, hogy közben némítva vagy.', secret: true },
  { id: 'chaos_unlocked', name: 'KÁOSZ FELOLDVA', desc: 'Élj át egy rejtett Buborékőrület eseményt.', secret: true },
  { id: 'titan_slayer', name: 'TITÁNÖLŐ', desc: 'Győzz le egy titán főellenséget.', secret: true },
  { id: 'void_hunter', name: 'ÜRESSÉG VADÁSZ', desc: 'Győzd le a titkos főellenséget.', secret: true, reward: 'hat_void' },
  { id: 'scrub_god', name: 'SÚROLÁS ISTENE', desc: 'Érd el a maximális szintet.', secret: true },
  { id: 'wave_10', name: 'Hullámtörő', desc: 'Élj túl 10 hullámot.' },
  { id: 'podium', name: 'Dobogó', desc: 'Nyerj egy versenyt.' },
  { id: 'last_bubble', name: 'Az Utolsó Buborék', desc: 'Nyerj egy Royale meccset.' },
  { id: 'conqueror', name: 'Hódító', desc: 'Foglalj el egy területet.' },
  { id: 'clan_victor', name: 'Klánhős', desc: 'Nyerj egy klánháborút.' },
  { id: 'centurion', name: 'Centurió', desc: 'Győzz le összesen 100 ellenfelet.' },
  { id: 'collector', name: 'Gyűjtő', desc: 'Birtokolj legalább 5 tárgyat.' }
];

const TERRITORIES = [
  { id: 'lather_heights', name: 'Habhegyek', x: 12, y: 22, value: 2, links: ['soap_citadel', 'mega_bath', 'scrub_base'] },
  { id: 'soap_citadel', name: 'Szappan Fellegvár', x: 22, y: 50, value: 5, links: ['lather_heights', 'chlorine_lab', 'abandoned_laundry'], start: 'soap' },
  { id: 'scrub_base', name: 'Titkos Súroló Bázis', x: 8, y: 78, value: 3, links: ['lather_heights', 'abandoned_laundry'] },
  { id: 'mega_bath', name: 'Mega Fürdő', x: 40, y: 16, value: 4, links: ['lather_heights', 'chlorine_lab', 'titan_foundry'] },
  { id: 'chlorine_lab', name: 'Klór Kutatóintézet', x: 46, y: 46, value: 6, links: ['soap_citadel', 'mega_bath', 'drain_lab', 'hair_market'] },
  { id: 'abandoned_laundry', name: 'Elhagyott Mosoda', x: 38, y: 80, value: 2, links: ['soap_citadel', 'scrub_base', 'drain_lab'] },
  { id: 'drain_lab', name: 'Föld Alatti Lefolyólabor', x: 62, y: 72, value: 3, links: ['abandoned_laundry', 'chlorine_lab', 'sewer_kingdom'] },
  { id: 'titan_foundry', name: 'Titán Öntöde', x: 66, y: 18, value: 4, links: ['mega_bath', 'hair_market', 'grime_capital'] },
  { id: 'hair_market', name: 'Szőrpiac', x: 72, y: 44, value: 3, links: ['chlorine_lab', 'titan_foundry', 'grime_capital', 'sewer_kingdom'] },
  { id: 'grime_capital', name: 'Kosz Főváros', x: 90, y: 30, value: 5, links: ['titan_foundry', 'hair_market', 'sewer_kingdom'], start: 'grime' },
  { id: 'sewer_kingdom', name: 'Csatorna Királyság', x: 88, y: 74, value: 4, links: ['drain_lab', 'hair_market', 'grime_capital'] }
];

const BUILDINGS = {
  generator: { id: 'generator', name: 'Habgenerátor', cost: 300, time: 60, health: 200, max: 3, maxLevel: 5, production: 40, desc: 'Óránként érmét termel.' },
  tower: { id: 'tower', name: 'Buboréktorony', cost: 400, time: 120, health: 300, max: 4, maxLevel: 5, defense: 15, desc: 'Növeli a bázis védelmét a rajtaütések ellen.' },
  wall: { id: 'wall', name: 'Csempefal', cost: 150, time: 30, health: 500, max: 8, maxLevel: 5, defense: 6, desc: 'Olcsó védelem.' },
  lab: { id: 'lab', name: 'Kutatólabor', cost: 800, time: 300, health: 200, max: 1, maxLevel: 5, coinBonus: 0.03, desc: 'Több érme a meccsekért.' },
  gym: { id: 'gym', name: 'Edzőterem', cost: 800, time: 300, health: 200, max: 1, maxLevel: 5, xpBonus: 0.03, desc: 'Több XP a meccsekért.' },
  armory: { id: 'armory', name: 'Fegyvertár', cost: 600, time: 180, health: 250, max: 1, maxLevel: 5, raid: 12, desc: 'Erősebbek a rajtaütéseid.' }
};

const LEADERBOARDS = {
  overall: { name: 'Legjobb játékos', key: 'xp' },
  wins: { name: 'Legtöbb győzelem', key: 'wins' },
  soap: { name: 'Legjobb Szappan', key: 'kills_soap' },
  grime: { name: 'Legjobb Kosz', key: 'kills_grime' },
  boss: { name: 'Főellenség-ölések', key: 'boss_kills' },
  territories: { name: 'Elfoglalt területek', key: 'territories_captured' },
  racer: { name: 'Legjobb versenyző', key: 'race_wins' },
  survival: { name: 'Túlélési rekord', key: 'survival_best' },
  season: { name: 'Évszak hozzájárulás', key: 'contribution', season: true }
};

module.exports = { RARITIES, ITEMS, CURRENCIES, DAILY_MISSIONS, WEEKLY_MISSIONS, ACHIEVEMENTS, TERRITORIES, BUILDINGS, LEADERBOARDS };
