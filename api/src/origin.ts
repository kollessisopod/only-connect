/**
 * Browser origin policy for REST (CORS) and socket.io handshakes: same host as the request (the normal
 * nginx / Vite-proxy deployment), anything listed in ALLOWED_ORIGINS, and non-browser clients (no Origin
 * header) are allowed; everything else is refused. Ports are ignored on purpose: nginx forwards `Host`
 * without one, and the port is not what separates a third-party page from the app.
 */
export function originAllowed(origin: string | undefined, host: string | undefined, extra: readonly string[] = []): boolean {
  if (!origin || origin === 'null') return !origin; // no Origin = not a browser; "null" (sandboxed/file) = refuse
  const trimmed = origin.replace(/\/$/, '');
  if (extra.includes(trimmed)) return true;
  let originHost: string;
  try {
    originHost = new URL(trimmed).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  const requestHost = (bracketed ? bracketed[1] : host.replace(/:\d+$/, '')).toLowerCase();
  return originHost === requestHost;
}
