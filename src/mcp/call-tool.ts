/**
 * tools/call 处理器（与 stdio 接线解耦，便于单测）
 *
 * 所有失败都转成 isError 结果（文案可让 LLM 自修复），绝不抛出到传输层。
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpConfig } from './api.js';
import { toolNameForRoute, type DiscoveryToolBinding, type RouteMeta } from './build-tools.js';
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

/** 数据块独占 content[0]（未截断时是纯 JSON，截断时带截断说明头），提示单独成块追加在后 */
const dataResult = (text: string, warning: string): ToolResult => ({
  content: warning
    ? [{ type: 'text', text }, { type: 'text', text: warning }]
    : [{ type: 'text', text }],
});

/**
 * 参数只允许标量：对象/数组经 String() 会变成 "[object Object]" / "a,b" 静默发出去，
 * 服务端按默认值查询，LLM 拿到的是看似正常的错误答案。
 * 数组不能一律按逗号拼：只有复数形式的多选参数（orgNames 等）服务端按逗号拆，单值参数拼接后
 * 会变成等值比较查空，三态布尔的 '是,否' 更会让该维度整段从 WHERE 消失、返回未筛选全量。
 * catalog 没有「是否多选」的机器可读标记，所以：单元素数组取唯一值，空数组按未传，多元素数组拒绝。
 */
function checkArgs(rawArgs: unknown): { args: Args } | { error: string } {
  if (rawArgs === undefined || rawArgs === null) return { args: {} };
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { error: '工具参数必须是对象（键值对）' };
  }
  const isScalar = (v: unknown) => ['string', 'number', 'boolean'].includes(typeof v);
  const args: Args = {};
  const bad: string[] = [];
  const multi: string[] = [];
  for (const [k, v] of Object.entries(rawArgs as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (isScalar(v)) args[k] = v as Args[string];
    else if (Array.isArray(v) && v.length === 0) continue;
    else if (Array.isArray(v) && v.length === 1 && isScalar(v[0])) args[k] = v[0] as Args[string];
    else if (Array.isArray(v) && v.every(isScalar)) multi.push(k);
    else bad.push(k);
  }
  if (bad.length > 0) {
    return { error: `参数只接受字符串/数字/布尔值，以下参数类型不合法: ${bad.join(', ')}` };
  }
  if (multi.length > 0) {
    return { error: `参数 ${multi.join(', ')} 传了多个值：多选参数（如 orgNames）请自行用英文逗号拼成一个字符串；单值参数只能传一个值` };
  }
  return { args };
}

/**
 * 未声明参数不拒绝（CLI 同样透传 targetBranch 等通用参数，服务端契约以其自身为准），
 * 但必须告诉 LLM：拼错的参数名会被服务端忽略、按默认口径返回，这是最隐蔽的错答来源。
 */
function undeclaredNote(args: Args, declared: Set<string>): string {
  const unknown = Object.keys(args).filter((k) => !declared.has(k));
  if (unknown.length === 0) return '';
  const known = [...declared].join(', ') || '（无）';
  return `⚠ 参数 ${unknown.join(', ')} 不在本工具声明的参数中，服务端可能忽略它们并按默认口径返回。声明的参数: ${known}`;
}

function pathParamNames(template: string): string[] {
  return [...template.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
}

export function createCallToolHandler(deps: CallToolDeps) {
  const routesByToolName = new Map(deps.routes.map((r) => [toolNameForRoute(r.key), r]));
  const bindingsByToolName = new Map(deps.bindings.map((b) => [b.tool.name, b]));

  return async (toolName: string, rawArgs: unknown): Promise<ToolResult> => {
    const checked = checkArgs(rawArgs);
    if ('error' in checked) return textResult(checked.error, true);
    const { args } = checked;
    try {
      const binding = bindingsByToolName.get(toolName);
      if (binding) {
        const note = undeclaredNote(args, new Set(Object.keys(binding.tool.inputSchema.properties)));
        const body = await deps.get(deps.cfg, binding.endpoint, args);
        const shaped = binding.project
          ? binding.project((body as { data?: unknown } | null)?.data ?? body)
          : body;
        return dataResult(formatResult(shaped, deps.maxBytes).text, note);
      }
      const route = routesByToolName.get(toolName);
      if (!route) return textResult(`Unknown tool: ${toolName}`, true);
      const declared = new Set([...route.parameters.map((p) => p.name), ...pathParamNames(route.fullPath)]);
      const note = undeclaredNote(args, declared);
      const { resolvedPath, restArgs } = applyPathParams(route.fullPath, args, () => '，作为工具参数传入');
      const body = await deps.get(deps.cfg, resolvedPath, restArgs);
      return dataResult(formatResult(body, deps.maxBytes).text, note);
    } catch (err) {
      return textResult((err as Error).message, true);
    }
  };
}
