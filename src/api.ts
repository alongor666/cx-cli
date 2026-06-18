/**
 * HTTP 客户端：包装 fetch，自动注入 Bearer + 标准错误处理。
 * 顶层 import './http.js' 启用全局 undici dispatcher（keep-alive + HTTP/2）。
 */
import kleur from 'kleur';
import './http.js';
import { attachTlsPersistence } from './http.js';
import { loadConfig } from './config.js';

const tlsAttached = new Set<string>();
function ensureTlsPersistence(host: string): void {
  if (tlsAttached.has(host)) return;
  tlsAttached.add(host);
  attachTlsPersistence(host);
}

export class CxApiError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
  }
}

interface RequestOpts {
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** 单次请求超时（毫秒）。未设置时不限时（沿用网络层默认）。 */
  timeoutMs?: number;
}

/** --verbose 时由 index.ts 置 true：stderr 打印请求 URL 与耗时 */
export const apiDebug = { verbose: false };

export async function cxGet<T = unknown>(routePath: string, opts: RequestOpts = {}): Promise<T> {
  const cfg = loadConfig();
  if (!cfg.token) {
    throw new CxApiError(401, 'No PAT configured. Run: cx login');
  }

  const url = new URL(routePath.startsWith('http') ? routePath : `${cfg.baseUrl}${routePath}`);
  ensureTlsPersistence(url.host);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  let signal = opts.signal;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
    signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  }

  const startedAt = Date.now();
  try {
    return await doRequest<T>(url, cfg.token, signal);
  } finally {
    if (apiDebug.verbose) {
      console.error(kleur.gray(`→ GET ${url} (${Date.now() - startedAt}ms)`));
    }
  }
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
    const name = (err as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new CxApiError(0, '请求超时/被中止（可用 --timeout 调整毫秒数）');
    }
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
    // 限流回退上限 10s — 防止单个请求等几十秒拖垮整个 batch；超出上限直接抛 429 让上层（如 cx batch）决策
    const capped = Math.min(retryAfter, 10);
    if (attempt === 1 && capped <= 5) {
      console.error(kleur.yellow(`Rate limited, retrying in ${capped}s...`));
      await sleep(capped * 1000);
      return doRequest<T>(url, token, signal, attempt + 1);
    }
    throw new CxApiError(429, `Rate limited (Retry-After ${retryAfter}s)`, retryAfter);
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
