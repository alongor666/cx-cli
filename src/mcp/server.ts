/**
 * cx mcp — stdio MCP server for chexian-api
 *
 * 启动时拉 /api/auth/route-catalog，把 /api/query/* 路由全部映射为 MCP tools，
 * 另加 cx_discover_* 发现工具与 cx_whoami 身份工具。
 *
 * 凭据复用 cx login（见 ./api.ts），Agent 的 mcpServers 配置只需：
 *   { "chexian": { "command": "<cx 绝对路径>", "args": ["mcp"] } }
 * `cx mcp install` 会替你写好；stdout 专供 JSON-RPC，日志一律走 stderr。
 * 可选：CX_MCP_MAX_BYTES 覆盖单次工具结果字节上限（默认 100000，超限按行截断并明示）。
 *
 * 本文件只做 stdio 传输接线；工具面组装在 assembleMcpToolset（与 http.ts 的
 * Streamable HTTP 入口共用一份），远端客户端（ChatGPT 等）走 `cx mcp http`。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadMcpConfig, mcpGet } from './api.js';
import { fetchAllTools, buildDiscoveryTools, buildToolsFromRoutes, type McpTool } from './build-tools.js';
import { readCatalogCache, writeCatalogCache, canFallBackToCache, MAX_STALE_CACHE_MS } from '../commands/routes.js';
import { createCallToolHandler, type ToolResult } from './call-tool.js';
import { resolveMaxBytes } from './format-result.js';

export interface AssembledToolset {
  readonly cfg: ReturnType<typeof loadMcpConfig>;
  readonly tools: McpTool[];
  readonly handleCall: (toolName: string, rawArgs: unknown) => Promise<ToolResult>;
}

/**
 * 启动期组装：catalog 拉取（含 7 天缓存兜底）+ discovery 工具 + tools/call 处理器。
 * stdio（runMcpServer）与 HTTP（http.ts）共用这一层——工具面只有一份，传输形态各异。
 * logPrefix 只影响 stderr 日志归属（stdio 与 HTTP 各自可辨），不影响行为。
 */
export async function assembleMcpToolset(logPrefix = '[chexian-mcp]'): Promise<AssembledToolset> {
  const cfg = loadMcpConfig();
  const log = (msg: string) => console.error(`${logPrefix} ${msg}`);

  // 启动时拉一次 catalog。Agent 启动那一刻的一次网络抖动/502 不该让整个会话失去工具：
  // 拉取失败时回退到 cx 的本地 catalog 缓存；鉴权/权限失败必须如实退出（旧目录会掩盖令牌失效）。
  // 超过 7 天的缓存不用（告警只到 stderr、Agent 看不到，宁可启动失败）；拉取成功时刷新缓存，只用 MCP 的机器也有兜底。
  let catalog: ReturnType<typeof buildToolsFromRoutes>;
  let reachable = true;
  try {
    const fetched = await fetchAllTools(cfg);
    catalog = fetched;
    // 空目录不写：否则一次异常的空响应会冲掉好缓存，下次就没有兜底
    if (fetched.raw.length > 0) {
      try { writeCatalogCache(cfg.baseUrl, fetched.raw); } catch { /* 缓存写失败不影响本次会话 */ }
    }
  } catch (err) {
    const msg = (err as Error).message;
    const cached = readCatalogCache(cfg.baseUrl);
    const ageMs = cached?.ageMs ?? 0;
    if (!canFallBackToCache(err, cached)) {
      const stale = ageMs > MAX_STALE_CACHE_MS ? `（本地缓存已 ${Math.round(ageMs / 86_400_000)} 天，超过 7 天不再回退）` : '';
      log(`Failed to fetch route-catalog: ${msg}${stale}`);
      process.exit(1);
    }
    log(`WARN route-catalog 拉取失败（${msg}），改用 ${Math.round(cached.ageMs / 3600_000)}h 前的本地缓存`);
    catalog = buildToolsFromRoutes(cached.routes);
    reachable = false;
  }
  // 发现类工具内部已吞掉各自的失败（只影响描述里的摘要数字），不会抛出
  const bindings = await buildDiscoveryTools(cfg, reachable);
  for (const w of catalog.warnings) log(`WARN ${w}`);

  const tools = catalog.tools.concat(bindings.map((b) => b.tool));
  const handleCall = createCallToolHandler({
    cfg,
    routes: catalog.routes,
    bindings,
    maxBytes: resolveMaxBytes(),
    get: mcpGet,
  });

  return { cfg, tools, handleCall };
}

export async function runMcpServer(version: string): Promise<void> {
  const { cfg, tools, handleCall } = await assembleMcpToolset();

  const server = new Server(
    { name: 'chexian-mcp', version },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleCall(request.params.name, request.params.arguments));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[chexian-mcp] Ready. ${tools.length} tools loaded from ${cfg.baseUrl}`);
}
