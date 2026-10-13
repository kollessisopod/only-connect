/**
 * Runtime configuration, read once from the environment and validated with zod.
 * The process fails fast with a readable message when something required is missing.
 */
import { z } from 'zod';

const nonEmpty = (name: string) => z.string().min(1, `${name} must not be empty`);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: nonEmpty('DATABASE_URL').url({ message: 'DATABASE_URL must be a postgres:// URL' }),

  S3_ENDPOINT: nonEmpty('S3_ENDPOINT').url({ message: 'S3_ENDPOINT must be a http(s):// URL' }),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: nonEmpty('S3_ACCESS_KEY'),
  S3_SECRET_KEY: nonEmpty('S3_SECRET_KEY'),
  S3_BUCKET: nonEmpty('S3_BUCKET'),

  ADMIN_USERNAME: nonEmpty('ADMIN_USERNAME'),
  ADMIN_PASSWORD: nonEmpty('ADMIN_PASSWORD'),
  JWT_SECRET: z.string().min(8, 'JWT_SECRET must be at least 8 characters'),

  /** Max upload size for /api/admin/media (bytes). */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

  /**
   * Extra browser origins allowed to call the API / open sockets, comma separated (e.g. a separately hosted
   * front end). Same-origin requests (the normal nginx / Vite setup) are always allowed.
   */
  ALLOWED_ORIGINS: z.string().default(''),
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
  if (c.S3_SECRET_KEY === DEFAULT_SECRET) out.push('MINIO_ROOT_PASSWORD is the documented default');
  if (/:12346789@/.test(c.DATABASE_URL)) out.push('POSTGRES_PASSWORD is the documented default');
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

/** Test helper: replace the cached config. */
export function setConfigForTests(next: Config | null): void {
  cached = next;
}
