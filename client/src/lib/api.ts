import type {
  AdminAction,
  ApiError as ApiErrorBody,
  GameState,
  LoginRequest,
  LoginResponse,
  MediaRef,
  Pack,
  PackSummary,
  PublicStateMessage,
} from '@only-connect/shared';

export const ADMIN_TOKEN_KEY = 'oc.admin.token';
/** Dispatched on `window` when an admin request is rejected with 401 (token expired / invalid). */
export const UNAUTHORIZED_EVENT = 'oc:unauthorized';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else window.localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) — the session simply won't persist */
  }
}

export function clearToken(): void {
  setToken(null);
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

async function parseError(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`.trim();
  let code: string | undefined;
  try {
    const body = (await res.json()) as Partial<ApiErrorBody> | { message?: string };
    if (body && typeof body === 'object') {
      if ('error' in body && typeof body.error === 'string') message = body.error;
      else if ('message' in body && typeof body.message === 'string') message = body.message;
      if ('code' in body && typeof body.code === 'string') code = body.code;
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, message, code);
}

async function request<T>(url: string, init: RequestInit = {}, auth = false): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (auth) {
    const token = getToken();
    if (!token) throw new ApiError(401, 'not logged in', 'no_token');
    headers.set('Authorization', `Bearer ${token}`);
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, credentials: 'same-origin' });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : 'network error', 'network');
  }
  if (res.status === 401 && auth) {
    clearToken();
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  };
}

/** Accepts "packs", "/packs" or a full "/api/admin/packs" and returns the absolute API path. */
function adminPath(path: string): string {
  if (path.startsWith('/api/')) return path;
  return `/api/admin/${path.replace(/^\/+/, '')}`;
}

// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------

export function getPublicState(): Promise<PublicStateMessage> {
  return request<PublicStateMessage>('/api/state', { cache: 'no-store' });
}

export function getHealth(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/health', { cache: 'no-store' });
}

// ---------------------------------------------------------------------------
// Admin endpoints (Bearer token from localStorage "oc.admin.token")
// ---------------------------------------------------------------------------

/** Logs in and stores the token. Throws ApiError(401) on bad credentials. */
export async function login(username: string, password: string): Promise<LoginResponse> {
  const body: LoginRequest = { username, password };
  const res = await request<LoginResponse>('/api/admin/login', jsonInit('POST', body));
  setToken(res.token);
  return res;
}

export function logout(): void {
  clearToken();
}

export function adminGet<T>(path: string): Promise<T> {
  return request<T>(adminPath(path), { cache: 'no-store' }, true);
}

export function adminPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(adminPath(path), jsonInit('POST', body), true);
}

export function adminPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(adminPath(path), jsonInit('PUT', body), true);
}

export function adminDelete<T = void>(path: string): Promise<T> {
  return request<T>(adminPath(path), { method: 'DELETE' }, true);
}

/** POST /api/admin/actions — returns the full authoritative GameState. */
export function sendAction(action: AdminAction): Promise<GameState> {
  return adminPost<GameState>('actions', action);
}

export function getAdminState(): Promise<GameState | null> {
  return adminGet<GameState | null>('state');
}

export function listPacks(): Promise<PackSummary[]> {
  return adminGet<PackSummary[]>('packs');
}

export function getPack(id: string): Promise<Pack> {
  return adminGet<Pack>(`packs/${encodeURIComponent(id)}`);
}

export function createPack(name: string): Promise<Pack> {
  return adminPost<Pack>('packs', { name });
}

export function savePack(pack: Pack): Promise<Pack> {
  return adminPut<Pack>(`packs/${encodeURIComponent(pack.id)}`, pack);
}

export function deletePack(id: string): Promise<void> {
  return adminDelete<void>(`packs/${encodeURIComponent(id)}`);
}

export function duplicatePack(id: string): Promise<Pack> {
  return adminPost<Pack>(`packs/${encodeURIComponent(id)}/duplicate`);
}

/** Multipart upload of an image or audio file (max 25 MB) to the bucket. */
export function uploadMedia(file: File | Blob, fileName?: string): Promise<MediaRef> {
  const form = new FormData();
  const name = fileName ?? (file instanceof File ? file.name : 'upload');
  form.append('file', file, name);
  return request<MediaRef>('/api/admin/media', { method: 'POST', body: form }, true);
}

/** Relative URL that streams a stored object through the API. */
export function mediaUrl(key: string): string {
  return `/api/media/${key.split('/').map(encodeURIComponent).join('/')}`;
}
