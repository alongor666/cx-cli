/**
 * cx routes [--tag <tag>] [--search <kw>] [--refresh] [--format table|json|csv]
 * 列出所有可用查询路由（从 /api/auth/route-catalog 拉取，本地缓存 24h）
 */
import fs from 'fs';
import kleur from 'kleur';
import Table from 'cli-table3';
import { cxGet } from '../api.js';
import { getCachePath } from '../config.js';
import { failWith } from '../exit-codes.js';
import { renderOutput, type OutputFormat } from '../output.js';
import { note } from '../cli-state.js';

export interface RouteMeta {
  key: string;
  path: string;
  fullPath: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: Array<{ name: string; type: string; required?: boolean; description: string; enum?: string[] }>;
  /** 时间窗口语义（枚举以服务端 RouteTimeWindow 为准，如 window/rolling/ytd-progress 等；旧缓存可能缺省） */
  timeWindow?: string;
  /** 时间口径补充说明 */
  timeWindowNote?: string;
}

interface CatalogResp { success: boolean; data: { version: number; routes: RouteMeta[] } }

const CACHE_TTL_MS = 24 * 3600 * 1000;
const CACHE_FILE = 'catalog.json';

export async function fetchCatalog(forceRefresh = false): Promise<RouteMeta[]> {
  const cachePath = getCachePath(CACHE_FILE);
  if (!forceRefresh && fs.existsSync(cachePath)) {
    const stat = fs.statSync(cachePath);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      try {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        const cached = JSON.parse(raw) as { routes: RouteMeta[] };
        if (Array.isArray(cached.routes) && cached.routes.length > 0) return cached.routes;
      } catch {
        // 缓存损坏，继续拉远端
      }
    }
  }
  const resp = await cxGet<CatalogResp>('/api/auth/route-catalog');
  fs.writeFileSync(cachePath, JSON.stringify({ routes: resp.data.routes }, null, 2), { mode: 0o600 });
  return resp.data.routes;
}

/** --search 关键词过滤：匹配 key/path/summary/description（大小写不敏感） */
export function searchRoutes(routes: RouteMeta[], keyword: string): RouteMeta[] {
  const kw = keyword.toLowerCase();
  return routes.filter(
    (r) =>
      r.key.toLowerCase().includes(kw) ||
      r.path.toLowerCase().includes(kw) ||
      r.summary.toLowerCase().includes(kw) ||
      r.description.toLowerCase().includes(kw),
  );
}

export async function routesCommand(opts: {
  refresh?: boolean;
  tag?: string;
  search?: string;
  format?: OutputFormat;
}): Promise<void> {
  try {
    let routes = await fetchCatalog(Boolean(opts.refresh));
    if (opts.tag) routes = routes.filter((r) => r.tags.includes(opts.tag!));
    if (opts.search) routes = searchRoutes(routes, opts.search);

    const fmt: OutputFormat = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');
    if (fmt !== 'table') {
      // JSON / CSV 输出含 parameters，让 agent 一次发现就拿到完整 schema（含 enum）。
      // CSV 渲染会把 parameters 数组序列化为 JSON 字符串，agent 解析后即可用。
      console.log(renderOutput(routes.map(({ key, path, summary, timeWindow, tags, parameters }) => ({
        key, path, summary, timeWindow: timeWindow ?? '', tags: tags.join(','), parameters: parameters ?? [],
      })), fmt));
      return;
    }

    // table 模式：按首个 tag 分组展示
    const groups = new Map<string, RouteMeta[]>();
    for (const r of routes) {
      const g = r.tags[0] ?? 'other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(r);
    }
    for (const [group, members] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(kleur.bold().cyan(`\n■ ${group} (${members.length})`));
      const t = new Table({
        head: ['key', 'path', 'summary', 'timeWindow'].map((h) => kleur.cyan(h)),
        style: { head: [], border: ['gray'] },
      });
      for (const r of members) t.push([r.key, r.path, r.summary, r.timeWindow ?? '']);
      console.log(t.toString());
    }
    note(kleur.gray(`(${routes.length} routes; use "cx query <key>" to call)`));
  } catch (err) {
    failWith(err);
  }
}
