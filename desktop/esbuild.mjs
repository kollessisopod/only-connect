/**
 * Build of the desktop workspace (docs/DESKTOP.md §6.1):
 *
 *   dist/server/api.mjs         esbuild bundle of api/src/embed.ts (externals: @electric-sql/pglite, pg, @aws-sdk/*)
 *   dist/server/chunks/         code-split chunks (the dynamically imported drivers)
 *   dist/server/migrations/     copy of api/migrations/*.sql (the bundle reads them through `migrationsDir`)
 *   dist/client/                copy of client/dist (served by the embedded API as the SPA)
 *   dist/main/main.js           Electron main process (ESM)
 *   dist/preload/preload.cjs    preload (CommonJS, as Electron requires)
 *   dist/renderer/              index.html, app.js (browser bundle), styles.css
 *
 * Run with `npm run build -w desktop` after `npm run build -w packages/shared` and `npm run build -w client`.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const dist = join(here, 'dist');

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

/** ESM output of CommonJS dependencies needs `require`, `__filename` and `__dirname` (fastify, pino, socket.io…). */
const nodeShimBanner = [
  "import { createRequire as __ocCreateRequire } from 'node:module';",
  "import { fileURLToPath as __ocFileURLToPath } from 'node:url';",
  "import { dirname as __ocDirname } from 'node:path';",
  'const require = __ocCreateRequire(import.meta.url);',
  'const __filename = __ocFileURLToPath(import.meta.url);',
  'const __dirname = __ocDirname(__filename);',
].join('\n');

function step(msg) {
  console.log(`[desktop build] ${msg}`);
}

function fail(msg) {
  console.error(`[desktop build] ERROR: ${msg}`);
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'server'), { recursive: true });

// 1. The API bundle -----------------------------------------------------------------------------------------
const embedEntry = join(repo, 'api', 'src', 'embed.ts');
const apiOut = join(dist, 'server', 'api.mjs');
if (existsSync(embedEntry)) {
  step('bundling api/src/embed.ts -> dist/server/api.mjs');
  await build({
    entryPoints: [embedEntry],
    // Code splitting: the drivers the api loads with a dynamic import() (db/pg, storage/s3, db/pglite…)
    // become their own chunks, so their external packages are imported only when that driver is selected.
    // Without it esbuild inlines them and hoists `import "pg"` to the top of api.mjs.
    outdir: join(dist, 'server'),
    entryNames: 'api',
    chunkNames: 'chunks/[name]-[hash]',
    outExtension: { '.js': '.mjs' },
    splitting: true,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // Kept outside the bundle: pglite ships .wasm/.data files it loads from its own directory; pg and the AWS
    // SDK are the compose drivers (loaded only when their driver is selected) plus ws' optional native addons.
    external: ['@electric-sql/pglite', 'pg', 'pg-native', '@aws-sdk/*', 'bufferutil', 'utf-8-validate'],
    banner: { js: nodeShimBanner },
    mainFields: ['module', 'main'],
    conditions: ['node'],
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });
  // A static import of a compose-only driver would make the exe fail at load (those packages are not shipped).
  const out = readFileSync(apiOut, 'utf8');
  const staticDriverImport = out.match(/^import\s[^\n]*\sfrom\s*["'](pg|@aws-sdk\/[^"']+)["'];?$/m);
  if (staticDriverImport) {
    console.warn(
      `[desktop build] WARNING: dist/server/api.mjs imports "${staticDriverImport[1]}" statically. ` +
        'That package is not part of the desktop runtime dependencies: load the pg / s3 drivers with a dynamic import() ' +
        'in the api, or add the package to desktop/package.json dependencies.',
    );
  }
  const chunkDir = join(dist, 'server', 'chunks');
  const chunks = existsSync(chunkDir) ? readdirSync(chunkDir) : [];
  step(`api bundle: ${(statSync(apiOut).size / 1024).toFixed(0)} KiB + ${chunks.length} chunk(s)`);
} else {
  // The api workspace does not provide the embedded entry point yet (docs/DESKTOP.md §4). The window still
  // builds and runs; starting the server fails with this message instead of a missing-module stack trace.
  console.warn('[desktop build] WARNING: api/src/embed.ts not found; writing a stub dist/server/api.mjs whose startEmbedded() rejects.');
  writeFileSync(
    apiOut,
    [
      '// STUB written by desktop/esbuild.mjs because api/src/embed.ts was missing at build time.',
      'export async function startEmbedded() {',
      "  const err = new Error('The embedded API bundle is missing: api/src/embed.ts did not exist when the desktop app was built. Rebuild with the api workspace in place.');",
      "  err.code = 'EMBED_MISSING';",
      '  throw err;',
      '}',
      '',
    ].join('\n'),
  );
}

// 2. Migrations ---------------------------------------------------------------------------------------------
const migrationsSrc = join(repo, 'api', 'migrations');
if (!existsSync(migrationsSrc)) fail(`${migrationsSrc} not found`);
const migrationsOut = join(dist, 'server', 'migrations');
mkdirSync(migrationsOut, { recursive: true });
const sqlFiles = readdirSync(migrationsSrc).filter((f) => f.endsWith('.sql')).sort();
for (const f of sqlFiles) cpSync(join(migrationsSrc, f), join(migrationsOut, f));
step(`copied ${sqlFiles.length} migration file(s)`);

// 3. The built client ---------------------------------------------------------------------------------------
const clientSrc = join(repo, 'client', 'dist');
if (!existsSync(join(clientSrc, 'index.html'))) {
  fail(`${clientSrc}/index.html not found: run "npm run build -w client" first`);
}
cpSync(clientSrc, join(dist, 'client'), { recursive: true });
step('copied client/dist -> dist/client');

// 4. Main process (ESM) -------------------------------------------------------------------------------------
await build({
  entryPoints: [join(here, 'src', 'main', 'main.ts')],
  outfile: join(dist, 'main', 'main.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['electron'],
  banner: { js: nodeShimBanner },
  sourcemap: 'inline',
  logLevel: 'warning',
});
step('compiled src/main -> dist/main/main.js');

// 5. Preload (CommonJS) -------------------------------------------------------------------------------------
await build({
  entryPoints: [join(here, 'src', 'preload', 'preload.ts')],
  outfile: join(dist, 'preload', 'preload.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'warning',
});
step('compiled src/preload -> dist/preload/preload.cjs');

// 6. Renderer -----------------------------------------------------------------------------------------------
await build({
  entryPoints: [join(here, 'src', 'renderer', 'app.ts')],
  outfile: join(dist, 'renderer', 'app.js'),
  bundle: true,
  platform: 'browser',
  target: 'chrome130',
  format: 'iife',
  sourcemap: false,
  logLevel: 'warning',
});
cpSync(join(here, 'src', 'renderer', 'index.html'), join(dist, 'renderer', 'index.html'));
cpSync(join(here, 'src', 'renderer', 'styles.css'), join(dist, 'renderer', 'styles.css'));
step('compiled src/renderer -> dist/renderer');

step(`done (version ${pkg.version})`);
