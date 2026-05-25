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
