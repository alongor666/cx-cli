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
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadMcpConfig, mcpGet } from './api.js';
import { fetchAllTools, buildDiscoveryTools, buildToolsFromRoutes } from './build-tools.js';
import { readCatalogCache } from '../commands/routes.js';
import { createCallToolHandler } from './call-tool.js';
import { resolveMaxBytes } from './format-result.js';

export async function runMcpServer(version: string): Promise<void> {
  const cfg = loadMcpConfig();

  // 启动时拉一次 catalog。Agent 启动那一刻的一次网络抖动/502 不该让整个会话失去工具：
  // 拉取失败时回退到 cx 的本地 catalog 缓存；鉴权/权限失败必须如实退出（旧目录会掩盖令牌失效）。
  let catalog: Awaited<ReturnType<typeof fetchAllTools>>;
  try {
    catalog = await fetchAllTools(cfg);
  } catch (err) {
    const msg = (err as Error).message;
    const cached = /^API 40[13]:/.test(msg) ? null : readCatalogCache();
    if (!cached) {
      console.error(`[chexian-mcp] Failed to fetch route-catalog: ${msg}`);
      process.exit(1);
    }
    console.error(`[chexian-mcp] WARN route-catalog 拉取失败（${msg}），改用 ${Math.round(cached.ageMs / 3600_000)}h 前的本地缓存`);
    catalog = buildToolsFromRoutes(cached.routes);
  }
  // 发现类工具内部已吞掉各自的失败（只影响描述里的摘要数字），不会抛出
  const bindings = await buildDiscoveryTools(cfg);
  for (const w of catalog.warnings) console.error(`[chexian-mcp] WARN ${w}`);

  const tools = catalog.tools.concat(bindings.map((b) => b.tool));
  const handleCall = createCallToolHandler({
    cfg,
    routes: catalog.routes,
    bindings,
    maxBytes: resolveMaxBytes(),
    get: mcpGet,
  });

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
