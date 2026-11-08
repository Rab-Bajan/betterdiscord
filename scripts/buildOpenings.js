#!/usr/bin/env node
// Az "Elmélet" (Book) besoroláshoz használt megnyitás-adatbázis előállítása.
// Forrás: lichess-org/chess-openings (CC0). Futtatás: node scripts/buildOpenings.js
// Kimenet: analysis/data/openings.json  ->  { "<fen eleje>": [eco, név], ... }
const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');

const BASE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master/';

// A fen első 3 mezője (állás, soron lévő, sáncjogok): az en passant és a lépésszámok nem számítanak
const key = (fen) => fen.split(' ').slice(0, 3).join(' ');

(async () => {
  const out = {};
  let lines = 0;
  for (const file of ['a', 'b', 'c', 'd', 'e']) {
    const res = await fetch(`${BASE}${file}.tsv`);
    if (!res.ok) throw new Error(`${file}.tsv: HTTP ${res.status}`);
    const rows = (await res.text()).split('\n').slice(1).filter(Boolean);
    for (const row of rows) {
      const [eco, name, pgn] = row.split('\t');
      const chess = new Chess();
      try {
        chess.loadPgn(pgn);
      } catch {
        continue;
      }
      // Minden köztes állás is elméleti. A névadás szabálya:
      //  1) az az elnevezés nyer, amelynek a vonala EBBEN az állásban ér véget (pontos egyezés),
      //  2) pontos egyezések közt a rövidebb vonal nyer,
      //  3) köztes állás csak tartalék (a vonal nevét kapja), ha nincs pontos egyezés.
      const history = chess.history();
      const replay = new Chess();
      history.forEach((san, index) => {
        replay.move(san);
        const k = key(replay.fen());
        const exact = index === history.length - 1;
        const current = out[k];
        if (exact) {
          if (!current || !current.exact || history.length < current.plies) {
            out[k] = { eco, name, exact: true, plies: history.length };
          }
        } else if (!current) {
          out[k] = { eco, name, exact: false, plies: history.length };
        }
      });
      lines += 1;
    }
  }
  const target = path.join(__dirname, '..', 'analysis', 'data', 'openings.json');
  const compact = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [v.eco, v.name]]));
  fs.writeFileSync(target, JSON.stringify(compact));
  console.log(`${lines} megnyitás, ${Object.keys(compact).length} elméleti állás -> ${path.relative(process.cwd(), target)}`);
})().catch((e) => { console.error(e); process.exit(1); });
