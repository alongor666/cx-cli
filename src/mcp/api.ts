/**
 * MCP server 内部 HTTP 客户端
 * 比 CLI 简化：所有错误转为 MCP 工具调用错误（throw Error），无重试 UI 提示。
 */
import { loadConfig } from '../config.js';
import { buildApiUrl } from '../url.js';

export interface McpConfig {
  baseUrl: string;
  token: string;
}

/**
 * 凭据与 cx 同源：CX_PAT / CX_BASE_URL 环境变量 > ~/.chexian/config.json（cx login 写入，0600）。
 * Agent 配置因此只需 `cx mcp`，不必把 PAT 抄进各家 mcpServers 的 env。
 * 缺令牌 / 前缀错误快速失败；错误文案绝不回显令牌。
 */
export function loadMcpConfig(): McpConfig {
  const { baseUrl, token } = loadConfig();
  if (!token) {
    throw new Error('Missing PAT: run `cx login` first (or set CX_PAT).');
  }
  if (!token.startsWith('cx_pat_')) {
    throw new Error('PAT must start with cx_pat_ (re-run `cx login`).');
  }
  return { baseUrl, token };
}

/**
 * 单次工具调用的 HTTP 超时：没有它，一个挂住的请求会让 Agent 的工具调用永久阻塞。
 * 取 120s 对齐网关 proxy_read_timeout（deploy/nginx-fullstack.conf）：再长也会先被网关切断，更短会误杀慢查询。
 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** setTimeout 上限（2^31−1 ms）：Node 下超出会溢出成立即超时 */
const MAX_TIMEOUT_MS = 2_147_483_647;

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
// 504 不重试：网关已等满 proxy_read_timeout，说明是慢查询——重试只会让服务端把同一个重查询再算两遍
const RETRYABLE_STATUS = new Set([502, 503]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function resolveTimeoutMs(env = process.env): number {
  const n = Number(env.CX_MCP_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 && n <= MAX_TIMEOUT_MS ? n : DEFAULT_TIMEOUT_MS;
}

export async function mcpGet<T = unknown>(
  cfg: McpConfig,
  routePath: string,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  // 与 CLI 共用 buildApiUrl：只允许 baseUrl 下的相对 path，拒绝 ../ 逃逸（参数来自 LLM，视为不可信）
  const url = buildApiUrl(cfg.baseUrl, routePath, query);
  const timeoutMs = resolveTimeoutMs();
  let res: Response | undefined;
  // 网络错误与 502/503 有限重试（GET 幂等）；超时与 504 不重试，避免把单次调用拖到数倍超时
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`API timeout after ${timeoutMs}ms (CX_MCP_TIMEOUT_MS 可调)`);
      }
      if (attempt >= MAX_ATTEMPTS) throw new Error(`Network error: ${(err as Error).message}`);
      await sleep(RETRY_BASE_MS * attempt);
      continue;
    }
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
      await res.body?.cancel().catch(() => {});
      await sleep(RETRY_BASE_MS * attempt);
      continue;
    }
    break;
  }
  if (!res.ok) {
    let body: any = null;
    try { body = await res.json(); } catch { /* ignore */ }
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    // 带 status：调用方按状态码判断（如 401/403 不走缓存兜底），不去匹配错误文案
    throw Object.assign(new Error(`API ${res.status}: ${msg}`), { status: res.status });
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`API ${res.status}: 响应不是 JSON（Content-Type: ${res.headers.get('Content-Type') ?? 'unknown'}）`);
  }
}
