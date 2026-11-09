// MiskolcEmpire: játéktartalom. Ez az egyetlen igazságforrás, a kliens az empire:get-content eseménnyel kéri le.
// A játékos számára látható szövegek magyarul vannak, az azonosítók angolul.

const TICK_HZ = 10;
const POP_CAP_MAX = 100;
const MAX_UNIT_IDS = 60;
const MAX_QUEUE = 5;
const RESOURCES = ['iron', 'copper', 'food', 'wood'];
const RESOURCE_INFO = {
  iron: { name: 'Vas', description: 'Diósgyőri vasművek nyomában: nyers vas.' },
  copper: { name: 'Réz & Arany', description: 'Csillog, mint a Tiszai pályaudvar tisztasági szombaton.' },
  food: { name: 'Kaja', description: 'Bográcsban fő, ha van mellé kenyér.' },
  wood: { name: 'Fa & Tégla', description: 'Kerítésnek, házikónak, tűzrevalónak.' }
};

const EPOCHS = [
  { id: 1, name: 'Telepi Kezdet', description: 'Kézikocsik, bicskák, egyszerű vasgyűjtés és fakerítések. Mindenki a saját portáját védi.', cost: {}, researchTime: 0, gather: 1, attack: 1, hp: 1 },
  { id: 2, name: 'Vasgyári Virágkor', description: 'Acélkocsik, vasvágók, szervezett telepek és kovácsműhelyek. A gyárkapu előtt sorban állnak.', cost: { food: 300, iron: 150 }, researchTime: 30, gather: 1.25, attack: 1.15, hp: 1.1 },
  { id: 3, name: 'Avasi Korszak', description: 'Mopedek, utcai bokszklubok, betonakadályok és megafonos propaganda. A panelek között visszhangzik a hangosbemondó.', cost: { food: 400, iron: 250, copper: 100 }, researchTime: 40, gather: 1.5, attack: 1.3, hp: 1.25 },
  { id: 4, name: 'Miskolci Nagyváros Kor', description: 'Lada-brigádok, szállító teherautók, hangrendszer-hadviselés és vaserődök. A dugó ellenére mindenki odaér.', cost: { food: 600, iron: 400, copper: 250 }, researchTime: 50, gather: 1.8, attack: 1.5, hp: 1.4 },
  { id: 5, name: 'Cyber-Miskolc', description: 'Kibernetikus vasdrónok, neon tuningautók és mágneses fémgyűjtők. A jövő is vasból lesz.', cost: { food: 800, iron: 600, copper: 500 }, researchTime: 60, gather: 2.2, attack: 1.8, hp: 1.6 }
];

// Sebzésszorzók támadó osztály -> célpont osztály szerint
const COUNTERS = {
  heavy: { light: 1.75 },
  ranged: { heavy: 1.75 },
  fastVehicle: { ranged: 1.75 },
  siege: { building: 3 },
  light: { siege: 2 }
};


const BUILDINGS = {
  townCenter: {
    name: 'Vajda Háza', description: 'A telep szíve: itt fő a bogrács, innen indul minden. Munkásokat képez, mindent átvesz és korszakot vált.',
    cost: { wood: 300, iron: 200, copper: 100 }, buildTime: 60, epoch: 2, size: 3, hp: 1500, sight: 10,
    trains: ['scavenger', 'builder', 'elder'], dropOff: ['iron', 'copper', 'food', 'wood'], popCap: 15, researches: true
  },
  scrapYard: {
    name: 'MÉH Telep', description: 'Vas és réz átvétele, mérlegelés, szó nélkül. Közelebb van, mint a Vajda Háza.',
    cost: { wood: 100 }, buildTime: 20, epoch: 1, size: 2, hp: 600, sight: 6, dropOff: ['iron', 'copper'], popCap: 0
  },
  house: {
    name: 'Viskó', names: [{ fromEpoch: 1, name: 'Viskó' }, { fromEpoch: 3, name: 'Lakótelepi lakás' }],
    description: 'Fedél a fej fölött, plusz hely a lakosoknak. Későbbi korszakban panelba költözik.',
    cost: { wood: 60 }, buildTime: 15, epoch: 1, size: 2, hp: 300, sight: 5, popCap: 8
  },
  tavern: {
    name: 'Kocsma', description: 'Itt toboroznak közelharcosokat. A törzsvendégek közelében gyorsabban megy a gyűjtés.',
    cost: { wood: 120, iron: 40 }, buildTime: 30, epoch: 1, size: 2, hp: 700, sight: 6, trains: ['knife', 'brawler'], popCap: 0, aura: { radius: 6, gather: 0.1 }
  },
  barracks: {
    name: 'Bódé', description: 'Lövészek és hétköznapi harcosok bódéja. Cigi nincs, csúzli van.',
    cost: { wood: 150, iron: 50 }, buildTime: 35, epoch: 1, size: 2, hp: 800, sight: 6, trains: ['slingshot', 'airgunner'], popCap: 0
  },
  workshop: {
    name: 'Sufni', description: 'Járművek és ostromgépek: ami nem fér be a garázsba, az itt készül.',
    cost: { wood: 150, iron: 100, copper: 50 }, buildTime: 40, epoch: 2, size: 2, hp: 800, sight: 6, trains: ['horseWagon', 'lada', 'grinder', 'ram'], popCap: 0
  },
  tower: {
    name: 'Őrtorony', description: 'Magas, vaskos, és automatikusan lövöldöz a betolakodókra.',
    cost: { wood: 80, iron: 100 }, buildTime: 30, epoch: 2, size: 1, hp: 500, sight: 10, popCap: 0,
    attack: 10, range: 8, cooldown: 1.5
  },
  fence: {
    name: 'Kerítés', description: 'Deszkakerítés. Nem állítja meg a szomszédot, de a támadót lassítja.',
    cost: { wood: 10 }, buildTime: 5, epoch: 1, size: 1, hp: 150, sight: 2, popCap: 0, barricade: true
  },
  wall: {
    name: 'Betonfal', description: 'Panelelemből öntve. Falat fúrni benne csak a legelszántabbaknak sikerül.',
    cost: { iron: 20, wood: 10 }, buildTime: 8, epoch: 3, size: 1, hp: 600, sight: 2, popCap: 0, barricade: true
  }
};

const UNITS = {
  scavenger: {
    name: 'Vasgyűjtő', description: 'Kétkerekű talicskával járja a telepet, és mindent hazahord, ami nincs odaszögezve.',
    cost: { food: 50 }, buildTime: 12, epoch: 1, producer: 'townCenter', hp: 40, attack: 3, range: 1, speed: 2.6, armor: 0, sight: 7, class: 'worker', cooldown: 1, capacity: 10
  },
  builder: {
    name: 'Építő Mester', description: 'Szerint a terv jó, csak a kivitelezés rossz. Épít és javít.',
    cost: { food: 40, wood: 30 }, buildTime: 14, epoch: 1, producer: 'townCenter', hp: 50, attack: 3, range: 1, speed: 2.4, armor: 0, sight: 7, class: 'worker', cooldown: 1, builds: true
  },
  knife: {
    name: 'Bicskás legény', description: 'Gyors, fürge könnyű közelharcos. A bicska ritkán jön egyedül.',
    cost: { food: 40, iron: 25 }, buildTime: 12, epoch: 1, producer: 'tavern', hp: 70, attack: 7, range: 1, speed: 3, armor: 0, sight: 7, class: 'light', cooldown: 1
  },
  brawler: {
    name: 'Boxerös Nehézfiú', description: 'Az utcai bokszklub büszkesége. Üt, mint a gyári kalapács, és nem könnyű megingatni.',
    cost: { food: 60, iron: 50 }, buildTime: 16, epoch: 2, producer: 'tavern', hp: 160, attack: 12, range: 1, speed: 2.4, armor: 0.3, sight: 7, class: 'heavy', cooldown: 1.2
  },
  slingshot: {
    name: 'Csúzlis kölyök', description: 'Messziről célzó, korai lövész. Az ablak mindig útban van.',
    cost: { food: 30, wood: 30 }, buildTime: 12, epoch: 1, producer: 'barracks', hp: 50, attack: 6, range: 6, speed: 2.8, armor: 0, sight: 9, class: 'ranged', cooldown: 1.2
  },
  airgunner: {
    name: 'Légpuskás', description: 'Közepes lövész légpuskával. A cél szerencsére mindig mozog.',
    cost: { iron: 30, copper: 30 }, buildTime: 15, epoch: 2, producer: 'barracks', hp: 65, attack: 10, range: 8, speed: 2.7, armor: 0, sight: 10, class: 'ranged', cooldown: 1.4
  },
  horseWagon: {
    name: 'Lókupec', description: 'Gyors szekér, jó felderítésre. Mindig tud valakit, aki tud valakit.',
    cost: { food: 40, wood: 60, copper: 30 }, buildTime: 18, epoch: 2, producer: 'workshop', hp: 110, attack: 8, range: 1.2, speed: 5, armor: 0, sight: 12, class: 'fastVehicle', cooldown: 1
  },
  lada: {
    name: 'Ladás Brigád', description: 'Hangos, gyors és kiszámíthatatlan roham. A szervizkönyv hiányzik, a lendület megvan.',
    cost: { iron: 70, copper: 50 }, buildTime: 22, epoch: 4, producer: 'workshop', hp: 220, attack: 16, range: 1.2, speed: 5.5, armor: 0.15, sight: 9, class: 'fastVehicle', cooldown: 1
  },
  grinder: {
    name: 'Flexes Kommandó', description: 'Szikrázó korongok: az épületeknek nincs esélyük.',
    cost: { iron: 60, copper: 60 }, buildTime: 20, epoch: 3, producer: 'workshop', hp: 90, attack: 14, range: 1.2, speed: 2.8, armor: 0, sight: 7, class: 'siege', cooldown: 1
  },
  ram: {
    name: 'Dugattyús Faltörő', description: 'Egy szó mint száz: falat, tornyot dönt. Lassú, de megállíthatatlan.',
    cost: { iron: 100, wood: 80 }, buildTime: 26, epoch: 3, producer: 'workshop', hp: 260, attack: 30, range: 1.3, speed: 1.8, armor: 0.2, sight: 7, class: 'siege', cooldown: 1.5
  },
  elder: {
    name: 'A Vajda', description: 'A telep vezére. Gyorsítja a gyűjtést, és tartást ad a közelében lévő embereknek.',
    cost: { food: 150, copper: 150 }, buildTime: 40, epoch: 3, producer: 'townCenter', hp: 250, attack: 10, range: 1, speed: 2.8, armor: 0.1, sight: 10, class: 'hero', cooldown: 1,
    hero: true, aura: { radius: 8, gather: 0.2, resist: 0.15 }
  }
};

const MAP_SIZES = { 2: 64, 3: 88, 4: 88 };
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'];
const NODE_KINDS = { iron: 'iron', copper: 'copper', food: 'food', wood: 'wood' };

const own = (obj, key) => typeof key === 'string' && key.length <= 40 && Object.prototype.hasOwnProperty.call(obj, key);
const isBuildingId = (id) => own(BUILDINGS, id);
const isUnitId = (id) => own(UNITS, id);

function getContent() {
  return JSON.parse(JSON.stringify({
    tickHz: TICK_HZ, popCapMax: POP_CAP_MAX, maxUnitIds: MAX_UNIT_IDS, maxQueue: MAX_QUEUE,
    resources: RESOURCE_INFO, epochs: EPOCHS, buildings: BUILDINGS, units: UNITS, counters: COUNTERS,
    mapSizes: MAP_SIZES, difficulties: DIFFICULTIES, colors: PLAYER_COLORS
  }));
}

module.exports = {
  TICK_HZ, POP_CAP_MAX, MAX_UNIT_IDS, MAX_QUEUE, RESOURCES, EPOCHS, COUNTERS, BUILDINGS, UNITS, MAP_SIZES,
  DIFFICULTIES, PLAYER_COLORS, NODE_KINDS, own, isBuildingId, isUnitId, getContent
};
