/**
 * cx describe <relation> [-f json|table|csv]
 *
 * 自省视图 schema（列名/类型/可空）。relation 须在联邦白名单内
 * （默认仅 PolicyFact；SQL_FEDERATION_ENABLED 开启后含 RenewalTrackerFact 等派生视图）。
 * 后端：GET /api/discover/schema?relation=<view>（受控 DESCRIBE，仅返回 schema 元数据）。
 */
import { cxGet } from '../api.js';
import { failWith } from '../exit-codes.js';
import { renderOutput, type OutputFormat } from '../output.js';

interface Opts {
  format?: OutputFormat;
}

interface SchemaResponse {
  success: boolean;
  data: {
    relation: string;
    columns: Array<Record<string, unknown>>;
  };
}

export async function describeCommand(relation: string, opts: Opts): Promise<void> {
  try {
    const resp = await cxGet<SchemaResponse>('/api/discover/schema', {
      query: { relation },
    });
    const fmt: OutputFormat = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');
    // json 输出保留 {relation, columns} 全貌；table/csv 输出列清单
    if (fmt === 'json') {
      console.log(renderOutput(resp.data, fmt));
    } else {
      console.log(renderOutput(resp.data.columns, fmt));
    }
  } catch (err) {
    failWith(err);
  }
}
