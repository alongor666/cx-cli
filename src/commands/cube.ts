/**
 * cx cube --metric=<id> --dims=<d1,d2,...> [--start --end --cutoff] [--<filter>=v ...]
 *
 * 语义层「选指标 × 任意维度子集」可组合查询（GET /api/query/cube）。
 * 服务端按指标域分派：
 *   - 续保族计数指标（renewal_*_count）→ RenewalTrackerFact 任意维度子集聚合，
 *     输出 A-E + 派生续保率/未报价率/流失率。需 --start/--end（到期窗口）+ --cutoff（观察截止日）。
 *   - PolicyFact 可加/比率指标 → 复用 pivot 生成器（1-2 维），走签单窗口标准筛选器。
 *
 * 额外 --<筛选>=值（如 --orgNames=天府 / --isNewCar=true）透传为 query 参数（与 cx query 一致）。
 */
import kleur from 'kleur';
import { cxGet } from '../api.js';
import { renderOutput, type OutputFormat } from '../output.js';
import { failWith } from '../exit-codes.js';
import { note } from '../cli-state.js';

export interface CubeOpts {
  /** 单个指标 id（必填） */
  metric: string;
  /** 逗号分隔维度子集（续保 0-4 维 / PolicyFact 1-2 维） */
  dims?: string;
  /** 续保路径：到期窗口起 YYYY-MM-DD */
  start?: string;
  /** 续保路径：到期窗口止 YYYY-MM-DD */
  end?: string;
  /** 续保路径：观察截止日 YYYY-MM-DD */
  cutoff?: string;
  /** 返回行数上限 */
  limit?: number;
  format?: OutputFormat;
  timeoutMs?: number;
  /** 额外筛选 query 参数（--orgNames=... 等，透传） */
  params: Record<string, string>;
}

interface CubeResponse {
  success: boolean;
  data: {
    domain: string;
    relation: string;
    metric: string;
    dimensions: string[];
    rowCount: number;
    rows: Array<Record<string, unknown>>;
  };
}

export async function cubeCommand(opts: CubeOpts): Promise<void> {
  try {
    const query: Record<string, string | number | undefined> = {
      metric: opts.metric,
      // 后端接受 dimensions / dims 两个参数名；统一发 dimensions
      dimensions: opts.dims,
      start: opts.start,
      end: opts.end,
      cutoff: opts.cutoff,
      limit: opts.limit,
      ...opts.params,
    };
    const resp = await cxGet<CubeResponse>('/api/query/cube', { query, timeoutMs: opts.timeoutMs });
    const data = resp.data;
    const fmt: OutputFormat = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');
    // 元信息打到 stderr（保持 stdout 纯数据可管道）
    note(
      kleur.gray(
        `(域 ${data.domain} · 关系 ${data.relation} · 指标 ${data.metric} · ` +
          `维度 ${data.dimensions.length ? data.dimensions.join(',') : '整体'} · ${data.rowCount} 行)`
      )
    );
    console.log(renderOutput(data.rows, fmt));
  } catch (err) {
    failWith(err);
  }
}
