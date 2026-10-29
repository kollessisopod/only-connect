/**
 * Server log: a Writable the embedded API's pino logger writes to. Each JSON line becomes one readable line
 * ("14:02:11 INFO  message"), kept in a 300-line ring buffer for the window and appended to
 * <dataDir>/logs/server.log (rotated at 5 MB, one previous file). docs/DESKTOP.md §6.2 / §6.3 item 6.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';

export const LOG_LINES = 300;
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

const LEVELS: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Turns one pino JSON line into a human line; non-JSON input is passed through trimmed. */
export function formatLogLine(line: string, now: () => number = Date.now): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return `${formatTime(now())} ${trimmed}`;
  try {
    const rec = JSON.parse(trimmed) as Record<string, unknown>;
    const time = typeof rec.time === 'number' ? rec.time : now();
    const level = typeof rec.level === 'number' ? LEVELS[rec.level] ?? String(rec.level) : 'INFO';
    let msg = typeof rec.msg === 'string' ? rec.msg : '';
    const req = rec.req as { method?: string; url?: string } | undefined;
    const res = rec.res as { statusCode?: number } | undefined;
    if (req && typeof req.method === 'string') msg = `${req.method} ${req.url ?? ''} ${msg}`.trim();
    if (res && typeof res.statusCode === 'number') {
      const ms = typeof rec.responseTime === 'number' ? ` ${rec.responseTime.toFixed(0)}ms` : '';
      msg = `${res.statusCode}${ms} ${msg}`.trim();
    }
    if (rec.err && typeof rec.err === 'object') {
      const err = rec.err as { message?: string; code?: string };
      msg = `${msg}${msg ? ' — ' : ''}${err.code ? `${err.code}: ` : ''}${err.message ?? ''}`;
    }
    if (!msg) {
      const rest = { ...rec };
      for (const k of ['level', 'time', 'pid', 'hostname', 'v']) delete rest[k];
      msg = JSON.stringify(rest).slice(0, 300);
    }
    return `${formatTime(time)} ${level.padEnd(5)} ${msg}`;
  } catch {
    return `${formatTime(now())} ${trimmed}`;
  }
}

export class LogBuffer {
  private lines: string[] = [];
  private listeners = new Set<(line: string) => void>();
  private fileBytes = 0;
  private readonly file: string | null;

  constructor(dataDir: string | null) {
    this.file = dataDir ? join(dataDir, 'logs', 'server.log') : null;
    if (this.file) {
      try {
        mkdirSync(join(dataDir!, 'logs'), { recursive: true });
        this.fileBytes = existsSync(this.file) ? statSync(this.file).size : 0;
      } catch {
        this.fileBytes = 0;
      }
    }
  }

  /** The last LOG_LINES lines, oldest first. */
  all(): string[] {
    return [...this.lines];
  }

  onLine(cb: (line: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Adds an already formatted line. */
  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES);
    for (const cb of this.listeners) cb(line);
    this.appendToFile(line);
  }

  /** Adds a line from the desktop app itself (not from the server). */
  note(msg: string): void {
    this.push(`${formatTime(Date.now())} APP   ${msg}`);
  }

  /** A Writable to hand to pino (EmbeddedOptions.logStream). */
  stream(): NodeJS.WritableStream {
    let pending = '';
    return new Writable({
      decodeStrings: false,
      write: (chunk: string | Buffer, _enc, cb) => {
        pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let nl = pending.indexOf('\n');
        while (nl >= 0) {
          const raw = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          if (raw.trim()) this.push(formatLogLine(raw));
          nl = pending.indexOf('\n');
        }
        cb();
      },
      final: (cb) => {
        if (pending.trim()) this.push(formatLogLine(pending));
        pending = '';
        cb();
      },
    });
  }

  private appendToFile(line: string): void {
    if (!this.file) return;
    try {
      const bytes = Buffer.byteLength(line) + 1;
      if (this.fileBytes + bytes > LOG_ROTATE_BYTES) {
        const previous = `${this.file}.1`;
        rmSync(previous, { force: true });
        if (existsSync(this.file)) renameSync(this.file, previous);
        this.fileBytes = 0;
      }
      appendFileSync(this.file, line + '\n', 'utf8');
      this.fileBytes += bytes;
    } catch {
      // The log file is best effort; the window still shows the ring buffer.
    }
  }
}
