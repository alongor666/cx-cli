/**
 * API URL 构造（CLI 与 MCP 共用，无副作用）。
 *
 * 安全不变量：
 *   1. 只接受以 / 开头的相对 path，永远拼在 baseUrl 之后 —— PAT 绝不会被发往 baseUrl 以外的 origin。
 *   2. 拒绝 . / .. 路径段（含 %2e 编码形式）—— new URL() 会把它们规范化掉，
 *      /api/query/x/../../auth/tokens 会逃逸出 /api/query 前缀。
 */

type QueryValue = string | number | boolean | null | undefined;

export function buildApiUrl(
  baseUrl: string,
  routePath: string,
  query?: Record<string, QueryValue>,
): URL {
  if (!routePath.startsWith('/') || routePath.startsWith('//')) {
    throw new Error(`非法 API path（必须以单个 / 开头的相对路径）: ${routePath}`);
  }
  const pathOnly = routePath.split(/[?#]/, 1)[0];
  if (pathOnly.split('/').some(isDotSegment)) {
    throw new Error(`非法 API path（不允许 . 或 .. 路径段）: ${routePath}`);
  }

  const base = new URL(baseUrl);
  const url = new URL(base.href.replace(/\/+$/, '') + routePath);
  if (url.origin !== base.origin) {
    throw new Error(`API path 解析到了 baseUrl 以外的 origin: ${url.origin}`);
  }
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url;
}

export function isDotSegment(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // 非法百分号编码交给服务端处理
  }
  return decoded === '.' || decoded === '..';
}
