# Játszma-elemzés (Chess.com import + Stockfish)

## Felépítés

| Fájl | Feladat |
|---|---|
| `chessComImport.js` | Chess.com link → PGN. URL-ellenőrzés (csak chess.com), `callback` JSON, TCN dekódolás, hivatalos PGN az archívum API-ból, ha elérhető |
| `engine.js` | Stockfish 19 (npm `stockfish`, WASM) gyerekfolyamatként, UCI protokollon |
| `classifier.js` | **Tiszta függvények**: pontszám → nyerési esély → besorolás. Minden küszöb a `CONFIG` objektumban |
| `analyzer.js` | Minden állás elemzése, áldozat- és taktika-felismerés, összegzés |
| `openings.js` + `data/openings.json` | „Elmélet” (Book) besorolás és megnyitásnév (lichess-org/chess-openings, CC0) |
| `jobManager.js` | Aszinkron feladatok: sor, haladás, megszakítás, eredmény-gyorsítótár |
| `routes.js` | REST végpontok |

## Végpontok

- `GET  /api/analysis/config` – határok, alapértékek
- `POST /api/analysis/import` – `{ url }` vagy `{ pgn }` → `{ pgn, game, source }`
- `POST /api/analysis/jobs` – `{ pgn, depth?, movetimeMs?, multipv?, engine? }` → `{ jobId }`
- `GET  /api/analysis/jobs/:id` – állapot, haladás, kész esetén az eredmény
- `DELETE /api/analysis/jobs/:id` – megszakítás

## Hogyan számolódik a besorolás

Nincs véletlen és nincs heurisztikus „tipp”: ugyanabból az engine-kimenetből mindig ugyanaz lesz az eredmény.

1. Minden állást a Stockfish értékel (alapból mélység 14, 3 vonal). A kiinduló és a lépések utáni állások mind sorra kerülnek.
2. A pontszámot nyerési esélyre váltjuk (lichess képlet). A **veszteség** = a legjobb vonal és a játszott lépés nyerési esélyének különbsége a lépő szemszögéből.
3. Küszöbök (százalékpont): Kiváló ≤ 2 · Jó ≤ 5 · Pontatlanság ≤ 10 · Hiba ≤ 20 · Baklövés > 20.
4. **Elmélet**: a lépés utáni állás szerepel a megnyitáskönyvben.
5. **Kihagyott matt**: volt kényszerített matt, a játszott lépés után már nincs.
6. **Kihagyott nyerés**: a legjobb vonal ≥ 75% nyerési esély, a játszott lépés után ≥ 15 ponttal kevesebb, de még nem vesztes (≥ 40%).
7. **Nagyszerű**: a játszott lépés a legjobb, a második vonal ≥ 12 ponttal rosszabb, az állás nem eldöntött, és nem puszta visszaütés.
8. **Zseniális**: (közel) legjobb lépés, ami valódi anyagáldozat – a vonal első *és* utolsó „nyugodt” pontján is ≥ 2 egységgel kevesebb anyag –, és az állás jó marad. Kényszerített mattot adó nagy áldozat (≥ 5) eldöntött állásban is zseniális.
9. **Kihagyott taktika** külön jelzés: kényszerített matt, vagy ≥ 2 egységnyi anyag, amit a legjobb vonal nyert volna.

A Chess.com pontos algoritmusa nem nyilvános, ezért a Zseniális / Nagyszerű / Kihagyott nyerés itt a fenti, engine-ből számolt definíciók szerint működik – a Chess.com jelöléseivel nem minden lépésnél egyezik.

## Megjegyzések

- A Chess.com `callback` végpontja nem hivatalos API: ha megváltozik vagy blokkolja a szervert, az import érthető hibát ad, és a PGN beillesztés mindig működik.
- Csak normál sakk (nincs Chess960 / változat).
- Egyszerre `concurrency` (alap: 1) elemzés fut, a többi sorban vár. Kliensenként legfeljebb 2 aktív feladat.
- Tesztek: `npm test` (osztályozó, anyagszámítás, TCN, URL, megnyitások – hálózat nélkül).
- A megnyitáskönyv újragenerálása: `npm run build:openings`.
