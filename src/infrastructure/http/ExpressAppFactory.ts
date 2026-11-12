import { createRequire } from 'node:module';
import express from 'express';
import type { Express, RequestHandler } from 'express';

/** The subset of the `cors` package options legacy server.js passes. */
interface CorsOptions {
  origin: string;
  methods: string[];
}

// `cors` ships no types and @types/cors is not installed; its default export is this factory.
const cors = createRequire(import.meta.url)('cors') as (options: CorsOptions) => RequestHandler;

/** JSON body limit: PGN uploads for the analysis import are larger than usual. */
export const JSON_BODY_LIMIT = '512kb';

/** CORS settings shared by Express and socket.io (legacy server.js). */
export const CORS_OPTIONS: Readonly<CorsOptions> = Object.freeze({ origin: '*', methods: ['GET', 'POST'] });

/** Express app with the legacy global middleware, in order: cors, then the JSON body parser. */
export function createExpressApp(): Express {
  const app = express();
  app.use(cors({ origin: CORS_OPTIONS.origin, methods: [...CORS_OPTIONS.methods] }));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  return app;
}
