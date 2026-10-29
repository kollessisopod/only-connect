# Only Connect without Docker — the Windows app (Version 4)

This document is the contract for Version 4: the same game served by **one portable Windows executable**
(`OnlyConnect-<version>.exe`, no installer, no Docker, no Node on the machine) while the Docker compose
deployment keeps working unchanged for a VM. Everything below is normative for the implementation; §9 lists
what is deliberately out of scope.

## 1. Shape

```
                    ┌──────────────────────── OnlyConnect.exe (Electron) ────────────────────────┐
browser ──:80──►    │  Fastify API (api/src, bundled)  ── PGlite (Postgres in WASM, files on disk) │
 /admin /monitor    │     ├─ serves client/dist (SPA)   ── media files on disk (fs object store)    │
 /wall /button      │     └─ socket.io                                                             │
                    │  Control window: status, addresses, links, settings, log                     │
                    └───────────────────────────────────────────────────────────────────────────────┘
```

* The API gains two **drivers** chosen by configuration: database `pg` (Postgres, as today) or `pglite`
  (embedded Postgres, `@electric-sql/pglite`, data in a directory), object storage `s3` (MinIO, as today) or
  `fs` (a directory). The SQL and the migrations stay identical for both database drivers (PGlite is a real
  Postgres 17), so no query is rewritten.
* The API can **serve the built client** itself (`SERVE_CLIENT_DIR`), replacing nginx when there is no Docker.
* A new workspace `desktop/` holds the Electron app. The API is bundled into it with esbuild and started
  **in the Electron main process** through `startEmbedded()` (§4). The control window talks to the main
  process over a small IPC contract (§6).
* Players still reach the machine over the network (LAN, Hamachi, NetBird, Tailscale, ZeroTier…): the
  window lists every usable address and builds the links from the one the host picks.
* Packs move between a Docker instance and the Windows app with the new **pack bundle** (`.only-connect.zip`,
  pack JSON + media, §5), exported and imported from the admin Packs page in both deployments.

Nothing in `packages/shared`, the game engine, the socket protocol or the screens changes behaviour.

## 2. Configuration (api/src/config.ts)

New variables (all optional for the compose deployment, whose defaults keep today's behaviour):

| variable | values | default | notes |
|---|---|---|---|
| `DATABASE_DRIVER` | `pg` \| `pglite` | `pg` | |
| `DATABASE_URL` | postgres URL | required when `pg` | unchanged |
| `PGLITE_DIR` | directory path or `memory://` | required when `pglite` | `memory://` is for tests only |
| `STORAGE_DRIVER` | `s3` \| `fs` | `s3` | |
| `S3_*` | | required when `s3` | unchanged |
| `MEDIA_DIR` | directory path | required when `fs` | created on boot |
| `SERVE_CLIENT_DIR` | directory path | unset | when set, the API serves this directory as the SPA (§3.3) |
| `MAX_IMPORT_BYTES` | bytes | `512 MiB` | cap for a pack bundle upload (§5) |

`configWarnings()` only warns about the drivers in use (no MinIO warning in `fs` mode, no Postgres password
warning in `pglite` mode). `loadConfig(env)` stays the single parser; `setConfigForTests` is kept and a
non-test alias `setConfig(c)` is added for the embedded start (§4).

## 3. API changes

### 3.1 Database facade — `api/src/db.ts` + `api/src/db/pg.ts` + `api/src/db/pglite.ts`

```ts
export interface QueryResult<T> { rows: T[]; rowCount: number | null }
export interface Queryable { query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> }
export interface Database extends Queryable {
  withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Apply api/migrations/*.sql in filename order (same files for both drivers). */
  migrate(log?: (msg: string) => void): Promise<MigrationResult>;
  close(): Promise<void>;
}
```

`db.ts` keeps its module-level API so callers do not change: `query()`, `withTransaction()`, `migrate()`,
`waitForDatabase()`, `migrationsDir()`, `closePool()` (now closes whichever driver is open; a `closeDatabase`
alias is added). Which driver is instantiated follows `config().DATABASE_DRIVER`. `repo.ts`'s
`type Queryable = Pick<PoolClient,'query'>` becomes the facade's `Queryable`. The migration runner moves into
the drivers (Postgres keeps the advisory lock; PGlite is single-process and skips it) and the migrations
directory becomes overridable (`setMigrationsDir(dir)`) because the desktop bundle ships the `.sql` files
outside the api package. Both drivers return the same row shapes (jsonb parsed, timestamptz as `Date`,
uuid as string, `count(*)::text` as string); a shared integration test (§7) proves it against the real
repositories.

### 3.2 Object store facade — `api/src/storage.ts` + `api/src/storage/s3.ts` + `api/src/storage/fs.ts`

`ObjectStore`, `ObjectStream`, `GetObjectOptions`, `PutResult`, `StorageNotFoundError`, `StorageRangeError`
stay in `storage.ts`; the S3 implementation moves to `storage/s3.ts`; `ensureBucket()` becomes
`ensureStorage()` (creates the bucket or the media directory; `ensureBucket` stays as an alias);
`defaultObjectStore()` picks the driver (`s3ObjectStore` is kept as a name for the S3 one).

`fs` store layout: `<MEDIA_DIR>/objects/<key>` holds the bytes, `<MEDIA_DIR>/meta/<key>.json` holds
`{ mime, size, createdAt }`. Keys are validated before touching the disk: `^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$`,
no `..` segment, max 200 chars; anything else throws `StorageNotFoundError` (never a path outside the
directory). A key whose path runs through an existing object (`a/b` when `a` is an object) is "not found" on
read/head/delete (`ENOTDIR` is treated like `ENOENT`, as S3 answers NoSuchKey) and throws
`StorageNotFoundError` on write (the two objects cannot both exist on a file system). Writes go to a temp file in the same directory then `rename`. `getObjectStream` honours
`Range: bytes=a-b` / `bytes=a-` / `bytes=-n` exactly like S3 does (206 semantics, `contentRange`, partial
`size`), throws `StorageRangeError` for unsatisfiable ranges; `etag` is `"<size>-<mtimeMs>"`,
`lastModified` the file mtime. `deleteObject` ignores missing files.

### 3.3 Serving the client — `SERVE_CLIENT_DIR`

When set, `createApp()` registers `@fastify/static` for that directory and a SPA fallback: any `GET`/`HEAD`
whose path is not under `/api/` or `/socket.io/` and has no file returns `index.html`. Headers mirror
`client/nginx/default.conf`: the same `Content-Security-Policy`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Cache-Control: no-cache` on HTML,
`public, max-age=604800` under `/assets/`, `public, max-age=2592000, immutable` under `/fonts/`. `/api/*`
keeps the JSON 404. Nothing changes when the variable is unset (compose keeps nginx).

### 3.4 Screen roles for statistics

The three public screens identify themselves when they open their socket: `io(url, { auth: { screen } })`
with `screen` ∈ `monitor` | `wall` | `button` (client side, wherever the public socket is created). The
server stores it in `SocketData.screen` (`'monitor' | 'wall' | 'button' | null`, anything else → null). It is
used for counting only, never for authorisation.

## 4. Embedded start — `api/src/embed.ts`

```ts
export interface EmbeddedOptions {
  port: number;                     // 1..65535
  host?: string;                    // default '0.0.0.0'
  dataDir: string;                  // PGLITE_DIR = <dataDir>/db, MEDIA_DIR = <dataDir>/media (created)
  clientDir: string;                // SERVE_CLIENT_DIR
  migrationsDir: string;            // where the .sql files are in this bundle
  adminUsername: string;
  adminPassword: string;
  jwtSecret: string;                // ≥ 8 chars
  logLevel?: string;                // default 'info'
  logStream?: NodeJS.WritableStream;// pino destination; default stdout
}
export interface EmbeddedStats {
  startedAt: number;                // epoch ms
  connections: { monitor: number; wall: number; button: number; other: number; admin: number };
  players: number;                  // players currently connected (public namespace sockets with a playerId)
  game: null | {
    phase: string;                  // GameState.phase
    pack: string | null;            // pack name
    teams: Array<{ id: string; name: string; score: number }>;  // active teams
  };
}
export interface EmbeddedServer {
  port: number;
  stats(): EmbeddedStats;
  onStatsChange(cb: (s: EmbeddedStats) => void): () => void;   // fired on connect/disconnect/state change, coalesced ≥ 250 ms
  close(): Promise<void>;                                       // idle store, close app + database; resolves when the port is free
}
/** Rejects with an Error whose `.code` is 'EADDRINUSE' or 'EACCES' when the port cannot be bound. */
export function startEmbedded(opts: EmbeddedOptions): Promise<EmbeddedServer>;
```

`server.ts` is refactored so the CLI `start()` and `startEmbedded()` share one `boot(app)` (migrate →
ensureStorage → seedDemo → store.load → GameTimer → attachSockets). `startEmbedded` installs no signal
handlers and never calls `process.exit`. It must be callable again after `close()` in the same process
(stop/start from the window).

## 5. Pack bundle (`.only-connect.zip`)

Zip layout (store or deflate, no directories required):

```
manifest.json   { "format": "only-connect-pack", "version": 1, "exportedAt": "<ISO>", "name": "<pack name>" }
pack.json       the Pack exactly as GET /api/admin/packs/:id/export returns it
media.json      [{ "key": "uploads/…", "mime": "image/png", "size": 1234, "originalName": "x.png" }, …]
media/<key>     one entry per key referenced by the pack (mediaKeysOf), including seed/ keys when referenced
```

Routes (admin JWT):

* `GET /api/admin/packs/:id/export.zip` → `application/zip`, `Content-Disposition: attachment; filename="<safe name>.only-connect.zip"`,
  streamed (yazl), media read from the object store; a missing object is skipped and listed in a
  `warnings` array inside `manifest.json` (`"warnings": ["media uploads/x not found"]`).
* `POST /api/admin/packs/import` keeps accepting the plain JSON body **and** now also accepts
  `multipart/form-data` with a `file` field holding either a `.only-connect.json` or a `.only-connect.zip`
  (sniffed by content: `PK\x03\x04` → zip; else JSON). Multipart limit `MAX_IMPORT_BYTES`.
  Zip import: validate `manifest.json` (`format`, `version === 1`), validate `pack.json` with
  `packInputSchema`, create the pack with a **new id** (same as JSON import), then for every `media/<key>`
  entry whose key passes the §3.2 key rule and is referenced by the pack: if the object already exists → skip
  (keys are content-unique uuids), else write it and insert the `media` row (`mime` from media.json,
  sniffed from magic bytes when missing; only image/* and audio/* are accepted — others are skipped with a
  warning). Entry names are normalised (`\` → `/`), entries with `..`, absolute paths or outside `media/` are
  ignored. Response `201 { pack, imported: n, skipped: n, warnings: string[] }` (the JSON-import response
  stays the bare `Pack` for compatibility; the zip one is wrapped). The import is all-or-nothing: when a media
  write fails after the pack was created, the pack and the objects / `media` rows written by this import are
  removed before the error is reported. A zip whose entry data does not match its headers (yauzl aborts the
  stream) and a key the fs store cannot hold (nested under another object) are `400 bad_bundle`; store or
  database failures stay 500.
* yauzl reads from the uploaded temp file (never fully in memory); per-entry size is capped at
  `MAX_UPLOAD_BYTES`, total at `MAX_IMPORT_BYTES`.

Admin Packs page: the existing **Export** becomes a small menu/two buttons: "Export JSON" (as today) and
"Export with media (.zip)"; **Import…** accepts `.json` and `.zip` and shows "Imported "<name>" (N media files)".
README "Export, import and backup" is rewritten around the bundle.

## 6. Desktop app — `desktop/`

Workspace `@only-connect/desktop` (added to the root `workspaces`). Electron ≥ 44 (pin an exact version at
least two weeks old), `electron-builder` 26, `esbuild`, `@electric-sql/pglite` as a runtime dependency (kept
outside the bundle and `asarUnpack`ed because of its `.wasm`/`.data` files).

### 6.1 Files

```
desktop/
  package.json            scripts: build (bundle api + copy client + compile main/preload/renderer), start (electron .), dist:win, test
  electron-builder.yml    appId com.onlyconnect.desktop, productName "Only Connect", win: portable x64, artifactName OnlyConnect-${version}.exe,
                          icon build/icon.ico (multi-size, generated from client/public/assets/only-connect-logo.png), asarUnpack pglite
  esbuild.mjs             bundles api/src/embed.ts → dist/server/api.mjs (externals: @electric-sql/pglite, pg, @aws-sdk/*), copies api/migrations → dist/server/migrations,
                          client/dist → dist/client, compiles src/main → dist/main, src/preload → dist/preload (cjs), src/renderer → dist/renderer
  src/shared/ipc.ts       the IPC contract below (types only)
  src/main/               main.ts (app lifecycle, single-instance lock, window), settings.ts, server.ts (start/stop wrapper), addresses.ts, firewall.ts, logs.ts
  src/preload/preload.ts  contextBridge.exposeInMainWorld('oc', …)
  src/renderer/           index.html, app.ts, styles.css (no framework; the app's dark-blue tokens from client/src/styles/tokens.css)
  test/                   vitest: addresses classification, settings load/save/defaults, url building
```

### 6.2 Data directory and settings

* Portable build: electron-builder sets `PORTABLE_EXECUTABLE_DIR`; the data directory is
  `<that>/OnlyConnect-data`. Otherwise (dev, Linux smoke test) `app.getPath('userData')/OnlyConnect-data`.
  Layout: `settings.json`, `db/` (PGlite), `media/`, `logs/server.log` (rotated at 5 MB, one previous file).
* `settings.json`: `{ "port": 80, "adminUsername": "admin", "adminPassword": "12346789", "jwtSecret": "<random 48 chars, generated on first run>", "autoStart": true, "preferredAddress": null }`.
  Missing keys fall back to defaults; a corrupt file is renamed `settings.broken-<ts>.json` and recreated.
* The port can be changed in the window; it is applied on the next (re)start.

### 6.3 Window behaviour (what the owner asked for)

One window, about 920×680, resizable, dark theme, `contextIsolation: true`, `nodeIntegration: false`:

1. **Status strip**: "Server running on port 80 since 14:02" / "Stopped" / "Failed: port 80 is in use" with
   Start / Stop / Restart buttons. On `EADDRINUSE` an inline action "Use port 8080 instead" sets the port and
   restarts. A failed state names the port the start was attempted on (`ServerState.port`), not the saved
   one. `EACCES` on Windows reads "Failed: port N is reserved by Windows or another service" (http.sys / IIS,
   Hyper-V or WSL excluded ranges; elevation does not help) with the same inline action; on other platforms it
   says the port needs administrator rights.
   The renderer only rebuilds a section's DOM when the inputs it is rendered from changed, so the 2 s status
   pushes never drop keyboard focus or a text selection.
2. **Addresses**: every IPv4 of `os.networkInterfaces()` that is not internal, each with the adapter name and
   a kind badge: `vpn` (adapter name matches /hamachi|netbird|tailscale|zerotier|wireguard|wt\d|tun\d/i, or
   the address is in 25.0.0.0/8, 5.0.0.0/8 (Hamachi), 100.64.0.0/10 (NetBird/Tailscale)), `lan` (10/8,
   172.16/12, 192.168/16), `other`. Adapters of virtual machines and containers on the host (name matches
   /vEthernet|Hyper-V|WSL|VirtualBox|VMware|vmnet|docker|br-|veth|Npcap|Bluetooth/i, or the address is in
   VirtualBox's 192.168.56.0/24) are `other` even in a private range: no player can reach them, so they must
   never become the default. The host picks the address the links are built from; the default is the
   saved `preferredAddress` if still present, else the first `vpn`, else the first `lan`. A note under the list
   speaks about the selected address: a `vpn` one is the address for remote players, an `other` one "works if
   your players can reach it", a `lan` one names the vpn address for remote players when there is one and
   otherwise says that only players on the same network can join; it always adds that the port must be
   reachable (firewall).
3. **Links**: four rows — Admin `/admin`, Monitor `/monitor`, Wall `/wall`, Buzzer `/button` — each with the
   full URL (`http://<address>/path`, the port omitted when it is 80), a **Copy** button (clipboard, shows
   "Copied" for 1.5 s) and an **Open** button (`shell.openExternal`). A fifth button copies the buzzer link
   with a one-line invitation ("Join the quiz: http://…/button").
4. **Live statistics**: screens connected (monitor / wall / phones / admin), players joined, current game
   phase and pack, active teams with scores; refreshed from `onStatsChange` and at least every 2 s.
5. **Settings**: port, admin username/password (password field with show/hide; also displayed next to the
   admin link as "login admin / ••••••••" with a reveal), "Open data folder", "Allow through Windows
   Firewall" (Windows only: runs `netsh advfirewall firewall add rule name="Only Connect" dir=in action=allow protocol=TCP localport=<port>`
   through `powershell Start-Process netsh -Verb RunAs -ArgumentList …` under `$ErrorActionPreference = 'Stop'`
   with a try/catch that exits 1223 (ERROR_CANCELLED) when the UAC prompt is declined, so a declined prompt is
   reported as such and never as "Rule added"; shows the outcome), "Start server when the app opens" toggle.
6. **Log**: the last 300 server log lines (collapsible), "Copy log".

Closing the window stops the server and quits (no tray). A second instance focuses the first.
All versions shown come from `app.getVersion()` (desktop/package.json `4.0.0`).
When the data directory cannot be created or written at start (exe in `C:\Program Files`, a read-only share…),
the app shows a `dialog.showErrorBox` naming the directory and asking to move the exe to a writable folder,
then quits; any other startup failure is shown the same way instead of exiting silently.

### 6.4 IPC contract (`desktop/src/shared/ipc.ts`)

```ts
export type AddressKind = 'vpn' | 'lan' | 'other';
export interface Address { address: string; adapter: string; kind: AddressKind }
export interface Settings { port: number; adminUsername: string; adminPassword: string; jwtSecret: string; autoStart: boolean; preferredAddress: string | null }
export type ServerState =
  | { status: 'stopped' }
  | { status: 'starting' }
  | { status: 'running'; port: number; startedAt: number }
  | { status: 'stopping' }
  | { status: 'failed'; code: string | null; message: string; port: number };   // port: the one the start was attempted on
export interface Status {
  version: string; dataDir: string; platform: NodeJS.Platform;
  server: ServerState; addresses: Address[]; selectedAddress: string | null;
  settings: Omit<Settings, 'jwtSecret'>; stats: EmbeddedStats | null;   // EmbeddedStats from api/src/embed.ts (copied type)
}
export interface Links { admin: string; monitor: string; wall: string; button: string }
export interface OcApi {
  getStatus(): Promise<Status>;
  onStatus(cb: (s: Status) => void): () => void;
  start(): Promise<void>; stop(): Promise<void>; restart(): Promise<void>;
  saveSettings(patch: Partial<Omit<Settings, 'jwtSecret'>>): Promise<Status>;
  selectAddress(address: string): Promise<Status>;
  copy(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;     // http/https only
  openDataDir(): Promise<void>;
  allowFirewall(): Promise<{ ok: boolean; message: string }>;
  getLog(): Promise<string[]>; onLog(cb: (line: string) => void): () => void;
}
declare global { interface Window { oc: OcApi } }
```

Channel names are `oc:<method>` (invoke) and `oc:status` / `oc:log` (push). The preload exposes exactly this
object; the renderer never receives Node objects.

### 6.5 Build and verification scripts

* `desktop` scripts: `build` (esbuild.mjs), `start` (`electron .` after build), `dist:win`
  (`electron-builder --win portable --x64`), `test` (vitest), `typecheck`.
* `scripts/dist-win.sh` — builds the Windows exe **in Docker** (`electronuserland/builder:wine`, cached
  volumes for npm, Electron and electron-builder downloads): `npm ci`, root `npm run build`, `npm run build -w desktop`,
  `npm run dist:win -w desktop`; output copied to `desktop/release/OnlyConnect-<version>.exe`. The same steps
  run on a Windows machine with Node 22 as `npm ci && npm run build && npm run build -w desktop && npm run dist:win -w desktop`.
* `scripts/desktop-smoke.sh` — Linux headless check of the real Electron app (Playwright's `_electron` in the
  Playwright image under `xvfb-run`, `--no-sandbox`): launches `desktop/dist/main/main.js` with a temp data
  dir and port 8089, waits for `status: running`, asserts `GET http://localhost:8089/api/health` → `{ok:true}`
  and that `/admin` returns the SPA HTML, clicks Copy on the buzzer link and reads the clipboard text back
  through the API, takes `window.png`, stops the server through the UI and checks the port is released.
* `scripts/standalone-e2e.sh` — runs the API the way the exe runs it but under plain Node in a container
  (`DATABASE_DRIVER=pglite STORAGE_DRIVER=fs SERVE_CLIENT_DIR=client/dist PORT=8089`, host network), then the
  existing `scripts/e2e/run.sh` with `BASE_URL=http://localhost:8089 RESTART_MODE=skip` for `demo`, `big` and
  `teams4`. Output under `$WORK/standalone-<scenario>`.

## 7. Tests

* `api/src/__tests__/standalone.test.ts` (vitest): `createApp` with real drivers — `PGLITE_DIR=memory://`,
  `STORAGE_DRIVER=fs` in a temp dir, `SERVE_CLIENT_DIR` pointing at a temp dir with an `index.html` — runs
  migrations, seeds the demo pack, lists packs, saves a game state and reloads it, uploads a media file and
  streams it back with and without a Range header, exports a bundle and imports it (round trip: same clues,
  new id, media present), and checks the SPA fallback and the headers of §3.3. This is the proof that both
  drivers behave the same.
* Existing api tests keep passing with the stubs; `db.test`-style unit tests for the key validation and the
  range parsing of the fs store.
* `desktop/test/*.test.ts`: address classification and ordering, settings defaults/corrupt file recovery,
  link building (port 80 omitted, IPv6 not listed).
* Scripts of §6.5 are run by the integration stage; the compose deployment is rebuilt and the `demo` e2e
  re-run to prove nothing regressed for Docker.

## 8. Documentation

* README: head line `> **Version 4 — <date> (uncommitted: …)**`; a new top-level section **"Windows app (no
  Docker)"** right after "Run it": download/build the exe, first start, firewall prompt, Hamachi/NetBird
  address, where data lives, how to move packs from the Docker version (bundle export/import), updating (replace
  the exe, keep the data folder), troubleshooting (port 80 busy, antivirus, nothing listed under VPN).
  "Export, import and backup" rewritten around the bundle. "Architecture" gets the driver table.
* SPEC: §2 architecture (drivers, desktop), §5 the new routes, §6 database drivers, a new **§11 Desktop app**
  that condenses §6 of this document. This file stays as the design record.
* `.env.example`: the new variables, commented, with the compose defaults.

## 9. Out of scope (do not build)

macOS/Linux desktop builds, an installer, auto-update, code signing, a tray icon, HTTPS, user accounts,
running the API as a Windows service, changing the game or the screens.
