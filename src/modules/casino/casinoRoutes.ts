import express from 'express';
import type { Express } from 'express';

/** Serves the standalone casino page (legacy casinoHandler.js): static files and `/casino` -> index.html. */
export function mountCasinoRoutes(app: Express, casinoDir: string): void {
  app.use('/casino', express.static(casinoDir));
  app.get('/casino', (_req, res) => {
    res.sendFile('index.html', { root: casinoDir });
  });
}
