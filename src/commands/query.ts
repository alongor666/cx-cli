/**
 * cx query <key|path> [--param=value ...] [--format table|json|csv] [--limit n] [--timeout ms]
 *
 * <key|path> 三种形态：
 *   1) route-catalog 的 key（如 KPI / claims-detail-heatmap，大小写与连字符宽容）
 *   2) catalog 登记的 path（如 /kpi）
 *   3) 任意 / 开头的 path 直通（如 /repair/overview，不依赖 catalog）
 */
import kleur from 'kleur';
import { cxGet } from '../api.js';
import { renderOutput, type OutputFormat } from '../output.js';
import { failWith, EXIT } from '../exit-codes.js';
import { applyPathParams } from '../path-params.js';
import { note } from '../cli-state.js';
import { fetchCatalog } from './routes.js';

export interface QueryOpts {
  format?: OutputFormat;
  /** 额外 query 参数：来自 commander 的 --key=value 解析 */
  params: Record<string, string>;
  /** 客户端截断行数（仅 list 型响应生效） */
  limit?: number;
  /** 请求超时（毫秒） */
  timeoutMs?: number;
}

interface RouteTarget {
  key: string;
  path: string;
  fullPath: string;
}

export async function queryCommand(rawKey: string, opts: QueryOpts): Promise<void> {
  try {
    const { route, refreshed } = await resolveWithRefresh(rawKey, fetchCatalog);
    if (!route) {
      console.error(kleur.red(`✘ Unknown route: ${rawKey}`));
      console.error(kleur.gray('  已刷新 route-catalog 缓存仍未找到。运行 "cx routes" 查看可用路由，或用 / 开头的 path 直通（如 cx query /kpi）。'));
      process.exit(EXIT.USAGE);
    }
    if (refreshed) note(kleur.gray('(本地缓存未命中，已自动刷新 route-catalog)'));

    const { resolvedPath, restArgs } = applyPathParams(route.fullPath, opts.params);
    const data = await cxGet<unknown>(resolvedPath, { query: restArgs, timeoutMs: opts.timeoutMs });
    const fmt: OutputFormat = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');

    let payload = (data as any)?.data ?? data;
    if (opts.limit && opts.limit > 0 && Array.isArray(payload) && payload.length > opts.limit) {
      note(kleur.gray(`(truncated to ${opts.limit} rows, total ${payload.length})`));
      payload = payload.slice(0, opts.limit);
    }
    console.log(renderOutput(payload, fmt));
  } catch (err) {
    failWith(err);
  }
}

/**
 * 解析失败时强制刷新 catalog 缓存再试一次（消除"新路由上线后 24h 缓存盲区"）。
 * / 开头的 path 直通在 resolveTarget 内永远命中，不会触发刷新。
 */
export async function resolveWithRefresh(
  rawKey: string,
  fetch: (forceRefresh?: boolean) => Promise<RouteTarget[]>,
): Promise<{ route: RouteTarget | null; refreshed: boolean }> {
  const cached = await fetch(false);
  const hit = resolveTarget(rawKey, cached);
  if (hit) return { route: hit, refreshed: false };

  const fresh = await fetch(true);
  return { route: resolveTarget(rawKey, fresh), refreshed: true };
}

/** key 宽容匹配 → catalog path 匹配 → / 开头 path 直通 */
export function resolveTarget(input: string, routes: RouteTarget[]): RouteTarget | null {
  const norm = input.toUpperCase().replace(/-/g, '_').replace(/^\/?/, '');
  const byKey = routes.find((r) => r.key === norm);
  if (byKey) return byKey;

  const pathCandidate = '/' + input.replace(/^\//, '');
  const byPath = routes.find((r) => r.path === pathCandidate);
  if (byPath) return byPath;

  // path 直通：catalog 未登记也允许请求（服务端仍做鉴权与校验）
  if (input.startsWith('/')) {
    return { key: input, path: input, fullPath: `/api/query${input}` };
  }
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
