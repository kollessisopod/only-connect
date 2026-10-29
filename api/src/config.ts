/**
 * Runtime configuration, read once from the environment and validated with zod.
 * The process fails fast with a readable message when something required is missing.
 */
import { z } from 'zod';

const nonEmpty = (name: string) => z.string().min(1, `${name} must not be empty`);

const optionalUrl = (name: string, message: string) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().url({ message }).optional()).describe(name);
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());

const base = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /**
   * Database driver (docs/DESKTOP.md §2): `pg` (Postgres, the compose deployment) or `pglite` (embedded
   * Postgres in WASM, data in PGLITE_DIR; the Windows app). Same SQL and migrations for both.
   */
  DATABASE_DRIVER: z.enum(['pg', 'pglite']).default('pg'),
  DATABASE_URL: optionalUrl('DATABASE_URL', 'DATABASE_URL must be a postgres:// URL'),
  /** Directory for the embedded database, or `memory://` (tests). Required with DATABASE_DRIVER=pglite. */
  PGLITE_DIR: optionalString,

  /** Object storage driver: `s3` (MinIO / any S3 bucket) or `fs` (files under MEDIA_DIR). */
  STORAGE_DRIVER: z.enum(['s3', 'fs']).default('s3'),
  S3_ENDPOINT: optionalUrl('S3_ENDPOINT', 'S3_ENDPOINT must be a http(s):// URL'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: optionalString,
  S3_SECRET_KEY: optionalString,
  S3_BUCKET: optionalString,
  /** Directory for media files. Required with STORAGE_DRIVER=fs; created on boot. */
  MEDIA_DIR: optionalString,

  /** When set, the API serves this built client directory as the SPA (no nginx; docs/DESKTOP.md §3.3). */
  SERVE_CLIENT_DIR: optionalString,

  ADMIN_USERNAME: nonEmpty('ADMIN_USERNAME'),
  ADMIN_PASSWORD: nonEmpty('ADMIN_PASSWORD'),
  JWT_SECRET: z.string().min(8, 'JWT_SECRET must be at least 8 characters'),

  /** Max upload size for /api/admin/media (bytes). */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  /** Max size of a pack bundle (.only-connect.zip) upload (bytes). */
  MAX_IMPORT_BYTES: z.coerce.number().int().positive().default(512 * 1024 * 1024),

  /**
   * Extra browser origins allowed to call the API / open sockets, comma separated (e.g. a separately hosted
   * front end). Same-origin requests (the normal nginx / Vite setup) are always allowed.
   */
  ALLOWED_ORIGINS: z.string().default(''),
});

/** Driver-dependent requirements: only the variables of the selected drivers are mandatory. */
const schema = base.superRefine((c, ctx) => {
  const need = (key: keyof typeof c, when: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${String(key)} is required with ${when}` });
  if (c.DATABASE_DRIVER === 'pg' && !c.DATABASE_URL) need('DATABASE_URL', 'DATABASE_DRIVER=pg');
  if (c.DATABASE_DRIVER === 'pglite' && !c.PGLITE_DIR) need('PGLITE_DIR', 'DATABASE_DRIVER=pglite');
  if (c.STORAGE_DRIVER === 's3') {
    for (const key of ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET'] as const) {
      if (!c[key]) need(key, 'STORAGE_DRIVER=s3');
    }
  }
  if (c.STORAGE_DRIVER === 'fs' && !c.MEDIA_DIR) need('MEDIA_DIR', 'STORAGE_DRIVER=fs');
});

export type Config = z.infer<typeof schema>;

/** The documented out-of-the-box credentials (SPEC §1); fine for a LAN game night, not for a public VM. */
export const DEFAULT_SECRET = '12346789';

/** Human-readable warnings about weak settings, printed at boot (never fatal: the defaults are documented). */
export function configWarnings(c: Config): string[] {
  const out: string[] = [];
  if (c.ADMIN_PASSWORD === DEFAULT_SECRET) out.push('ADMIN_PASSWORD is the documented default; change it in .env before exposing the app');
  if (c.JWT_SECRET === DEFAULT_SECRET || c.JWT_SECRET.length < 32) {
    out.push('JWT_SECRET is weak (use 32+ random characters, e.g. `openssl rand -base64 32`); anyone who guesses it can forge admin sessions');
  }
  if (c.STORAGE_DRIVER === 's3' && c.S3_SECRET_KEY === DEFAULT_SECRET) out.push('MINIO_ROOT_PASSWORD is the documented default');
  if (c.DATABASE_DRIVER === 'pg' && /:12346789@/.test(c.DATABASE_URL ?? '')) out.push('POSTGRES_PASSWORD is the documented default');
  return out;
}

/** Parsed `ALLOWED_ORIGINS`. */
export function allowedOrigins(c: Config): string[] {
  return c.ALLOWED_ORIGINS.split(',').map((s) => s.trim().replace(/\/$/, '')).filter((s) => s.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(
      `Invalid configuration. Check the root .env file / compose environment:\n${lines.join('\n')}`,
    );
  }
  return parsed.data;
}

let cached: Config | null = null;

/** Lazily loaded, process-wide config. */
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Replace the process-wide config (the embedded start builds it from options; docs/DESKTOP.md §4). */
export function setConfig(next: Config | null): void {
  cached = next;
}

/** Test helper: replace the cached config. */
export function setConfigForTests(next: Config | null): void {
  cached = next;
}
