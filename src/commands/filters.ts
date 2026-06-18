/**
 * cx filters [--dimension <name>] [--refresh] [-f table|json|csv]
 *
 * GET /api/filters/options — 列出各筛选维度的可选值（受 dataScope 限制）。
 * 本地缓存 4h（按 PAT tokenId 隔离），--refresh 强制刷新；写 cx query 的过滤参数前用本命令查维度有哪些值。
 */
import fs from 'fs';
import kleur from 'kleur';
import { cxGet } from '../api.js';
import { getCachePath, loadConfig } from '../config.js';
import { renderOutput, type OutputFormat } from '../output.js';
import { failWith, EXIT } from '../exit-codes.js';

const CACHE_TTL_MS = 4 * 3600 * 1000;

function cacheFile(tokenId?: string): string {
  const suffix = tokenId ? `-${tokenId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)}` : '';
  return getCachePath(`filters${suffix}.json`);
}

async function fetchFilters(forceRefresh: boolean): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  const cachePath = cacheFile(cfg.tokenId);
  if (!forceRefresh && fs.existsSync(cachePath)) {
    const stat = fs.statSync(cachePath);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      try {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        const cached = JSON.parse(raw) as Record<string, unknown>;
        if (cached && Object.keys(cached).length > 0) return cached;
      } catch {
        // 缓存损坏，重新拉
      }
    }
  }
  const resp = await cxGet<{ success: boolean; data: Record<string, unknown> }>('/api/filters/options');
  const data = resp.data ?? {};
  try {
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    // 缓存写失败不影响功能
  }
  return data;
}

export async function filtersCommand(opts: { dimension?: string; refresh?: boolean; format?: OutputFormat }): Promise<void> {
  try {
    const all = await fetchFilters(Boolean(opts.refresh));
    if (opts.dimension && !(opts.dimension in all)) {
      console.error(kleur.red(`✘ 未知维度: ${opts.dimension}`));
      console.error(kleur.gray(`  可用维度: ${Object.keys(all).join(', ')}`));
      process.exit(EXIT.USAGE);
    }
    const picked = opts.dimension ? { [opts.dimension]: (all as Record<string, unknown>)[opts.dimension] ?? [] } : all;
    const rows = Object.entries(picked).map(([dimension, values]) => ({
      dimension,
      count: Array.isArray(values) ? values.length : '',
      values: Array.isArray(values) ? values.join(' | ') : JSON.stringify(values),
    }));
    const fmt: OutputFormat = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');
    console.log(renderOutput(rows, fmt));
  } catch (err) {
    failWith(err);
  }
}
