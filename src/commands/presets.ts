/**
 * cx presets [-f json|table|csv]
 *
 * 返回筛选器 schema 和 9 个车型快捷预设。
 */
import kleur from 'kleur';
import { cxGet } from '../api.js';
import { failWith } from '../exit-codes.js';
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
    failWith(err);
  }
}
