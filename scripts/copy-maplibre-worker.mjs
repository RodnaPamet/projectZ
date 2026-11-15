// The clubs map's worker (#697), copied next to the app's static files.
//
// maplibre-gl starts its tile worker from `maplibre-gl-worker.mjs` NEXT TO its
// own module. Bundled, its module is a hashed chunk under /_next/static, with
// no worker beside it, and the map stays blank ("Worker failed to load"). So
// the worker is served from /maplibre/ and ClubsMap names it there
// (`setWorkerUrl`). It is a build output, copied from node_modules on every
// `dev` and `build`, never committed: it follows the installed maplibre-gl.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('maplibre-gl/package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));
const from = join(dirname(pkgPath), 'dist', 'maplibre-gl-worker.mjs');
const to = join(process.cwd(), 'public', 'maplibre', 'maplibre-gl-worker.mjs');

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`maplibre-gl ${version} worker -> public/maplibre/`);
