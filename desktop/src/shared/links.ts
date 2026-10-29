/**
 * Builds the four screen links from the address the host picked (docs/DESKTOP.md §6.3 item 3).
 * Pure functions shared by the main process and the renderer.
 */
import type { Links } from './ipc';

export const SCREEN_PATHS: Record<keyof Links, string> = {
  admin: '/admin',
  monitor: '/monitor',
  wall: '/wall',
  button: '/button',
};

/** `http://<address>` plus `:<port>` unless the port is 80. */
export function baseUrl(address: string, port: number): string {
  return port === 80 ? `http://${address}` : `http://${address}:${port}`;
}

export function buildLinks(address: string, port: number): Links {
  const base = baseUrl(address, port);
  return {
    admin: base + SCREEN_PATHS.admin,
    monitor: base + SCREEN_PATHS.monitor,
    wall: base + SCREEN_PATHS.wall,
    button: base + SCREEN_PATHS.button,
  };
}

/** The one-line invitation copied with the buzzer link. */
export function invitation(buttonUrl: string): string {
  return `Join the quiz: ${buttonUrl}`;
}
