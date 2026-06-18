/**
 * cx sql "<query>" | cx sql -   [-f table|json|csv]
 *
 * DuckDB SELECT/WITH 直通。复杂查询安全兜底。
 * 强制聚合 + 必须含 PolicyFact + ≤8000 字符 + 拒绝 policy_no 明细。
 * RLS 由后端自动注入。
 *
 * 参数为 - 时从 stdin 读取 SQL（管道友好）：echo "SELECT ..." | cx sql -
 */
import kleur from 'kleur';
import { cxGet } from '../api.js';
import { renderOutput, type OutputFormat } from '../output.js';
import { failWith, EXIT } from '../exit-codes.js';

interface Opts {
  format?: OutputFormat;
  timeoutMs?: number;
}

/** 参数为 - 时从 stdin 读取 SQL，否则原样返回 */
export async function readSqlInput(arg: string, stdin: NodeJS.ReadableStream | null): Promise<string> {
  if (arg !== '-') return arg;
  if (!stdin) throw new Error('SQL 参数为 - 但 stdin 不可用');
  const chunks: Buffer[] = [];
  for await (const c of stdin) chunks.push(Buffer.from(c as Buffer));
  const sql = Buffer.concat(chunks).toString('utf-8').trim();
  if (!sql) throw new Error('stdin 为空，请输入 SELECT/WITH 查询');
  return sql;
}

export async function sqlCommand(query: string, opts: Opts): Promise<void> {
  try {
    const sql = await readSqlInput(query ?? '', query === '-' ? process.stdin : null);
    if (!sql || sql.trim() === '') {
      console.error(kleur.red('✘ Missing SQL query. Usage: cx sql "<query>" 或 echo "<query>" | cx sql -'));
      process.exit(EXIT.USAGE);
    }
    const resp = await cxGet<{ success: boolean; data: unknown }>('/api/query/sql', {
      query: { sql },
      timeoutMs: opts.timeoutMs,
    });
    const fmt: OutputFormat = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');
    console.log(renderOutput(resp.data, fmt));
  } catch (err) {
    failWith(err);
  }
}
