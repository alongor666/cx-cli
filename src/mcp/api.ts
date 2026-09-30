/**
 * MCP server 内部 HTTP 客户端
 * 比 CLI 简化：所有错误转为 MCP 工具调用错误（throw Error），无重试 UI 提示。
 */
import { loadConfig } from '../config.js';

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

export async function mcpGet<T = unknown>(
  cfg: McpConfig,
  routePath: string,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const url = new URL(routePath.startsWith('http') ? routePath : `${cfg.baseUrl}${routePath}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    let body: any = null;
    try { body = await res.json(); } catch { /* ignore */ }
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`API ${res.status}: ${msg}`);
  }
  return (await res.json()) as T;
}
