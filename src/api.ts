/**
 * HTTP 客户端：包装 fetch，自动注入 Bearer + 标准错误处理
 */
import kleur from 'kleur';
import { loadConfig } from './config.js';

export class CxApiError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
  }
}

interface RequestOpts {
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

export async function cxGet<T = unknown>(routePath: string, opts: RequestOpts = {}): Promise<T> {
  const cfg = loadConfig();
  if (!cfg.token) {
    throw new CxApiError(401, 'No PAT configured. Run: cx login');
  }

  const url = new URL(routePath.startsWith('http') ? routePath : `${cfg.baseUrl}${routePath}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  return doRequest<T>(url, cfg.token, opts.signal);
}

async function doRequest<T>(url: URL, token: string, signal?: AbortSignal, attempt = 1): Promise<T> {
  const maxAttempts = 4;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal,
    });
  } catch (err) {
    if (attempt < maxAttempts) {
      await sleep(2 ** (attempt - 1) * 500);
      return doRequest<T>(url, token, signal, attempt + 1);
    }
    throw new CxApiError(0, `Network error: ${(err as Error).message}`);
  }

  if (res.status === 401) {
    throw new CxApiError(401, 'Token invalid or expired. Run: cx login');
  }
  if (res.status === 403) {
    const body = await safeJson(res);
    throw new CxApiError(403, body?.error?.message ?? 'Permission denied');
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? '60');
    if (attempt === 1) {
      console.error(kleur.yellow(`Rate limited, retrying in ${retryAfter}s...`));
      await sleep(retryAfter * 1000);
      return doRequest<T>(url, token, signal, attempt + 1);
    }
    throw new CxApiError(429, 'Rate limited', retryAfter);
  }
  if (res.status >= 500 && attempt < maxAttempts) {
    await sleep(2 ** (attempt - 1) * 1000);
    return doRequest<T>(url, token, signal, attempt + 1);
  }
  if (!res.ok) {
    const body = await safeJson(res);
    throw new CxApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }

  return (await res.json()) as T;
}

async function safeJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return null; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
