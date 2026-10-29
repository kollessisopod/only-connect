/**
 * IPC contract between the Electron main process and the control window (docs/DESKTOP.md §6.4).
 * Channel names are `oc:<method>` (invoke) and `oc:status` / `oc:log` (push). Types only.
 */
import type { EmbeddedStats } from './embed';

export type { EmbeddedStats };

export type AddressKind = 'vpn' | 'lan' | 'other';
export interface Address { address: string; adapter: string; kind: AddressKind }
export interface Settings { port: number; adminUsername: string; adminPassword: string; jwtSecret: string; autoStart: boolean; preferredAddress: string | null }
export type ServerState =
  | { status: 'stopped' }
  | { status: 'starting' }
  | { status: 'running'; port: number; startedAt: number }
  | { status: 'stopping' }
  /** `port` is the port the start was attempted on (the saved port may have been edited since). */
  | { status: 'failed'; code: string | null; message: string; port: number };
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

/** Invoke channels, one per OcApi method that returns a promise. */
export const INVOKE_CHANNELS = {
  getStatus: 'oc:getStatus',
  start: 'oc:start',
  stop: 'oc:stop',
  restart: 'oc:restart',
  saveSettings: 'oc:saveSettings',
  selectAddress: 'oc:selectAddress',
  copy: 'oc:copy',
  openExternal: 'oc:openExternal',
  openDataDir: 'oc:openDataDir',
  allowFirewall: 'oc:allowFirewall',
  getLog: 'oc:getLog',
} as const;

/** Push channels (main → renderer). */
export const PUSH_CHANNELS = { status: 'oc:status', log: 'oc:log' } as const;
