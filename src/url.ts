/**
 * API URL 构造（CLI 与 MCP 共用，无副作用）。
 *
 * 安全不变量：
 *   1. 只接受以 / 开头的相对 path，永远拼在 baseUrl 之后 —— PAT 绝不会被发往 baseUrl 以外的 origin。
 *   2. 拒绝 . / .. 路径段（含 %2e、..%2f 编码形式）—— new URL() 会把它们规范化掉，
 *      /api/query/x/../../auth/tokens 会逃逸出 /api/query 前缀。
 *      WHATWG 解析器还会把 \ 当作 /、并删掉 Tab/换行（..\、.<Tab>. 都会变成 ..），一并拒绝。
 *   3. baseUrl 必须是 http(s)，不得内嵌凭据/查询串/锚点 —— CX_BASE_URL 环境变量不经 normalizeBaseUrl，在此兜底。
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
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(routePath) || routePath.split(/[?#]/, 1)[0].includes('\\')) {
    throw new Error(`非法 API path（不允许反斜杠或控制字符）: ${JSON.stringify(routePath)}`);
  }
  const pathOnly = routePath.split(/[?#]/, 1)[0];
  if (pathOnly.split('/').some(isDotSegment)) {
    throw new Error(`非法 API path（不允许 . 或 .. 路径段）: ${routePath}`);
  }

  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    // file: / data: 的 origin 都是 'null'，下面的同源比较会恒通过
    throw new Error(`baseUrl 必须是 http/https（检查 CX_BASE_URL 或 cx config get baseUrl），收到协议: ${base.protocol}`);
  }
  // 用原串判 ? / #：空查询串 "https://h?" 解析后 search 为空，但拼接后会吞掉 API 路径
  if (base.username || base.password || /[?#]/.test(baseUrl)) {
    throw new Error('baseUrl 不能内嵌用户名/密码、查询串或 # 锚点（检查 CX_BASE_URL 或 cx config get baseUrl）');
  }
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
  // 按解码后再切一次：..%2f / ..%5c 解码成 ../ ..\，经会解码的代理/网关时同样能逃逸前缀
  return decoded.split(/[\/\\]/).some((s) => s === '.' || s === '..');
}
