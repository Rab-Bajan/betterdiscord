# SUDS WAR – development status

Original 3D team shooter inside the voice rooms: Soap Legion vs Grime Horde. All factions, characters and the map live in `content.js`.

## Architecture
- **Modes (`modes.js`):** each mode is hooks over one shared simulation, so adding a mode doesn't touch the core. **Persistent systems (`meta.js`, `catalog.js`):** economy, missions, clans, trades, war, seasons, bases, admin, each mutating operation in one SQLite transaction.
- **Backend (`game/`, Node + existing Socket.IO + existing SQLite):** `content.js` data, `physics.js` movement and rays, `simulation.js` the authoritative match (no I/O, unit-testable), `progression.js` XP, `store.js` tables and atomic rewards, `gameHandler.js` lobbies and match lifecycle.
- **Frontend (`src/game`, `src/components/game`):** Three.js renderer loaded only when the game is opened. `movement.js` is a copy of the server's movement for prediction; a test fails if they differ.
- **Networking:** clients send inputs only. 30 Hz simulation, 15 Hz snapshots, one queued input consumed per tick. Remote players are interpolated 130 ms behind, and hit tests rewind by the same amount.
- **Accounts:** only sessions with `authenticated === true` earn XP. Guests can play. `user:join` accepts a client-supplied `accountId`, so it is never trusted.
- **Database:** adds `game_profiles`, `game_matches`, `game_match_players`. Existing tables are untouched. A primary key on the match id prevents double rewards.

## Testing
`npm test` in the backend. Needs the frontend's `node_modules` for `socket.io-client`.

## Measured (bots on the dev machine, 16 cores, server and bots in one process)
See the last stage's report for numbers. Loopback only: real latency and packet loss are unmeasured, and client FPS on real GPUs is unmeasured.

## Checklist

**COMPLETED AND TESTED** (automated, and all seven modes in the real app with real login, voice join and WebGL on a software GPU)
- 7 modes: team deathmatch, infection, survival, boss, royale, racing, clan wars, each with lobby, rules, win and loss, results, rewards, statistics, cleanup
- Boss phases and attack patterns, difficulty, contribution; survival waves, boss waves, revives, records; royale zone, loot, hazards, spectate, placement; racing laps, checkpoints, nitro, items, mines, boosts, 2 tracks, shortcut; clan core, towers, nodes, resources
- Voice-room launch, banner, lobby, public and private lobbies, ready, countdown, balance, reconnect, abandon handling
- XP, levels, stats, match history, 4 currencies, shop, inventory, cosmetics, atomic trading with anti-scam, clans with ranks and chat, friends, blocks, reports
- Missions, achievements including secret ones, leaderboards, territories and battles, persistent seasons with archive and rewards, bases, raids, repairs
- Admin tools with audit log, suspensions, mode toggles; server-side validation, rate limits, duplicate-reward protection

**IMPLEMENTED BUT NOT FULLY TESTED**
- Team and proximity voice: only changes incoming volume; wired, but no two real people have tested it
- Low, High and Ultra graphics; custom key bindings; mobile joystick and touch buttons (no real device used)
- Lag compensation and prediction over a real network; 3D audio is code-reviewed only, headless has no audible output
- Fire and mouse look used a stubbed Pointer Lock in browser tests

**NOT IMPLEMENTED**
- Exploration: hidden locations, tunnels, puzzles, secret missions, collectibles found in the world, hidden world bosses
- Vehicles outside racing: military, flying, rocket vehicles, vehicle damage
- Skill-based and regional matchmaking, party system beyond friend invites, spectating outside royale
- Character levels and unlock requirements (all 6 characters are open), evolution paths, extra characters, dodge, secondary attack, first-person camera
- Interactive physics objects and destructible environments (only clan structures are destructible)
- Client FPS measurements, packet-loss testing, TypeScript and lint checks (the project has neither)
