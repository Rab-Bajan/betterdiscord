// HTTP végpontok: státusz, sebességteszt, fájlfeltöltés/-letöltés, statikus frontend
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { users, textChannels, voiceChannels } = require('./state');

function setupApiRoutes(app) {
  app.get('/api/status', (req, res) => {
    res.json({
      status: 'online',
      protocol: 'https',
      usersOnline: users.size,
      textChannels,
      voiceChannels
    });
  });

  // Speed Test végpontok
  const speedTestSample = Buffer.alloc(1024 * 1024, 'x'); // 1MB minta adat

  // Letöltési sebesség mérése
  app.get('/api/speedtest/download', (req, res) => {
    const mb = Math.min(Math.max(parseInt(req.query.mb) || 3, 1), 10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Length', mb * 1024 * 1024);

    for (let i = 0; i < mb; i++) {
      res.write(speedTestSample);
    }
    res.end();
  });

  // Feltöltési sebesség mérése
  app.post('/api/speedtest/upload', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
    const bytes = req.body ? req.body.length : 0;
    res.setHeader('Cache-Control', 'no-store, no-cache');
    res.json({
      status: 'ok',
      receivedBytes: bytes,
      timestamp: Date.now()
    });
  });

  // Fájlfeltöltések (Multer tároló) beállítása
  const uploadsDir = path.resolve(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      let originalName = file.originalname;
      try {
        originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      } catch (e) {}
      const ext = path.extname(originalName);
      const base = path.basename(originalName, ext).replace(/[^a-zA-Z0-9_\-]/g, '_') || 'file';
      const unique = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${base}${ext}`;
      cb(null, unique);
    }
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: 100 * 1024 * 1024 // 100 MB max fájlméret
    }
  });

  // Feltöltött fájlok statikus kiszolgálása
  app.use('/uploads', express.static(uploadsDir));

  // Fájlfeltöltés végpont (Drag & drop és tallózó gomb)
  app.post('/api/upload', upload.array('files', 10), (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Nincs feltöltött fájl.' });
      }

      const files = req.files.map((file) => {
        let originalName = file.originalname;
        try {
          originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        } catch (e) {}

        return {
          id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          filename: file.filename,
          originalName: originalName,
          size: file.size,
          mimeType: file.mimetype,
          url: `/uploads/${encodeURIComponent(file.filename)}`,
          downloadUrl: `/api/download/${encodeURIComponent(file.filename)}?name=${encodeURIComponent(originalName)}`
        };
      });

      console.log(`[Upload] Sikeres feltöltés: ${files.length} db fájl`);
      res.json({ ok: true, files });
    } catch (err) {
      console.error('[Upload Hiba]:', err);
      res.status(500).json({ error: 'Hiba történt a fájlok mentésekor.' });
    }
  });

  // Fájlletöltés végpont (eredeti névvel letöltés kényszerítése)
  app.get('/api/download/:filename', (req, res) => {
    const filename = path.basename(decodeURIComponent(req.params.filename));
    const filePath = path.join(uploadsDir, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).send('A kért fájl nem található a szerveren.');
    }

    const customName = req.query.name ? String(req.query.name) : filename;
    const safeAsciiName = customName.replace(/[^\x20-\x7E]/g, '_');
    const encodedName = encodeURIComponent(customName);

    res.setHeader('Content-Disposition', `attachment; filename="${safeAsciiName}"; filename*=UTF-8''${encodedName}`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('[Download Stream Error]:', err);
      if (!res.headersSent) res.status(500).send('Hiba történt a fájl olvasásakor.');
    });
    stream.pipe(res);
  });
}

// Az elkészült frontend kiszolgálása (frontend/dist vagy backend/public). Utolsóként kell regisztrálni.
function serveFrontend(app) {
  const frontendDist = path.resolve(__dirname, '../frontend/dist');
  const backendPublic = path.resolve(__dirname, 'public');
  const staticRoot = fs.existsSync(frontendDist) ? frontendDist : (fs.existsSync(backendPublic) ? backendPublic : null);
  if (!staticRoot) return;

  console.log(`[Static] Statikus frontend fájlok kiszolgálása innen: ${staticRoot}`);
  app.use(express.static(staticRoot));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/socket.io') || req.path.startsWith('/api') || req.path.startsWith('/casino')) {
      return next();
    }
    const indexHtml = path.join(staticRoot, 'index.html');
    if (fs.existsSync(indexHtml)) res.sendFile('index.html', { root: staticRoot });
    else next();
  });
}

module.exports = { setupApiRoutes, serveFrontend };
