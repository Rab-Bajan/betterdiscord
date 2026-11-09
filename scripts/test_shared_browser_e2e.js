const https = require('https');
const { io } = require('../../frontend/node_modules/socket.io-client');

const SERVER_URL = 'https://localhost:5000';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTest() {
  console.log('=== SharkVoic Közös Böngésző E2E Teszt Indítása ===');

  const client1 = io(SERVER_URL, {
    rejectUnauthorized: false,
    transports: ['websocket'],
    reconnection: false
  });

  const client2 = io(SERVER_URL, {
    rejectUnauthorized: false,
    transports: ['websocket'],
    reconnection: false
  });

  const cleanup = () => {
    try { client1.disconnect(); } catch (e) {}
    try { client2.disconnect(); } catch (e) {}
  };

  try {
    // 1. Kapcsolódás
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Kliens 1 csatlakozási időtúllépés')), 5000);
      client1.on('connect', () => {
        clearTimeout(timer);
        console.log('✓ Kliens 1 sikeresen csatlakozott a Socket szerverhez');
        resolve();
      });
      client1.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Kliens 2 csatlakozási időtúllépés')), 5000);
      client2.on('connect', () => {
        clearTimeout(timer);
        console.log('✓ Kliens 2 sikeresen csatlakozott a Socket szerverhez');
        resolve();
      });
    });

    // 2. Bejelentkezés user:join eseménnyel
    await new Promise((resolve) => {
      client1.once('init:data', (data) => {
        console.log('✓ Kliens 1 bejelentkezett és megkapta az init:data adatokat:', data?.self?.username);
        resolve();
      });
      client1.emit('user:join', { username: 'BöngészőTesztelő1' });
    });

    await new Promise((resolve) => {
      client2.once('init:data', (data) => {
        console.log('✓ Kliens 2 bejelentkezett és megkapta az init:data adatokat:', data?.self?.username);
        resolve();
      });
      client2.emit('user:join', { username: 'BöngészőTesztelő2' });
    });

    // 3. Belépés a 'voice-general' hangszobába
    const channelId = 'voice-general';
    client1.emit('voice:join', { channelId });
    client2.emit('voice:join', { channelId });
    await wait(500);
    console.log(`✓ Mindkét kliens csatlakozott a(z) ${channelId} hangcsatornához`);

    // 4. Böngésző indítása Kliens 1 által
    console.log('-> Böngésző indítása (Wikipedia)...');
    let framePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Nem érkezett képkocka időben')), 30000);
      client1.on('browser:frame', (frame) => {
        if (frame?.data && frame.data.length > 500) {
          clearTimeout(timeout);
          console.log(`✓ Képkocka (CDP screencast) sikeresen megérkezett! Méret: ${frame.data.length} byte`);
          resolve(frame);
        }
      });
    });

    client1.emit('browser:start', { channelId, initialUrl: 'https://en.wikipedia.org' });

    await framePromise;

    // 5. Kliens 2 belépése a böngésző nézetbe és állapot lekérése
    console.log('-> Kliens 2 böngésző állapot ellenőrzése...');
    let statePromise = new Promise((resolve) => {
      const handler = (state) => {
        if (state?.active) {
          client2.off('browser:state', handler);
          console.log(`✓ Kliens 2 megkapta az aktív állapotot: ${state.currentUrl}, nézők: ${state.viewerCount}`);
          resolve(state);
        }
      };
      client2.on('browser:state', handler);
      client2.emit('browser:get-state', { channelId });
    });

    client2.emit('browser:view-enter', { channelId });
    const sessionState = await statePromise;
    if (!sessionState.active) throw new Error('A böngésző nem aktív a Kliens 2 számára!');

    // 6. Kurzormozgás szinkronizálása
    console.log('-> Kurzormozgás tesztelése...');
    const cursorPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Kurzor nem érkezett meg Kliens 2-höz')), 5000);
      client2.on('browser:cursor-moved', (cursor) => {
        if (cursor.x === 640 && cursor.y === 360) {
          clearTimeout(timeout);
          console.log(`✓ Kurzormozgás szinkronizálva: (${cursor.x}, ${cursor.y}) - ${cursor.username}`);
          resolve();
        }
      });
    });

    client1.emit('browser:mouse-move', { channelId, x: 640, y: 360 });
    await cursorPromise;

    // 7. SSRF védelem tesztelése (belső hálózat blokkolása)
    console.log('-> SSRF védelem tesztelése (127.0.0.1 és privát IP blokkolása)...');
    const ssrfPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Nem érkezett hibaüzenet az SSRF kísérletre')), 5000);
      client1.on('browser:error', (err) => {
        clearTimeout(timeout);
        console.log(`✓ SSRF védelem sikeresen blokkolta a belső hálózati címet: "${err.message}"`);
        resolve();
      });
    });

    client1.emit('browser:navigate', { channelId, url: 'http://127.0.0.1:5000/api/status' });
    await ssrfPromise;

    // 8. Vezérlési módok tesztelése ('controller' mód)
    console.log('-> Vezérlési mód váltása: controller...');
    client1.emit('browser:set-mode', { channelId, mode: 'controller' });
    await wait(400);

    // Kliens 2 megpróbál navigálni Kliens 1 irányítása alatt -> hibaüzenetet kell kapnia
    const controllerBlockPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Nem érkezett blokkolási üzenet nem jogosult műveletre')), 5000);
      client2.on('browser:error', (err) => {
        clearTimeout(timeout);
        console.log(`✓ Irányítási korlátozás működik: "${err.message}"`);
        resolve();
      });
    });

    client2.emit('browser:navigate', { channelId, url: 'https://duckduckgo.com' });
    await controllerBlockPromise;

    // 9. Kliens 2 átveszi az irányítást
    console.log('-> Kliens 2 átveszi az irányítást...');
    const controlTakenPromise = new Promise((resolve) => {
      const handler = (state) => {
        if (state?.controller?.username === 'BöngészőTesztelő2') {
          console.log(`✓ Irányítás sikeresen átvéve Kliens 2 által (${state.controller.username})`);
          client2.off('browser:state', handler);
          resolve();
        }
      };
      client2.on('browser:state', handler);
    });

    client2.emit('browser:take-control', { channelId });
    await controlTakenPromise;

    // 10. Böngésző leállítása
    console.log('-> Böngésző leállítása...');
    const stopPromise = new Promise((resolve) => {
      client1.on('browser:state', (state) => {
        if (state === null) {
          console.log('✓ Böngésző munkamenet sikeresen leállítva minden kliensnél');
          resolve();
        }
      });
    });

    client2.emit('browser:stop', { channelId });
    await stopPromise;

    console.log('\n========================================');
    console.log('🎉 MINDEN SHARED BROWSER TESZT SIKERES! 🎉');
    console.log('========================================\n');
    cleanup();
    process.exit(0);
  } catch (err) {
    console.error('❌ Hiba a teszt futása során:', err);
    cleanup();
    process.exit(1);
  }
}

// Indítsuk a tesztet
runTest();
