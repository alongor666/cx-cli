/**
 * cx presets [-f json|table|csv]
 *
 * 返回筛选器 schema 和 9 个车型快捷预设。
 */
import kleur from 'kleur';
import { cxGet, CxApiError } from '../api.js';
import { renderOutput, type OutputFormat } from '../output.js';

interface Opts {
  format?: OutputFormat;
}

export async function presetsCommand(opts: Opts): Promise<void> {
  try {
    const resp = await cxGet<{ success: boolean; data: unknown }>('/api/discover/presets');
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
