/**
 * cx mcp http — Streamable HTTP 入口，给只接受远端 HTTPS 端点的客户端（ChatGPT 开发者模式）用
 * （CX-ADR-f03914；同型先例：kosmos 仓 issue #72/#77，ChatGPT 全端实证可用）。
 * stdio 入口（server.ts）不变；两者共用 assembleMcpToolset，工具面与数据身份同源。
 *
 * 启动：`cx mcp http`，除 PAT/baseUrl 复用 cx login 外还要：
 *   CX_MCP_HTTP_TOKEN  入口令牌（≥ 32 字符，必填；缺或太短即拒绝启动，不给默认值）
 *   CX_MCP_HTTP_HOST   监听地址（默认 127.0.0.1；拒绝 0.0.0.0 / :: ——公网暴露交给反向代理）
 *   CX_MCP_HTTP_PORT   监听端口（默认 8788）
 *
 * 🛑 三条边界（CX-ADR-f03914）：
 *  ① 入口令牌只证明「是谁在连」，不改变能看什么——数据身份由 PAT（cx login）决定，
 *    RLS/审计/限流/只读红线全部在 REST API 侧继承。
 *  ② 令牌两种携带：`Authorization: Bearer <令牌>`（路径 /mcp），或路径段 `/mcp/<令牌>`。
 *    后者是给 ChatGPT 用的——它的 connector 不支持自定义请求头，只接受 OAuth 或无鉴权，
 *    故把令牌放进 URL（能力 URL）。代价是令牌会出现在反向代理访问日志里：代理侧必须
 *    关掉该路径的访问日志或做脱敏（部署 runbook 的硬性步骤，不在这里假装解决）。
 *    比较用恒定时间（sha256 摘要 + timingSafeEqual）。
 *  ③ 无状态：每请求新建 Server 壳 + 传输，不保留会话。工具全是只读查询，进程重启对客户端透明。
 *
 * 工具面红线：本入口剔除 SQL 直通与行级明细工具（见 HTTP_EXCLUDED_TOOLS），tools/list 与 tools/call 双面拦截，
 * 环境变量不可放回——CX-ADR-f03914 裁定 4（stdio 面不受影响）。
 *
 * 日志只写 stderr；路径里的令牌段打码后才记。
 *
 * ⚠️ 镜像声明：本文件的鉴权/路由/打码/无状态骨架（httpConfigFromEnv / sameSecret /
 * routeRequest / redactPath / createHttpHandler）与 kosmos 仓 `projections/mcp/http.ts`
 * 互为镜像——同型代码的第二份拷贝（两仓无共享包通道，手工移植是裁定拍板的取舍）。
 * 任一侧修鉴权/传输缺陷，另一侧**必须同步改**（AGENTS.md/CLAUDE.md 镜像条款同款义务）；
 * @modelcontextprotocol/sdk 大版本亦须两仓对齐（评审 F3：行为契约随版本分叉）。
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { assembleMcpToolset } from './server.js';
import type { McpTool } from './build-tools.js';
import type { ToolResult } from './call-tool.js';

export interface HttpConfig {
  readonly token: string;
  readonly host: string;
  readonly port: number;
}

const MIN_TOKEN_LENGTH = 32;
const DEFAULT_PORT = 8788;
// :: 的等价长形一并拒绝（评审 F4）；只拒通配、不校验「内网」——env 由 owner 控制，README 如实表述
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', '']);

/**
 * HTTP 入口工具面剔除名单（CX-ADR-f03914 裁定 4 + DSH 评审 F-1 收窄）：HTTP 入口不暴露
 * 自由 SQL 与**行级明细**能力。ledger（网点台账）SQL 最终投影含 policy_no/vehicle_frame_no
 * 行级值（DSH 生产实测确认真 VIN 可出站），与 SQL 直通同属 L2 出站面，一并剔除。
 * 硬编码、无环境变量放行——放开须先修裁定（append-only）。新增明细类路由时须同步本名单
 * 与 tests/api/route-catalog-mcp-contract.test.ts 的对账断言。
 */
export const HTTP_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['cx_query_sql', 'cx_query_network_outlet_ledger']);

/** 从环境变量读 HTTP 配置；任何缺项或越界都抛错说明怎么填，不猜默认值（端口与回环地址除外） */
export function httpConfigFromEnv(env: Readonly<Record<string, string | undefined>>): HttpConfig {
  const token = env['CX_MCP_HTTP_TOKEN'] ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`CX_MCP_HTTP_TOKEN 必须至少 ${MIN_TOKEN_LENGTH} 个字符（可用 \`openssl rand -hex 32\` 生成）：无令牌即不对外服务`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('CX_MCP_HTTP_TOKEN 只许字母、数字、下划线、连字符（它会出现在 URL 路径里）');
  const host = (env['CX_MCP_HTTP_HOST'] ?? '127.0.0.1').trim();
  if (WILDCARD_HOSTS.has(host)) {
    throw new Error(`CX_MCP_HTTP_HOST 不许监听全部网卡（当前：${host || '空'}）：请绑回环或内网地址，公网暴露交给反向代理`);
  }
  const portRaw = env['CX_MCP_HTTP_PORT'] ?? String(DEFAULT_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`CX_MCP_HTTP_PORT 不是合法端口：${portRaw}`);
  return { token, host, port };
}

/** 恒定时间比较：先各自取摘要再比，长度不同也不提前返回 */
export function sameSecret(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

export type RouteResult = { readonly ok: true } | { readonly ok: false; readonly status: 401 | 404 };

/**
 * 路由与鉴权（纯函数，测试直接调）：只认 `/mcp` 与 `/mcp/<令牌>` 两种路径。
 * `/mcp` 必须带 Bearer；`/mcp/<令牌>` 以路径段为准，此时忽略请求头。
 * 畸形 request-target（`//`、absolute-form 等）判 404——它在鉴权前、且在 handler 的
 * try-catch 之外，new URL 抛出的 TypeError 若不就地吞掉会成为 unhandled rejection
 * 打崩进程（评审 F1 PoC：无需令牌即可触发）。**待镜像同修 kosmos（跟进 #1405）**。
 */
export function routeRequest(url: string | undefined, authorization: string | undefined, token: string): RouteResult {
  // origin-form 判据先行（评审 F1 的完整形态）：absolute-form（http://…，不抛错但语义穿透成
  // pathname 匹配）与 protocol-relative（//）、畸形串一律 404，不进 URL 解析。
  if (!url || !url.startsWith('/') || url.startsWith('//')) return { ok: false, status: 404 };
  let pathname: string;
  try {
    pathname = new URL(url, 'http://x').pathname.replace(/\/+$/, '');
  } catch {
    return { ok: false, status: 404 };
  }
  if (pathname === '/mcp') {
    const m = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
    return m !== null && sameSecret(m[1]!.trim(), token) ? { ok: true } : { ok: false, status: 401 };
  }
  const seg = /^\/mcp\/([^/]+)$/.exec(pathname);
  if (seg !== null) return sameSecret(seg[1]!, token) ? { ok: true } : { ok: false, status: 401 };
  return { ok: false, status: 404 };
}

/** 日志用：路径里的令牌段打码 */
export function redactPath(url: string | undefined): string {
  // 打码整个路径部分（非仅首段，部署验收实测 P1 #1421）：token 出现在任何段都不落日志
  return (url ?? '/').replace(/^\/mcp\/[^?#]*/, '/mcp/***');
}

export interface HttpHandlerDeps {
  readonly version: string;
  readonly tools: McpTool[];
  readonly handleCall: (toolName: string, rawArgs: unknown) => Promise<ToolResult>;
}

const deniedResult = (toolName: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: `工具 ${toolName} 在本入口被禁用（CX-ADR-f03914：HTTP 入口不暴露 SQL 直通与保单级中收台账 ledger）` }],
});

/** 请求处理器：鉴权 → 剔除名单双面生效（列表过滤 + 调用拦截）→ 每请求新建 Server 壳 + 无状态传输 */
export function createHttpHandler(
  deps: HttpHandlerDeps,
  token: string,
  log: (line: string) => void = (l) => console.error(l),
) {
  const visibleTools = deps.tools.filter((t) => !HTTP_EXCLUDED_TOOLS.has(t.name));
  const guardedCall = (toolName: string, rawArgs: unknown): Promise<ToolResult> =>
    HTTP_EXCLUDED_TOOLS.has(toolName)
      ? Promise.resolve(deniedResult(toolName))
      : deps.handleCall(toolName, rawArgs);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const route = routeRequest(req.url, req.headers.authorization, token);
    if (!route.ok) {
      log(`[cx-mcp-http] ${route.status} ${req.method ?? '?'} ${redactPath(req.url)}`);
      res.writeHead(route.status, { 'content-type': 'text/plain; charset=utf-8' }).end(route.status === 401 ? 'unauthorized' : 'not found');
      return;
    }
    const server = new Server(
      { name: 'chexian-mcp-http', version: deps.version },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      guardedCall(request.params.name, request.params.arguments));
    // 无状态：不给 sessionIdGenerator——每请求独立传输，无会话可丢；
    // close() 的 reject 不静默吞（静默失败 Law 1）：失败打 stderr。字面用 console.error——
    // 静默降级扫描器按文本识别日志形态，log() 包装函数名不在其白名单
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch((e: unknown) => console.error(`[cx-mcp-http] transport close 失败：${e instanceof Error ? e.message : String(e)}`));
      server.close().catch((e: unknown) => console.error(`[cx-mcp-http] server close 失败：${e instanceof Error ? e.message : String(e)}`));
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      log(`[cx-mcp-http] 处理失败 ${redactPath(req.url)}：${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('internal error');
    }
  };
}

export async function runMcpHttpServer(version: string): Promise<void> {
  const cfg = httpConfigFromEnv(process.env);
  const { tools, handleCall } = await assembleMcpToolset('[cx-mcp-http]');
  const httpServer = http.createServer((req, res) => { void createHttpHandler({ version, tools, handleCall }, cfg.token)(req, res); });
  await new Promise<void>((resolve) => httpServer.listen(cfg.port, cfg.host, resolve));
  const visible = tools.length - [...HTTP_EXCLUDED_TOOLS].filter((n) => tools.some((t) => t.name === n)).length;
  console.error(`[cx-mcp-http] 已就绪：http://${cfg.host}:${cfg.port}/mcp · 工具 ${visible}/${tools.length}（剔除 SQL 直通/明细台账）`);
  const shutdown = async (): Promise<void> => { httpServer.close(); process.exit(0); };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMcpHttpServer('dev').catch((e: unknown) => { console.error(`[cx-mcp-http] 启动失败：${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
