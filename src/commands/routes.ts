/**
 * cx routes
 * 列出所有可用查询路由（从 /api/auth/route-catalog 拉取）
 */
import fs from 'fs';
import kleur from 'kleur';
import Table from 'cli-table3';
import { cxGet, CxApiError } from '../api.js';
import { getCachePath } from '../config.js';

interface RouteMeta {
  key: string;
  path: string;
  fullPath: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: Array<{ name: string; type: string; required?: boolean; description: string; enum?: string[] }>;
}

interface CatalogResp { success: boolean; data: { version: number; routes: RouteMeta[] } }

const CACHE_TTL_MS = 24 * 3600 * 1000;
const CACHE_FILE = 'catalog.json';

function readCache(cachePath: string): RouteMeta[] | null {
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const cached = JSON.parse(raw) as { routes?: RouteMeta[] };
    if (Array.isArray(cached.routes) && cached.routes.length > 0) return cached.routes;
  } catch {
    // 缓存损坏或不存在
  }
  return null;
}

export async function fetchCatalog(forceRefresh = false): Promise<RouteMeta[]> {
  const cachePath = getCachePath(CACHE_FILE);
  if (!forceRefresh && fs.existsSync(cachePath)) {
    const stat = fs.statSync(cachePath);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      const fresh = readCache(cachePath);
      if (fresh) return fresh;
    }
  }

  try {
    const resp = await cxGet<CatalogResp>('/api/auth/route-catalog');
    const routes = resp.data?.routes;
    if (!Array.isArray(routes) || routes.length === 0) {
      throw new CxApiError(0, 'Malformed route-catalog response (no routes)');
    }
    fs.writeFileSync(cachePath, JSON.stringify({ routes }, null, 2), { mode: 0o600 });
    return routes;
  } catch (err) {
    // 远端失败时回退到（可能过期的）本地缓存
    const stale = readCache(cachePath);
    if (stale) {
      console.error(kleur.yellow('⚠ 远端不可用，使用本地缓存的路由目录（可能已过期）'));
      return stale;
    }
    throw err;
  }
}

export async function routesCommand(opts: { refresh?: boolean; tag?: string }): Promise<void> {
  try {
    const routes = await fetchCatalog(Boolean(opts.refresh));
    const filtered = opts.tag ? routes.filter((r) => r.tags.includes(opts.tag!)) : routes;
    const t = new Table({
      head: ['key', 'path', 'summary', 'tags'].map((h) => kleur.cyan(h)),
      style: { head: [], border: ['gray'] },
    });
    for (const r of filtered) {
      t.push([r.key, r.path, r.summary, r.tags.join(',')]);
    }
    console.log(t.toString());
    console.error(kleur.gray(`(${filtered.length} routes; use "cx query <key>" to call)`));
  } catch (err) {
    if (err instanceof CxApiError) {
      console.error(kleur.red(`✘ ${err.message}`));
    } else {
      console.error(kleur.red(`✘ ${(err as Error).message}`));
    }
    process.exit(1);
  }
}
