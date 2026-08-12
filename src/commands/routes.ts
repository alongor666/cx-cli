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
  /**
   * 界面已下线（服务端 QueryRouteMeta.uiRetired，经 /route-catalog 原样下发）：
   * 路由本体仍在服务、仅无对应页面。旧本地缓存可能缺省 → 视为未下线。
   */
  uiRetired?: boolean;
}

/**
 * 「界面已下线」标注在 description 里的锚点符号。
 *
 * **文案本体不在 CLI**：唯一事实源是服务端 `config/query-routes-metadata.ts` 的
 * `UI_RETIRED_CATALOG_NOTE`，由 `/route-catalog` 追加进 description 下发。CLI 与 server 是
 * 两个独立 tsconfig 包（rootDir 各自 ./src），不能 import 该常量，因此这里只认锚点符号、
 * 不复写中文文案：table 用符号打标 + 表尾图例给出服务端原文，json/csv 直接带 description。
 *
 * 修的什么（复审 P2-8）：后端已有 uiRetired 标注、目录也已回传，但 `cx routes` 三种输出
 * 都只渲染 key/path/summary/timeWindow，命令行用户看到的仍与下线前逐字相同。
 */
export const UI_RETIRED_MARK = '⚠';

/** 该路由的界面是否已下线 */
export function isUiRetired(r: RouteMeta): boolean {
  return r.uiRetired === true;
}

/**
 * 取出目录下发的下线标注原文（服务端文案改动会原样透出）。
 * 锚点抽不到时退回整段 description——宁可长，不可哑掉。
 */
export function uiRetiredNote(r: RouteMeta): string | null {
  if (!isUiRetired(r)) return null;
  const description = r.description ?? '';
  const idx = description.indexOf(UI_RETIRED_MARK);
  return idx >= 0 ? description.slice(idx) : description;
}

/** table 模式的一行：下线路由的 key 前打锚点标记 */
export function buildRouteTableRow(r: RouteMeta): string[] {
  return [
    isUiRetired(r) ? `${UI_RETIRED_MARK} ${r.key}` : r.key,
    r.path,
    r.summary,
    r.timeWindow ?? '',
  ];
}

/** table 模式的表尾图例：把服务端下线标注原文逐条列出（无下线路由则为空数组） */
export function buildUiRetiredLegend(routes: RouteMeta[]): string[] {
  return routes
    .filter(isUiRetired)
    // 标注原文自带锚点符号，这里不再重复打一个
    .map((r) => `${r.key} — ${uiRetiredNote(r)}`);
}

/**
 * json / csv 模式的投影：除既有字段外带上 description（含服务端下线标注原文）与 uiRetired
 * 布尔位，让程序化调用方（agent / 脚本）一次发现就知道"这条没有页面"。
 */
export function projectRoutesForExport(routes: RouteMeta[]): Array<Record<string, unknown>> {
  return routes.map((r) => ({
    key: r.key,
    path: r.path,
    summary: r.summary,
    description: r.description ?? '',
    uiRetired: isUiRetired(r),
    timeWindow: r.timeWindow ?? '',
    tags: (r.tags ?? []).join(','),
    parameters: r.parameters ?? [],
  }));
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
      // JSON / CSV 输出含 parameters，让 agent 一次发现就拿到完整 schema（含 enum）；
      // 并含 description + uiRetired，让「界面已下线」在机器输出里同样可见（复审 P2-8）。
      // CSV 渲染会把 parameters 数组序列化为 JSON 字符串，agent 解析后即可用。
      console.log(renderOutput(projectRoutesForExport(routes), fmt));
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
      for (const r of members) t.push(buildRouteTableRow(r));
      console.log(t.toString());
    }
    // 下线标注图例（服务端原文）：没有下线路由时不打印，正常输出不变噪
    for (const line of buildUiRetiredLegend(routes)) {
      console.log(kleur.yellow(line));
    }
    note(kleur.gray(`(${routes.length} routes; use "cx query <key>" to call)`));
  } catch (err) {
    failWith(err);
  }
}
