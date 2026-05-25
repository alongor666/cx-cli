/**
 * cx fields [--groupable] [-f json|table|csv]
 *
 * 列出字段注册表（42 个），可选过滤可分组字段。
 */
import kleur from 'kleur';
import { cxGet, CxApiError } from '../api.js';
import { renderOutput, type OutputFormat } from '../output.js';

interface Opts {
  groupable?: boolean;
  format?: OutputFormat;
}

export async function fieldsCommand(opts: Opts): Promise<void> {
  try {
    const resp = await cxGet<{ success: boolean; data: Array<Record<string, unknown>> }>(
      '/api/discover/fields',
      { query: opts.groupable ? { groupable: 'true' } : {} }
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
