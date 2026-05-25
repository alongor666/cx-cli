/**
 * cx sql "<query>" [-f table|json|csv]
 *
 * DuckDB SELECT/WITH 直通。复杂查询安全兜底。
 * 强制聚合 + 必须含 PolicyFact + ≤8000 字符 + 拒绝 policy_no 明细。
 * RLS 由后端自动注入。
 */
import kleur from 'kleur';
import { cxGet, CxApiError } from '../api.js';
import { renderOutput, type OutputFormat } from '../output.js';

interface Opts {
  format?: OutputFormat;
}

export async function sqlCommand(query: string, opts: Opts): Promise<void> {
  if (!query || query.trim() === '') {
    console.error(kleur.red('✘ Missing SQL query. Usage: cx sql "<query>"'));
    process.exit(1);
  }
  try {
    const resp = await cxGet<{ success: boolean; data: unknown }>('/api/query/sql', {
      query: { sql: query },
    });
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
