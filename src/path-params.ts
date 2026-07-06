/**
 * path 模板参数替换：/api/query/example/:domain + {domain:'renewal'} → /api/query/example/renewal
 *
 * 已消费的参数从 query 参数中移除，避免重复出现在 query string。
 * 缺少必需 path 参数时抛错。
 * （与 mcp/src/tools/path-params.ts 同构；cli/mcp 是独立 package，不共享源码。）
 */
export function applyPathParams(
  pathTemplate: string,
  params: Record<string, string>,
): { resolvedPath: string; restArgs: Record<string, string> } {
  const restArgs = { ...params };
  const resolvedPath = pathTemplate.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    const value = restArgs[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`缺少必需的 path 参数: ${name}（路由 ${pathTemplate}，用 --${name}=<值> 传入）`);
    }
    delete restArgs[name];
    return encodeURIComponent(value);
  });
  return { resolvedPath, restArgs };
}
