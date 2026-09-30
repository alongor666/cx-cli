/**
 * HTTP 客户端：包装 fetch，自动注入 Bearer + 标准错误处理。
 * 顶层 import './http.js' 启用全局 undici dispatcher（keep-alive + HTTP/2）。
 */
import kleur from 'kleur';
import { attachTlsPersistence } from './http.js';
import { loadConfig } from './config.js';
import { buildApiUrl } from './url.js';

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
  /** 请求服务端返回与本次查询结果同一 cache/data epoch 的证据快照。 */
  analysisEvidence?: boolean;
  /** 显式凭据：cx login 校验候选 PAT 时使用，绕过（可能被 CX_PAT 覆盖的）已存配置。 */
  token?: string;
  baseUrl?: string;
}

export interface CxResponse<T> {
  data: T;
  /** 服务端审计中间件返回的 X-Request-Id，可用于关联 PM2/SQL 日志。 */
  requestId: string | null;
  /** base64url 编码的服务端原子证据快照；仅 analysisEvidence 请求返回。 */
  analysisEvidence: string | null;
}

/** --verbose 时由 index.ts 置 true：stderr 打印请求 URL 与耗时 */
export const apiDebug = { verbose: false };

export async function cxGet<T = unknown>(routePath: string, opts: RequestOpts = {}): Promise<T> {
  return (await cxGetWithMeta<T>(routePath, opts)).data;
}

/** 与 cxGet 相同，但保留响应头中的服务端 requestId，供 evidence 审计链使用。 */
export async function cxGetWithMeta<T = unknown>(
  routePath: string,
  opts: RequestOpts = {},
): Promise<CxResponse<T>> {
  const cfg = loadConfig();
  const token = opts.token ?? cfg.token;
  const baseUrl = opts.baseUrl ?? cfg.baseUrl;
  if (!token) {
    throw new CxApiError(401, 'No PAT configured. Run: cx login');
  }

  const url = buildApiUrl(baseUrl, routePath, opts.query);
  ensureTlsPersistence(url.host);

  let signal = opts.signal;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
    signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  }

  const startedAt = Date.now();
  try {
    return await doRequest<T>(url, token, signal, 1, Boolean(opts.analysisEvidence));
  } finally {
    if (apiDebug.verbose) {
      console.error(kleur.gray(`→ GET ${url} (${Date.now() - startedAt}ms)`));
    }
  }
}

async function doRequest<T>(
  url: URL,
  token: string,
  signal?: AbortSignal,
  attempt = 1,
  analysisEvidence = false,
): Promise<CxResponse<T>> {
  const maxAttempts = 4;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(analysisEvidence ? { 'X-Cx-Analysis-Evidence': '2' } : {}),
      },
      signal,
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new CxApiError(0, '请求超时/被中止（可用 --timeout 调整毫秒数）');
    }
    if (attempt < maxAttempts) {
      await sleep(2 ** (attempt - 1) * 500);
      return doRequest<T>(url, token, signal, attempt + 1, analysisEvidence);
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
    const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
    // 限流回退上限 10s — 防止单个请求等几十秒拖垮整个 batch；超出上限直接抛 429 让上层（如 cx batch）决策
    const capped = Math.min(retryAfter, 10);
    if (attempt === 1 && capped <= 5) {
      console.error(kleur.yellow(`Rate limited, retrying in ${capped}s...`));
      await sleep(capped * 1000);
      return doRequest<T>(url, token, signal, attempt + 1, analysisEvidence);
    }
    throw new CxApiError(429, `Rate limited (Retry-After ${retryAfter}s)`, retryAfter);
  }
  if (res.status >= 500 && attempt < maxAttempts) {
    await sleep(2 ** (attempt - 1) * 1000);
    return doRequest<T>(url, token, signal, attempt + 1, analysisEvidence);
  }
  if (!res.ok) {
    const body = await safeJson(res);
    throw new CxApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }

  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    // 典型场景：baseUrl 指向了网关/登录页，返回 200 HTML
    const type = res.headers.get('Content-Type') ?? 'unknown';
    throw new CxApiError(res.status, `服务端返回的不是 JSON（HTTP ${res.status}, Content-Type: ${type}）；请检查 baseUrl（cx config get baseUrl）`);
  }
  return {
    data,
    requestId: res.headers.get('X-Request-Id'),
    analysisEvidence: res.headers.get('X-Cx-Analysis-Evidence'),
  };
}

/**
 * Retry-After 可以是秒数或 HTTP-date（RFC 9110 §10.2.3）。
 * 缺失/无法解析时按 60s 处理；负数截为 0。
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number {
  if (header === null || header.trim() === '') return 60;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // HTTP-date 必含英文星期/月份；否则 V8 的宽松 Date.parse 会把 "1.5" 解析成 2001 年 → 立即重试
  if (!/[a-z]/i.test(trimmed)) return 60;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return 60;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

async function safeJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return null; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
