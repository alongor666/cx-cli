/**
 * tools/call 处理器（与 stdio 接线解耦，便于单测）
 *
 * 所有失败都转成 isError 结果（文案可让 LLM 自修复），绝不抛出到传输层。
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpConfig } from './api.js';
import type { DiscoveryToolBinding, RouteMeta } from './build-tools.js';
import { applyPathParams } from '../path-params.js';
import { formatResult } from './format-result.js';

type Args = Record<string, string | number | boolean>;
type Getter = (cfg: McpConfig, path: string, query?: Args) => Promise<unknown>;

export interface CallToolDeps {
  cfg: McpConfig;
  routes: RouteMeta[];
  bindings: DiscoveryToolBinding[];
  maxBytes: number;
  get: Getter;
}

export type ToolResult = CallToolResult;

const textResult = (text: string, isError = false): ToolResult =>
  (isError ? { isError: true, content: [{ type: 'text', text }] } : { content: [{ type: 'text', text }] });

export function createCallToolHandler(deps: CallToolDeps) {
  const routesByToolName = new Map(deps.routes.map((r) => [`cx_query_${r.key.toLowerCase()}`, r]));
  const bindingsByToolName = new Map(deps.bindings.map((b) => [b.tool.name, b]));

  return async (toolName: string, rawArgs: unknown): Promise<ToolResult> => {
    const args = (rawArgs ?? {}) as Args;
    try {
      const binding = bindingsByToolName.get(toolName);
      if (binding) {
        const body = await deps.get(deps.cfg, binding.endpoint, args);
        const shaped = binding.project
          ? binding.project((body as { data?: unknown } | null)?.data ?? body)
          : body;
        return textResult(formatResult(shaped, deps.maxBytes).text);
      }
      const route = routesByToolName.get(toolName);
      if (!route) return textResult(`Unknown tool: ${toolName}`, true);
      const { resolvedPath, restArgs } = applyPathParams(route.fullPath, args, () => '，作为工具参数传入');
      const body = await deps.get(deps.cfg, resolvedPath, restArgs);
      return textResult(formatResult(body, deps.maxBytes).text);
    } catch (err) {
      return textResult((err as Error).message, true);
    }
  };
}
