/**
 * path 模板参数替换：/api/query/example/:domain + {domain:'renewal'} → /api/query/example/renewal
 *
 * 已消费的参数从 query 参数中移除，避免重复出现在 query string。
 * 缺少必需 path 参数时抛错；`usage` 是错误提示尾巴（CLI 提示 --flag 写法，MCP 提示工具参数）。
 * cx 命令与 cx mcp 共用本实现。
 */
type ParamValue = string | number | boolean;

export function applyPathParams<V extends ParamValue>(
  pathTemplate: string,
  params: Record<string, V>,
  usage: (name: string) => string = (name) => `，用 --${name}=<值> 传入`,
): { resolvedPath: string; restArgs: Record<string, V> } {
  const restArgs = { ...params };
  const resolvedPath = pathTemplate.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    const value = restArgs[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`缺少必需的 path 参数: ${name}（路由 ${pathTemplate}${usage(name)}）`);
    }
    delete restArgs[name];
    return encodeURIComponent(String(value));
  });
  return { resolvedPath, restArgs };
}
