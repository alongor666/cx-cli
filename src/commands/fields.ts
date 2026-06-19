/**
 * cx fields [--groupable] [--verbose] [-f json|table|csv]
 *
 * 列出字段注册表（数量以注册表为准）。每个字段附 PolicyFact 可查真值：
 * column（唯一可 SELECT 的列名）/ queryable / actualType。--verbose 才附 ETL 入库别名。
 */
import kleur from 'kleur';
import { cxGet } from '../api.js';
import { failWith } from '../exit-codes.js';
import { renderOutput, type OutputFormat } from '../output.js';

interface Opts {
  groupable?: boolean;
  verbose?: boolean;
  format?: OutputFormat;
}

export async function fieldsCommand(opts: Opts): Promise<void> {
  try {
    const query: Record<string, string> = {};
    if (opts.groupable) query.groupable = 'true';
    if (opts.verbose) query.verbose = 'true';
    const resp = await cxGet<{ success: boolean; data: Array<Record<string, unknown>> }>(
      '/api/discover/fields',
      { query }
    );
    const fmt: OutputFormat = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');
    console.log(renderOutput(resp.data, fmt));
  } catch (err) {
    failWith(err);
  }
}
