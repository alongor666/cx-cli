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
import { fetchAllTools, buildDiscoveryTools } from './build-tools.js';
import { createCallToolHandler } from './call-tool.js';
import { resolveMaxBytes } from './format-result.js';

export async function runMcpServer(version: string): Promise<void> {
  const cfg = loadMcpConfig();

  // 启动时拉一次 catalog；失败直接退出（客户端会显示错误）
  let catalog: Awaited<ReturnType<typeof fetchAllTools>>;
  let bindings: Awaited<ReturnType<typeof buildDiscoveryTools>>;
  try {
    catalog = await fetchAllTools(cfg);
    bindings = await buildDiscoveryTools(cfg);
  } catch (err) {
    console.error(`[chexian-mcp] Failed to fetch route-catalog: ${(err as Error).message}`);
    process.exit(1);
  }
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
