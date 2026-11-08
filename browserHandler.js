const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { validateAndSanitizeUrl } = require('./browserSecurity');

// Keresünk telepített Google Chrome vagy Chromium futtatható állományt
function getChromeExecutablePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidatePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];

  for (const p of candidatePaths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

const DEFAULT_URL = 'https://en.wikipedia.org';
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 perc üresjárat után automatikus leállítás

module.exports = function setupBrowserHandler(io, app, users) {
  // channelId -> Session
  const sessions = new Map();

  const chromePath = getChromeExecutablePath();
  if (!chromePath) {
    console.warn('[SharedBrowser] Figyelem: Nem található telepített Google Chrome a gépen! A Shared Browser funkció nem fog tudni elindulni.');
  } else {
    console.log(`[SharedBrowser] Használt Chrome elérési út: ${chromePath}`);
  }

  const usernameOf = (socket) => users.get(socket.id)?.username || 'Felhasználó';
  const colorOf = (socket) => users.get(socket.id)?.avatarColor || '#7655F5';
  const isInRoom = (socket, channelId) => users.get(socket.id)?.voiceChannel === channelId;

  function toPublicState(session) {
    if (!session) return null;
    const viewersList = Array.from(session.viewers.entries()).map(([id, info]) => ({
      id,
      username: info.username,
      color: info.color
    }));

    return {
      channelId: session.channelId,
      active: session.active,
      currentUrl: session.currentUrl,
      title: session.title,
      isLoading: session.isLoading,
      controlMode: session.controlMode,
      controller: session.controller,
      startedBy: session.startedBy,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      viewers: viewersList,
      viewerCount: viewersList.length
    };
  }

  function broadcastState(channelId) {
    const session = sessions.get(channelId);
    const pub = toPublicState(session);
    io.to(channelId).emit('browser:state', pub);
    io.emit('browser:session-updated', { channelId, state: pub });
  }

  function resetIdleTimer(session) {
    if (!session) return;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.viewers.size === 0) {
      session.idleTimer = setTimeout(() => {
        console.log(`[SharedBrowser] Inaktivitási időkorlát lejárt a(z) ${session.channelId} szobában, böngésző leállítása...`);
        destroySession(session.channelId);
      }, IDLE_TIMEOUT_MS);
    }
  }

  function canInteract(session, socketId) {
    if (!session || !session.active) return false;
    if (session.controlMode === 'free') return true;
    return session.controller?.id === socketId;
  }

  async function createBrowserSession(channelId, initialUrl, socket) {
    if (sessions.has(channelId)) {
      return sessions.get(channelId);
    }

    if (!chromePath) {
      throw new Error('A szerveren nem található futtatható Google Chrome böngésző.');
    }

    const check = await validateAndSanitizeUrl(initialUrl || DEFAULT_URL);
    if (!check.valid) {
      throw new Error(check.reason || 'Érvénytelen kezdőoldal URL cím.');
    }

    const startingUrl = check.url;
    const username = usernameOf(socket);

    console.log(`[SharedBrowser] Böngésző indítása a(z) ${channelId} szobához... Kezdőoldal: ${startingUrl}`);

    const browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      defaultViewport: {
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
        deviceScaleFactor: 1
      },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--mute-audio',
        `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`
      ]
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

    // SSRF védelem az átirányítások (redirect) ellen is
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      if (req.isNavigationRequest()) {
        const targetUrl = req.url();
        const navCheck = await validateAndSanitizeUrl(targetUrl);
        if (!navCheck.valid) {
          console.warn(`[SharedBrowser SSRF] Blokkolt navigáció (${targetUrl}): ${navCheck.reason}`);
          return req.abort('accessdenied');
        }
      }
      req.continue();
    });

    // Felugró párbeszédablakok automatikus kezelése, hogy a böngésző ne akadjon el
    page.on('dialog', async (dialog) => {
      try {
        await dialog.dismiss();
      } catch (err) {}
    });

    const cdpSession = await page.target().createCDPSession();

    const session = {
      channelId,
      browser,
      page,
      cdpSession,
      currentUrl: startingUrl,
      title: 'Böngésző betöltése...',
      isLoading: true,
      controlMode: 'free',
      controller: null,
      startedBy: username,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      viewers: new Map(),
      lastFrame: null,
      idleTimer: null,
      active: true,
      destroyed: false
    };

    sessions.set(channelId, session);

    // CDP Screencast indítása
    await cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: VIEWPORT_WIDTH,
      maxHeight: VIEWPORT_HEIGHT,
      everyNthFrame: 1
    });

    cdpSession.on('Page.screencastFrame', async (params) => {
      if (session.destroyed) return;
      try {
        // Nyugtázás a CDP felé a következő képkocka fogadásához
        await cdpSession.send('Page.screencastFrameAck', { sessionId: params.sessionId });
      } catch (e) {}

      session.lastFrame = {
        data: params.data,
        metadata: params.metadata,
        timestamp: Date.now()
      };

      io.to(channelId).emit('browser:frame', {
        data: params.data,
        metadata: params.metadata
      });
    });

    // Lap események követése
    page.on('framenavigated', async (frame) => {
      if (frame === page.mainFrame()) {
        session.currentUrl = frame.url();
        try {
          session.title = await page.title();
        } catch (e) {}
        broadcastState(channelId);
      }
    });

    page.on('load', async () => {
      session.isLoading = false;
      session.currentUrl = page.url();
      try {
        session.title = await page.title();
      } catch (e) {}
      broadcastState(channelId);
    });

    browser.on('disconnected', () => {
      if (!session.destroyed) {
        destroySession(channelId);
      }
    });

    // Kezdőoldal betöltése
    page.goto(startingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => {
      console.warn(`[SharedBrowser] Betöltési hiba (${startingUrl}):`, err.message);
      session.isLoading = false;
      broadcastState(channelId);
    });

    resetIdleTimer(session);
    broadcastState(channelId);

    return session;
  }

  async function destroySession(channelId) {
    const session = sessions.get(channelId);
    if (!session) return;

    session.destroyed = true;
    session.active = false;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    sessions.delete(channelId);

    try {
      if (session.cdpSession) {
        await session.cdpSession.detach().catch(() => {});
      }
      if (session.page) {
        await session.page.close().catch(() => {});
      }
      if (session.browser) {
        await session.browser.close().catch(() => {});
      }
    } catch (err) {
      console.error('[SharedBrowser] Hiba a munkamenet lezárásakor:', err.message);
    }

    io.to(channelId).emit('browser:state', null);
    io.emit('browser:session-updated', { channelId, state: null });
    console.log(`[SharedBrowser] Munkamenet sikeresen leállítva a(z) ${channelId} szobában.`);
  }

  // Socket.IO eseménykezelők
  io.on('connection', (socket) => {
    // Állapot lekérése + legutóbbi képkocka
    socket.on('browser:get-state', ({ channelId } = {}) => {
      if (!channelId) return;
      const session = sessions.get(channelId);
      socket.emit('browser:state', toPublicState(session));
      if (session?.lastFrame) {
        socket.emit('browser:frame', session.lastFrame);
      }
    });

    // Böngésző fül megnyitása / belépés nézőként
    socket.on('browser:view-enter', ({ channelId } = {}) => {
      if (!channelId || !isInRoom(socket, channelId)) return;
      const session = sessions.get(channelId);
      if (session) {
        session.viewers.set(socket.id, {
          username: usernameOf(socket),
          color: colorOf(socket),
          joinedAt: Date.now()
        });
        resetIdleTimer(session);
        broadcastState(channelId);
        if (session.lastFrame) {
          socket.emit('browser:frame', session.lastFrame);
        }
      }
    });

    // Böngésző fül elhagyása
    socket.on('browser:view-leave', ({ channelId } = {}) => {
      if (!channelId) return;
      const session = sessions.get(channelId);
      if (session && session.viewers.has(socket.id)) {
        session.viewers.delete(socket.id);
        resetIdleTimer(session);
        broadcastState(channelId);
      }
    });

    // Új közös böngésző indítása
    socket.on('browser:start', async ({ channelId, initialUrl } = {}) => {
      if (!channelId || !isInRoom(socket, channelId)) {
        return socket.emit('browser:error', { message: 'Csak a hangcsatornában lévő tagok indíthatnak böngészőt.' });
      }

      try {
        let session = sessions.get(channelId);
        if (!session) {
          session = await createBrowserSession(channelId, initialUrl, socket);
        }
        session.viewers.set(socket.id, {
          username: usernameOf(socket),
          color: colorOf(socket),
          joinedAt: Date.now()
        });
        resetIdleTimer(session);
        broadcastState(channelId);
      } catch (err) {
        console.error('[SharedBrowser] Indítási hiba:', err.message);
        socket.emit('browser:error', { message: err.message });
      }
    });

    // URL Navigáció
    socket.on('browser:navigate', async ({ channelId, url } = {}) => {
      const session = sessions.get(channelId);
      if (!session || !isInRoom(socket, channelId)) return;
      if (!canInteract(session, socket.id)) {
        return socket.emit('browser:error', { message: 'Jelenleg a kiválasztott irányító vezérelheti a böngészőt.' });
      }

      const check = await validateAndSanitizeUrl(url);
      if (!check.valid) {
        return socket.emit('browser:error', { message: check.reason || 'Érvénytelen URL cím!' });
      }

      session.isLoading = true;
      session.lastActiveAt = Date.now();
      broadcastState(channelId);

      try {
        await session.page.goto(check.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        console.warn(`[SharedBrowser] Navigációs figyelmeztetés (${check.url}):`, err.message);
      } finally {
        session.isLoading = false;
        session.currentUrl = session.page.url();
        try {
          session.title = await session.page.title();
        } catch (e) {}
        broadcastState(channelId);
      }
    });

    // Előre / Vissza / Újratöltés
    socket.on('browser:back', async ({ channelId } = {}) => {
      const session = sessions.get(channelId);
      if (!session || !isInRoom(socket, channelId) || !canInteract(session, socket.id)) return;
      try {
        await session.page.goBack();
      } catch (e) {}
    });

    socket.on('browser:forward', async ({ channelId } = {}) => {
      const session = sessions.get(channelId);
      if (!session || !isInRoom(socket, channelId) || !canInteract(session, socket.id)) return;
      try {
        await session.page.goForward();
      } catch (e) {}
    });

    socket.on('browser:reload', async ({ channelId } = {}) => {
      const session = sessions.get(channelId);
      if (!session || !isInRoom(socket, channelId) || !canInteract(session, socket.id)) return;
      session.isLoading = true;
      broadcastState(channelId);
      try {
        await session.page.reload({ waitUntil: 'domcontentloaded' });
      } catch (e) {}
      session.isLoading = false;
      broadcastState(channelId);
    });

    // Reset böngésző alaphelyzetbe
    socket.on('browser:reset', async ({ channelId } = {}) => {
      const session = sessions.get(channelId);
      if (!session || !isInRoom(socket, channelId) || !canInteract(session, socket.id)) return;
      session.isLoading = true;
      broadcastState(channelId);
      try {
        await session.page.goto(DEFAULT_URL, { waitUntil: 'domcontentloaded' });
      } catch (e) {}
      session.isLoading = false;
      broadcastState(channelId);
    });

    // Egérmozgás szinkronizálás + CDP diszpécselés
    socket.on('browser:mouse-move', async ({ channelId, x, y } = {}) => {
      const session = sessions.get(channelId);
      if (!session || !isInRoom(socket, channelId)) return;

      // Kurzormozgás közvetítése a többi nézőnek (felhasználónév és szín kíséretében)
      socket.to(channelId).emit('browser:cursor-moved', {
        userId: socket.id,
        username: usernameOf(socket),
        color: colorOf(socket),
        x,
        y
      });

      // Ha az adott felhasználó jogosult a vezérlésre, a CDP-ben is mozgatjuk az egeret
      if (canInteract(session, socket.id) && typeof x === 'number' && typeof y === 'number') {
        try {
          await session.cdpSession.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: Math.round(x),
            y: Math.round(y)
          });
        } catch (e) {}
      }
    });

    // Egérkattintás
    socket.on('browser:mouse-click', async ({ channelId, x, y, button = 'left', clickCount = 1 } = {}) => {
      const session = sessions.get(channelId);
      if (!session || !isInRoom(socket, channelId) || !canInteract(session, socket.id)) return;
      if (typeof x !== 'number' || typeof y !== 'number') return;

      session.lastActiveAt = Date.now();
      const btn = button === 'right' || button === 2 ? 'right' : (button === 'middle' || button === 1 ? 'middle' : 'left');

      try {
        await session.cdpSession.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: Math.round(x),
          y: Math.round(y),
          button: btn,
          clickCount
        });
        await session.cdpSession.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: Math.round(x),
          y: Math.round(y),
          button: btn,
          clickCount
        });
      } catch (e) {}
    });

    // Görgetés (Scroll / Mouse Wheel)
    socket.on('browser:scroll', async ({ channelId, x = 640, y = 360, deltaX = 0, deltaY = 0 } = {}) => {
      const session = sessions.get(channelId);
      if (!session || !isInRoom(socket, channelId) || !canInteract(session, socket.id)) return;

      session.lastActiveAt = Date.now();
      try {
        await session.cdpSession.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.round(x),
          y: Math.round(y),
          deltaX: Math.round(deltaX),
          deltaY: Math.round(deltaY)
        });
      } catch (e) {}
    });

    // Billentyűzet leütések
    socket.on('browser:key', async ({ channelId, type = 'keydown', key, code, text, keyCode, modifiers } = {}) => {
      const session = sessions.get(channelId);
      if (!session || !isInRoom(socket, channelId) || !canInteract(session, socket.id)) return;

      session.lastActiveAt = Date.now();
      try {
        if (type === 'char' || text) {
          await session.cdpSession.send('Input.dispatchKeyEvent', {
            type: 'char',
            text: text || key
          });
        } else {
          const cdpType = type === 'keyup' ? 'keyUp' : (type === 'keydown' ? 'rawKeyDown' : 'keyDown');
          await session.cdpSession.send('Input.dispatchKeyEvent', {
            type: cdpType,
            key,
            code,
            windowsVirtualKeyCode: keyCode || 0,
            modifiers: modifiers || 0
          });
        }
      } catch (e) {}
    });

    // Szöveg beillesztése (pl. vágólapról vagy közvetlen begépeléskor)
    socket.on('browser:insert-text', async ({ channelId, text } = {}) => {
      const session = sessions.get(channelId);
      if (!session || !isInRoom(socket, channelId) || !canInteract(session, socket.id)) return;
      if (!text || typeof text !== 'string') return;

      session.lastActiveAt = Date.now();
      try {
        await session.cdpSession.send('Input.insertText', { text });
      } catch (e) {}
    });

    // Mód váltás: 'free' (bárki) vs 'controller' (egy kijelölt irányító)
    socket.on('browser:set-mode', ({ channelId, mode } = {}) => {
      const session = sessions.get(channelId);
      if (!session || !isInRoom(socket, channelId)) return;
      if (mode !== 'free' && mode !== 'controller') return;

      session.controlMode = mode;
      if (mode === 'controller' && !session.controller) {
        session.controller = {
          id: socket.id,
          username: usernameOf(socket),
          color: colorOf(socket)
        };
      }
      broadcastState(channelId);
    });

    // Irányítás átvétele
    socket.on('browser:take-control', ({ channelId } = {}) => {
      const session = sessions.get(channelId);
      if (!session || !isInRoom(socket, channelId)) return;

      session.controller = {
        id: socket.id,
        username: usernameOf(socket),
        color: colorOf(socket)
      };
      broadcastState(channelId);
    });

    // Irányítás elengedése
    socket.on('browser:release-control', ({ channelId } = {}) => {
      const session = sessions.get(channelId);
      if (!session || !isInRoom(socket, channelId)) return;

      if (session.controller?.id === socket.id) {
        session.controller = null;
        broadcastState(channelId);
      }
    });

    // Böngésző leállítása
    socket.on('browser:stop', async ({ channelId } = {}) => {
      if (!channelId || !isInRoom(socket, channelId)) return;
      await destroySession(channelId);
    });

    // Felhasználó lecsatlakozásakor karbantartás
    socket.on('disconnect', () => {
      for (const [channelId, session] of sessions.entries()) {
        let changed = false;
        if (session.viewers.has(socket.id)) {
          session.viewers.delete(socket.id);
          resetIdleTimer(session);
          changed = true;
        }
        if (session.controller?.id === socket.id) {
          session.controller = null;
          changed = true;
        }
        if (changed) {
          broadcastState(channelId);
        }
      }
    });
  });

  return {
    getBrowserSessions: () =>
      Object.fromEntries([...sessions].map(([id, s]) => [id, toPublicState(s)])),
    getBrowserSession: (channelId) => toPublicState(sessions.get(channelId)),
    destroySession
  };
};
