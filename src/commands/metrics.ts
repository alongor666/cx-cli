/**
 * cx metrics [--category <cat>] [-f json|table|csv]
 *
 * 列出指标注册表（25 个），可按 category 过滤。
 * 不返回 SQL 表达式 — Agent 必须走 PIVOT/SQL 路由调用。
 */
import kleur from 'kleur';
import { cxGet, CxApiError } from '../api.js';
import { renderOutput, type OutputFormat } from '../output.js';

interface Opts {
  category?: string;
  format?: OutputFormat;
}

export async function metricsCommand(opts: Opts): Promise<void> {
  try {
    const query: Record<string, string> = {};
    if (opts.category) query.category = opts.category;
    const resp = await cxGet<{ success: boolean; data: Array<Record<string, unknown>> }>(
      '/api/discover/metrics',
      { query }
    );
    const fmt: OutputFormat = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');
    console.log(renderOutput(resp.data, fmt));
  } catch (err) {
    if (err instanceof CxApiError) {
      console.error(kleur.red(`✘ ${err.message}`));
      process.exit(err.status === 401 ? 2 : 1);
    }
    console.error(kleur.red(`✘ ${(err as Error).message}`));
    process.exit(1);
  }
}
