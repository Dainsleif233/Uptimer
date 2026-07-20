// Ensures `apps/web/dist` exists with a placeholder index.html so `wrangler dev`
// can start with the `[assets]` binding before a real Vite build has run.
// In development the frontend is still served by the Vite dev server (:5173);
// this placeholder is only what the Worker would serve if hit directly on :8787.
// A real `vite build` overwrites dist/index.html, after which this script is a no-op.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

const indexFile = resolve(distDir, 'index.html');
if (!existsSync(indexFile)) {
  writeFileSync(
    indexFile,
    '<!doctype html><meta charset="utf-8"><title>Uptimer (dev)</title>' +
      '<body>Use the Vite dev server at http://localhost:5173</body>',
  );
}
