import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The Chrome/Chromium executable to use (legacy browserHandler.js `getChromeExecutablePath`):
 * the configured CHROME_PATH when it exists, else the first existing well-known location.
 */
export function findChromeExecutable(
  configured: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
  exists: (file: string) => boolean = existsSync
): string | null {
  if (configured && exists(configured)) return configured;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['PROGRAMFILES'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];
  return candidates.find((p) => p && exists(p)) ?? null;
}
