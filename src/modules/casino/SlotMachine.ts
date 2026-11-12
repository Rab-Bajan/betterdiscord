import { CasinoError } from './CasinoError.ts';
import type { CasinoAccount, RandomInt, Rig } from './types.ts';

/** Reel symbols with their weight (out of 100) and three-of-a-kind multiplier. `✨` is the bonus. */
const SLOT_SYMBOLS = Object.freeze([
  { emoji: '🍒', weight: 30, multiplier: 5 },
  { emoji: '🍋', weight: 25, multiplier: 4 },
  { emoji: '🍇', weight: 20, multiplier: 6 },
  { emoji: '💎', weight: 13, multiplier: 10 },
  { emoji: '⭐', weight: 8, multiplier: 15 },
  { emoji: '✨', weight: 4, multiplier: 0 }
]);
const BONUS = '✨';
const SYMBOL_EMOJIS = SLOT_SYMBOLS.map((s) => s.emoji);
const MAX_RIG_SPINS = 1000;
const FREE_SPINS_BONUS = 5;

export interface SpinOutcome {
  result: string[];
  winnings: number;
  message: string;
  freeSpinsWon: number;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
const isSymbol = (value: unknown): value is string => typeof value === 'string' && SYMBOL_EMOJIS.includes(value);

/** Validates an admin rig (legacy `normalizeRig`); null/undefined clears it. Throws CasinoError when invalid. */
export function normalizeRig(rig: unknown): Rig | null {
  if (!rig) return null;
  const spins = Math.min(Math.max(Number(field(rig, 'spins')) || 1, 1), MAX_RIG_SPINS);
  const mode = field(rig, 'mode');
  const symbols = field(rig, 'symbols');
  const first: unknown = Array.isArray(symbols) ? symbols[0] : field(symbols, '0');
  if (mode === 'jackpot') {
    return { mode: 'jackpot', symbols: [isSymbol(first) && first !== BONUS ? first : '⭐'], spins };
  }
  if (mode === 'bonus' || mode === 'lose') return { mode, spins };
  if (mode === 'symbols' && Array.isArray(symbols) && symbols.length === 3 && symbols.every(isSymbol)) {
    return { mode: 'symbols', symbols, spins };
  }
  throw new CasinoError('Érvénytelen pörgetés-beállítás.');
}

/** The slot machine (legacy casinoHandler.js `casino:slot`). */
export class SlotMachine {
  readonly #randomInt: RandomInt;

  constructor(randomInt: RandomInt) {
    this.#randomInt = randomInt;
  }

  /** Spins once for `bet` (already paid); an active rig on the account decides the reels. */
  spin(account: CasinoAccount, bet: number): SpinOutcome {
    const result = this.#takeRiggedResult(account) ?? [this.#reel(), this.#reel(), this.#reel()];
    const bonusCount = result.filter((symbol) => symbol === BONUS).length;
    if (bonusCount === 3) {
      return { result, winnings: 0, message: `BÓNUSZ! ${FREE_SPINS_BONUS} ingyenes pörgetést nyertél!`, freeSpinsWon: FREE_SPINS_BONUS };
    }
    if (result[0] === result[1] && result[1] === result[2]) {
      const winnings = bet * (SLOT_SYMBOLS.find((s) => s.emoji === result[0])?.multiplier ?? 0);
      return { result, winnings, message: `JACKPOT! ${winnings} kredit nyeremény.`, freeSpinsWon: 0 };
    }
    if (bonusCount === 2) {
      const winnings = bet * 2;
      return { result, winnings, message: `Két ✨! +${winnings} kredit.`, freeSpinsWon: 0 };
    }
    return { result, winnings: 0, message: 'Most nem nyertél. Próbáld újra!', freeSpinsWon: 0 };
  }

  #reel(): string {
    let selection = this.#randomInt(100);
    for (const symbol of SLOT_SYMBOLS) {
      selection -= symbol.weight;
      if (selection < 0) return symbol.emoji;
    }
    return SYMBOL_EMOJIS[0] ?? '🍒';
  }

  /** Consumes one rigged spin, if any. */
  #takeRiggedResult(account: CasinoAccount): string[] | null {
    const rig = account.rig;
    if (!rig || rig.spins <= 0) return null;
    rig.spins -= 1;
    if (rig.spins <= 0) account.rig = null;
    switch (rig.mode) {
      case 'jackpot': return Array<string>(3).fill(rig.symbols[0] || '⭐');
      case 'bonus': return [BONUS, BONUS, BONUS];
      case 'lose': return ['🍒', '🍋', '🍇'];
      case 'symbols': return rig.symbols;
    }
  }
}
