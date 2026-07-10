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
  /** 打印字段图例（裸输出列 → 中文名 / 口径 / 单位 + 生效时间口径），消灭 A-E 裸字母 */
  describe?: boolean;
}

/** /api/discover/legend 响应中的单列图例 */
interface LegendColumn {
  column: string;
  metricId: string;
  label: string;
  description: string;
  unit: string;
}

/** /api/discover/legend 响应的图例对象 */
interface RouteFieldLegend {
  route: string;
  summary: string;
  timeWindow: string;
  timeWindowNote?: string;
  columns: LegendColumn[];
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

    // --describe：先把字段图例打到 stderr（口径来自服务端 metric-registry 单一事实源），
    // 再正常返回数据到 stdout（保持管道纯净）。图例失败不阻断数据。
    if (opts.describe) {
      await printRouteLegend(route.key, opts.params);
    }

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
 * 拉取并打印路由字段图例到 stderr（口径事实源 = 服务端 metric-registry）。
 * 图例是辅助信息：获取失败或路由无图例时降级提示，绝不阻断主数据查询。
 */
async function printRouteLegend(routeKey: string, params: Record<string, string>): Promise<void> {
  try {
    const resp = await cxGet<{ success: boolean; data: RouteFieldLegend | null }>(
      '/api/discover/legend',
      { query: { route: routeKey } },
    );
    const legend = resp?.data ?? null;
    if (!legend) {
      note(kleur.gray(`(路由 ${routeKey} 暂无字段图例)`));
      return;
    }
    process.stderr.write(formatLegend(legend, params) + '\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    note(kleur.yellow(`(字段图例获取失败，继续返回数据：${msg})`));
  }
}

/**
 * 把图例对象渲染为人类可读文本块（标题 + 时间口径 + 生效参数 + 列字典表）。
 * 纯函数，便于单测。
 */
export function formatLegend(legend: RouteFieldLegend, params: Record<string, string>): string {
  const lines: string[] = [];
  lines.push(kleur.bold(`字段图例 — ${legend.route}（${legend.summary}）`));
  const tw = legend.timeWindowNote
    ? `${legend.timeWindow} · ${legend.timeWindowNote}`
    : legend.timeWindow;
  lines.push(kleur.gray(`时间口径: ${tw}`));
  // 常见时间参数名（仅影响"生效参数"提示行的挑选；参数名 SSOT=服务端 route-param-contracts）
  const timeParams = ['start', 'end', 'cutoff', 'startDate', 'endDate', 'dateStart', 'dateEnd']
    .filter((k) => params[k] !== undefined)
    .map((k) => `${k}=${params[k]}`);
  if (timeParams.length > 0) {
    lines.push(kleur.gray(`生效参数: ${timeParams.join(' ')}`));
  }
  const rows = legend.columns.map((c) => ({
    列: c.column,
    名称: c.label,
    口径: c.description,
    单位: c.unit,
  }));
  lines.push(renderOutput(rows, 'table'));
  return lines.join('\n');
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
