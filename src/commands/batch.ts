/**
 * cx batch — 从 stdin 读 JSONL 批量调用查询路由，复用 keep-alive 连接。
 *
 * 输入：每行一个 JSON 对象 { route: "<key|path>", params?: {...} }
 * 输出：每行一个 JSON 对象 { route, ok, data?, error?, latency_ms }
 *       --summary 末尾追加 { total, ok, fail, total_ms, p50_ms, p95_ms }
 *
 * 用法：
 *   echo '{"route":"/health"}' | cx batch
 *   cat queries.jsonl | cx batch --concurrency=8 --summary
 *
 * 性能：100 行 /health 在生产 baseUrl 下应 < 1.5s（vs 串行无 keep-alive ~6s）。
 */
import { performance } from 'node:perf_hooks';
import { cxGet, CxApiError } from '../api.js';
import { applyPathParams } from '../path-params.js';
import { resolveWithRefresh, resolveTarget } from './query.js';
import { fetchCatalog, type RouteMeta } from './routes.js';
import { failWith, EXIT } from '../exit-codes.js';

interface BatchOpts {
  concurrency: number;
  summary: boolean;
  timeoutMs?: number;
}

interface BatchInput {
  route: string;
  params?: Record<string, string | number | boolean>;
}

interface BatchResult {
  route: string;
  ok: boolean;
  data?: unknown;
  error?: { status: number; message: string };
  latency_ms: number;
}

async function readStdinLines(): Promise<BatchInput[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return [];
  return text
    .split('\n')
    .map((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed) as BatchInput;
        if (!parsed.route) throw new Error(`line ${idx + 1}: missing "route"`);
        return parsed;
      } catch (err) {
        throw new Error(`stdin line ${idx + 1} invalid JSONL: ${(err as Error).message}`);
      }
    })
    .filter((x): x is BatchInput => x !== null);
}

async function runOne(
  input: BatchInput,
  routeResolver: (raw: string) => Promise<{ fullPath: string } | null>,
  timeoutMs?: number,
): Promise<BatchResult> {
  const start = performance.now();
  try {
    const target = await routeResolver(input.route);
    if (!target) {
      return {
        route: input.route,
        ok: false,
        error: { status: 404, message: `Unknown route: ${input.route}` },
        latency_ms: Math.round(performance.now() - start),
      };
    }
    const stringParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.params ?? {})) {
      if (v !== undefined && v !== null) stringParams[k] = String(v);
    }
    const { resolvedPath, restArgs } = applyPathParams(target.fullPath, stringParams);
    const data = await cxGet<unknown>(resolvedPath, { query: restArgs, timeoutMs });
    return {
      route: input.route,
      ok: true,
      data: (data as any)?.data ?? data,
      latency_ms: Math.round(performance.now() - start),
    };
  } catch (err) {
    const latency_ms = Math.round(performance.now() - start);
    if (err instanceof CxApiError) {
      return { route: input.route, ok: false, error: { status: err.status, message: err.message }, latency_ms };
    }
    return {
      route: input.route,
      ok: false,
      error: { status: 0, message: (err as Error).message },
      latency_ms,
    };
  }
}

function quantile(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * batch 路径解析（纯函数，便于单测）。
 *
 * 输入 raw 三种形态 + 解析规则：
 *   1) catalog key（不以 / 开头）          → 走 resolveTarget 宽容匹配（KPI / kpi / 'claims-detail-heatmap' 等）
 *   2) /api/* 顶层 API path（含 query/data/auth 等）  → 直通，不再加前缀
 *   3) / 开头的 catalog 登记 path（如 /kpi）            → 包装为 catalog 登记的 fullPath（带 /api/query）
 *   4) / 开头但 catalog 未登记的顶层 path（如 /health） → **直通顶层**（修正：旧实现错误包装为 /api/query/health）
 *
 * 返回 { fullPath } 或 null（catalog key 未命中）。
 */
export function resolveBatchRoute(
  raw: string,
  catalog: RouteMeta[] | null,
): { fullPath: string } | null {
  // 非 / 开头：catalog key 寻址
  if (!raw.startsWith('/')) {
    if (!catalog) return null;
    const hit = resolveTarget(raw, catalog);
    return hit ? { fullPath: hit.fullPath } : null;
  }
  // /api/* 直通（含 /api/query/*、/api/data/*、/api/auth/*）
  if (raw.startsWith('/api/')) {
    return { fullPath: raw };
  }
  // / 开头：先查 catalog（/kpi 等登记 path）
  if (catalog) {
    const byCatalog = catalog.find((r) => r.path === raw);
    if (byCatalog) return { fullPath: byCatalog.fullPath };
  }
  // catalog miss：顶层直通（/health 等）
  return { fullPath: raw };
}

/**
 * 并发池：连续吃 inputs 队列，concurrency 个 worker 共享同一全局 dispatcher（keep-alive 复用）。
 * inputs 顺序保留（输出按 inputs 索引写回，而非完成顺序）。
 */
async function runPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function batchCommand(opts: BatchOpts): Promise<void> {
  try {
    if (process.stdin.isTTY) {
      console.error('cx batch: 期望从 stdin 读 JSONL（每行 {route, params?}），交互模式无 stdin。');
      console.error('示例: echo \'{"route":"KPI","params":{"year":2026}}\' | cx batch --summary');
      console.error('      echo \'{"route":"/health"}\' | cx batch          # 顶层直通');
      process.exit(EXIT.USAGE);
    }
    const inputs = await readStdinLines();
    if (inputs.length === 0) {
      console.error('cx batch: stdin 为空，无任务');
      process.exit(EXIT.USAGE);
    }

    // 预热 catalog 一次，所有 worker 共用，避免每 worker 重复 fetch
    let catalog: RouteMeta[] | null = null;
    try {
      catalog = await fetchCatalog(false);
    } catch {
      catalog = null;
    }
    const routeResolver = async (raw: string) => {
      // catalog 未拉到（fetch 失败）+ 非 / 开头的 key：触发一次强制刷新
      if (!catalog && !raw.startsWith('/')) {
        const r = await resolveWithRefresh(raw, fetchCatalog);
        return r.route;
      }
      return resolveBatchRoute(raw, catalog);
    };

    const start = performance.now();
    const results = await runPool(inputs, opts.concurrency, (input) =>
      runOne(input, routeResolver, opts.timeoutMs),
    );
    const totalMs = Math.round(performance.now() - start);

    for (const r of results) {
      process.stdout.write(JSON.stringify(r) + '\n');
    }

    if (opts.summary) {
      const latencies = results.map((r) => r.latency_ms);
      const okCount = results.filter((r) => r.ok).length;
      const summary = {
        total: results.length,
        ok: okCount,
        fail: results.length - okCount,
        total_ms: totalMs,
        p50_ms: quantile(latencies, 0.5),
        p95_ms: quantile(latencies, 0.95),
        avg_ms: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      };
      process.stderr.write(JSON.stringify(summary, null, 2) + '\n');
    }
  } catch (err) {
    failWith(err);
  }
}
