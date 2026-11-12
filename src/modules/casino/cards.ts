import { CasinoError } from './CasinoError.ts';
import type { Card, RandomInt, Rank, Suit } from './types.ts';

const SUITS: readonly Suit[] = ['♠', '♥', '♦', '♣'];
const RANKS: readonly Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

/** Video-poker payout multipliers per hand category. */
export const POKER_MULTIPLIERS = Object.freeze({
  royal: 250,
  straightFlush: 50,
  four: 25,
  fullHouse: 9,
  flush: 6,
  straight: 4,
  three: 3,
  twoPair: 2,
  jacks: 1,
  pair: 0,
  nothing: 0
});

export type PokerCategory = keyof typeof POKER_MULTIPLIERS;

/** A shuffled 52-card deck (Fisher-Yates); cards are drawn from the end. */
export function createDeck(randomInt: RandomInt): Card[] {
  const deck = SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    const card = deck[index];
    const other = deck[swapIndex];
    if (card && other) {
      deck[index] = other;
      deck[swapIndex] = card;
    }
  }
  return deck;
}

export function drawCard(deck: Card[]): Card {
  const card = deck.pop();
  if (!card) throw new CasinoError('Elfogyott a pakli.');
  return card;
}

function cardValue(card: Card): number {
  if (card.rank === 'A') return 11;
  if (card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') return 10;
  return Number(card.rank);
}

/** Blackjack total; aces count 1 instead of 11 while the hand would bust. */
export function handValue(hand: readonly Card[]): number {
  let total = hand.reduce((sum, card) => sum + cardValue(card), 0);
  let aces = hand.filter((card) => card.rank === 'A').length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

/** Category of a 5-card video-poker hand ("jacks" = a pair of jacks or better). */
export function pokerCategory(hand: readonly Card[]): PokerCategory {
  const counts = new Map<Rank, number>();
  for (const card of hand) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  const values = hand.map((card) => (card.rank === 'A' ? 14 : RANKS.indexOf(card.rank) + 2)).sort((a, b) => a - b);
  const groups = [...counts.values()].sort((a, b) => b - a);
  const flush = hand.every((card) => card.suit === hand[0]?.suit);
  const unique = [...new Set(values)];
  const straight = unique.length === 5 && ((unique[4] ?? 0) - (unique[0] ?? 0) === 4 || unique.join(',') === '2,3,4,5,14');

  if (flush && straight && values[0] === 10) return 'royal';
  if (flush && straight) return 'straightFlush';
  if (groups[0] === 4) return 'four';
  if (groups[0] === 3 && groups[1] === 2) return 'fullHouse';
  if (flush) return 'flush';
  if (straight) return 'straight';
  if (groups[0] === 3) return 'three';
  if (groups[0] === 2 && groups[1] === 2) return 'twoPair';
  if (groups[0] === 2) {
    const pairRank = [...counts].find(([, n]) => n === 2)?.[0];
    return pairRank === 'A' || pairRank === 'J' || pairRank === 'Q' || pairRank === 'K' ? 'jacks' : 'pair';
  }
  return 'nothing';
}
