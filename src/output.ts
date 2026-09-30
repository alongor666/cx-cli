/**
 * 输出格式化：table / json / csv
 */
import Table from 'cli-table3';
import kleur from 'kleur';

export type OutputFormat = 'table' | 'json' | 'csv';

export function renderOutput(data: unknown, format: OutputFormat): string {
  if (format === 'json') return JSON.stringify(data, null, 2);

  // extractRows: null = 非 list 型响应；[] = list 型但空。分流避免空 wrapper 被当 KV 渲染。
  const rows = extractRows(data);
  if (rows !== null) {
    if (rows.length === 0) return kleur.gray('(no rows)');
    return format === 'csv' ? toCsv(rows) : toTable(rows);
  }

  // KPI/summary 类路由返回单 object（非数组）：纵向 key/value 渲染
  const kv = extractKeyValue(data);
  if (kv) {
    return format === 'csv' ? toCsv([Object.fromEntries(kv)]) : toKeyValueTable(kv);
  }

  return kleur.gray('(no rows)');
}

/** 从 API 响应里挖出 rows 数组 */
function extractRows(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  // 顺序：顶层 .rows → .data（数组）→ .data.rows
  if (Array.isArray(d.rows)) return d.rows as Record<string, unknown>[];
  if (d.data && typeof d.data === 'object') {
    const inner = d.data as Record<string, unknown>;
    if (Array.isArray(inner)) return inner as Record<string, unknown>[];
    if (Array.isArray(inner.rows)) return inner.rows as Record<string, unknown>[];
  }
  return null;
}

/** 单 object 响应（如 KPI）→ [key, value] 列表 */
function extractKeyValue(data: unknown): Array<[string, unknown]> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const entries = Object.entries(data as Record<string, unknown>);
  return entries.length > 0 ? entries : null;
}

function toKeyValueTable(entries: Array<[string, unknown]>): string {
  const t = new Table({
    head: [kleur.cyan('field'), kleur.cyan('value')],
    style: { head: [], border: ['gray'] },
  });
  for (const [k, v] of entries) t.push([k, formatCell(v)]);
  return t.toString();
}

function toTable(rows: Record<string, unknown>[]): string {
  const headers = collectHeaders(rows);
  const t = new Table({
    head: headers.map((h) => kleur.cyan(h)),
    style: { head: [], border: ['gray'] },
  });
  for (const r of rows) {
    t.push(headers.map((h) => formatCell(r[h])));
  }
  return t.toString();
}

function toCsv(rows: Record<string, unknown>[]): string {
  const headers = collectHeaders(rows);
  const lines: string[] = [headers.map((h) => csvEscape(neutralizeFormula(h))).join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => {
      const v = r[h];
      const cell = formatCell(v);
      return csvEscape(typeof v === 'string' ? neutralizeFormula(cell) : cell);
    }).join(','));
  }
  return lines.join('\n');
}

/**
 * CSV 公式注入防护（OWASP）：以 = + - @ Tab CR 开头的文本单元格在 Excel/WPS 中会被当公式执行
 * （如 =HYPERLINK(...) 外带数据）。只处理字符串单元格且放过纯数字文本（"-12.5"），数值列不受影响。
 */
export function neutralizeFormula(cell: string): string {
  if (!/^[=+\-@\t\r]/.test(cell)) return cell;
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(cell)) return cell;
  return `'${cell}`;
}

function collectHeaders(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return Array.from(seen);
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
