/**
 * cx data <version|files|metadata> [-f table|json|csv]
 *
 * 数据域只读元信息：
 *   version  — 当前 ETL 数据日期与构建时间（数据新鲜度）
 *   files    — 已加载数据文件清单
 *   metadata — 数据集元数据（表/行数/日期范围）
 */
import { cxGet } from '../api.js';
import { renderOutput, type OutputFormat } from '../output.js';
import { failWith } from '../exit-codes.js';

const SUB_ENDPOINTS = {
  version: '/api/data/version',
  files: '/api/data/files',
  metadata: '/api/data/metadata',
} as const;

export type DataSub = keyof typeof SUB_ENDPOINTS;

export async function dataCommand(sub: DataSub, opts: { format?: OutputFormat }): Promise<void> {
  try {
    const resp = await cxGet<{ success: boolean; data: unknown }>(SUB_ENDPOINTS[sub]);
    const fmt: OutputFormat = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');
    console.log(renderOutput((resp as any)?.data ?? resp, fmt));
  } catch (err) {
    failWith(err);
  }
}
