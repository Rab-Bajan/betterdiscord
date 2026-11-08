// Megnyitáskönyv: az "Elmélet" (Book) besorolás és a megnyitás neve.
// Az adat a lichess-org/chess-openings (CC0) alapján készül: node scripts/buildOpenings.js
let book = null;

function load() {
  if (!book) {
    try {
      book = require('./data/openings.json');
    } catch {
      book = {}; // ha hiányzik az adat, nincs "Elmélet" besorolás, de az elemzés működik
    }
  }
  return book;
}

// A fen első 3 mezője (állás, soron lévő, sáncjogok)
const keyOf = (fen) => fen.split(' ').slice(0, 3).join(' ');

function lookupOpening(fen) {
  const entry = load()[keyOf(fen)];
  return entry ? { eco: entry[0], name: entry[1] } : null;
}

const isBookFen = (fen) => lookupOpening(fen) !== null;

module.exports = { lookupOpening, isBookFen };
