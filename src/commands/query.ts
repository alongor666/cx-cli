/**
 * cx query <key> [--param=value ...] [--format table|json|csv]
 *
 * <key> 可以是 route-catalog 的 key（如 KPI）或 path 段（如 /kpi 或 kpi）
 */
import kleur from 'kleur';
import { cxGet, CxApiError } from '../api.js';
import { renderOutput, type OutputFormat } from '../output.js';
import { fetchCatalog } from './routes.js';

interface QueryOpts {
  format?: OutputFormat;
  /** 额外 query 参数：来自 commander 的 --key=value 解析 */
  params: Record<string, string>;
}

export async function queryCommand(rawKey: string, opts: QueryOpts): Promise<void> {
  try {
    const routes = await fetchCatalog();
    const route = resolveRoute(rawKey, routes);
    if (!route) {
      console.error(kleur.red(`✘ Unknown route: ${rawKey}`));
      console.error(kleur.gray('  Run "cx routes" to see available routes.'));
      process.exit(1);
    }

    const data = await cxGet<unknown>(route.fullPath, { query: opts.params });
    const fmt: OutputFormat = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');
    console.log(renderOutput((data as any)?.data ?? data, fmt));
  } catch (err) {
    if (err instanceof CxApiError) {
      console.error(kleur.red(`✘ ${err.message}`));
      process.exit(err.status === 401 ? 2 : 1);
    }
    console.error(kleur.red(`✘ ${(err as Error).message}`));
    process.exit(1);
  }
}

function resolveRoute(input: string, routes: Array<{ key: string; path: string; fullPath: string }>) {
  const norm = input.toUpperCase().replace(/-/g, '_').replace(/^\/?/, '');
  // 1) 完全匹配 key
  let hit = routes.find((r) => r.key === norm);
  if (hit) return hit;
  // 2) path 匹配（/kpi 或 kpi）
  const pathCandidate = '/' + input.replace(/^\//, '');
  hit = routes.find((r) => r.path === pathCandidate);
  if (hit) return hit;
  return null;
}

/**
 * commander 的 --key=value 重复出现合并为对象。
 * 也支持 --filter key=value 形式（透传 query string）。
 */
export function parseExtraParams(raw: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of raw) {
    const eq = item.indexOf('=');
    if (eq === -1) continue;
    const key = item.slice(0, eq).replace(/^--/, '');
    out[key] = item.slice(eq + 1);
  }
  return out;
}
