// Entry point kept for `node server.js` (systemd). The application now boots through the
// TypeScript composition root; the legacy wiring that lived here is reproduced exactly by
// src/app/Application.ts (see src/app/legacy/LegacyModuleRegistry.ts for the module order).
require('./src/app/main.ts');
