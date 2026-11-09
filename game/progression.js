// XP és szintek. Kizárólag a szerver által számolt meccsadatokból dolgozik.

const MAX_LEVEL = 100;
const MAX_MATCH_XP = 400;
const MIN_REWARD_SECONDS = 60;
const MIN_ACTIVE_SHARE = 0.5;

// Az L. szint eléréséhez szükséges összes XP
const xpForLevel = (level) => 50 * (level - 1) * level;

function levelFromXp(xp) {
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level += 1;
  return level;
}

function outcomeFor(team, winner) {
  if (!winner) return 'draw';
  return team === winner ? 'win' : 'loss';
}

function xpForMatch({ kills, assists, damage, bonusXp = 0 }, outcome) {
  const base = { win: 80, draw: 40, loss: 25 }[outcome];
  return Math.min(MAX_MATCH_XP, base + kills * 10 + assists * 4 + Math.floor(damage / 100) + bonusXp);
}

const sideOf = (p) => p.side ?? p.team;

// Jutalom csak valódi, végigjátszott meccsért jár: az üres vagy magát farmoló meccs nem számít
function isRewardable(result, player, minSeconds = MIN_REWARD_SECONDS) {
  if (result.reason === 'abandoned') return false;
  if (result.durationS < minSeconds) return false;
  if (!player.connected || player.activeShare < MIN_ACTIVE_SHARE) return false;
  if (result.pve) return true;
  return result.players.some((p) => p.i !== player.i && p.activeShare >= MIN_ACTIVE_SHARE && (result.ffa || result.mode === 'infection' || sideOf(p) !== sideOf(player)));
}

module.exports = { xpForLevel, levelFromXp, outcomeFor, xpForMatch, isRewardable, sideOf, MAX_LEVEL, MAX_MATCH_XP, MIN_REWARD_SECONDS };
