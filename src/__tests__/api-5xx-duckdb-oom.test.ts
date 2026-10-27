/**
 * cx ≥500 退避重试 · duckdb_oom 特判（CX-ADR-ee83ba 分叉二）。
 *
 * 服务端把 DuckDB OOM 映射为 503 + 长 Retry-After + code duckdb_oom 后，cx 若仍按
 * 普通 5xx 退避重试 4 次（1s+2s+4s），等于把同一条压垮内存的查询重放 4 轮——重试
 * 风暴雪上加霜。本文件锁三件事：
 *   1) duckdb_oom 码 → 零重试立即失败，Retry-After 透传（变异：删特判则红）；
 *   2) 其余 5xx → 退避行为不变（4 次尝试 / 1s+2s+4s）；
 *   3) 负例：400（用户 SQL 参数/语法错）不进 5xx 分支、不重试。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  loadConfig: () => ({ baseUrl: 'https://example.test', token: 'test-token' }),
}));
vi.mock('../http.js', () => ({
  attachTlsPersistence: vi.fn(),
}));

import { CxApiError, cxGet } from '../api.js';

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('duckdb_oom 特判（零重试 + Retry-After 透传）', () => {
  it('503 + code duckdb_oom → 立即失败不重试，retryAfter 与人读建议入错误', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(
      503,
      { success: false, error: { message: '查询执行失败 [abc123]', statusCode: 503, code: 'duckdb_oom' } },
      { 'Retry-After': '30' },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const err = (await cxGet('/api/query/kpi').catch((e: unknown) => e)) as CxApiError;
    expect(fetchMock).toHaveBeenCalledOnce(); // 零重试——变异：删 duckdb_oom 特判则调 4 次
    expect(err).toBeInstanceOf(CxApiError);
    expect(err.status).toBe(503);
    expect(err.retryAfter).toBe(30);
    expect(err.message).toContain('查询执行失败 [abc123]');
    expect(err.message).toContain('服务端内存溢出');
    expect(err.message).toContain('30s');
  });

  it('503 + duckdb_oom 但网关剥掉 Retry-After 头 → parseRetryAfter 兜底 60，仍不重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(
      503,
      { success: false, error: { message: '查询执行失败 [x]', statusCode: 503, code: 'duckdb_oom' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const err = (await cxGet('/api/query/kpi').catch((e: unknown) => e)) as CxApiError;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(err.retryAfter).toBe(60);
  });
});

describe('其余 5xx 退避行为不变', () => {
  it('连续 500 → 4 次尝试（1s+2s+4s 退避）后失败，消息透传服务端 body', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(
      500,
      { success: false, error: { message: '查询执行失败 [srv]', statusCode: 500 } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const pending = cxGet('/api/query/kpi').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
    const err = (await pending) as CxApiError;

    expect(fetchMock).toHaveBeenCalledTimes(4); // attempt 1-4
    expect(err).toBeInstanceOf(CxApiError);
    expect(err.status).toBe(500);
    expect(err.message).toContain('查询执行失败 [srv]');
  });

  it('503 无 duckdb_oom 码（域降级窗口等）→ 正常退避重试', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(
      503,
      { success: false, error: { message: '服务器繁忙，请稍后重试', statusCode: 503 } },
      { 'Retry-After': '30' },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const pending = cxGet('/api/query/kpi').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(7000);
    const err = (await pending) as CxApiError;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(err.status).toBe(503);
  });
});

describe('负例：400 不进 5xx 分支', () => {
  it('400（用户 SQL 语法错类）→ 单次请求直接失败', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(
      400,
      { success: false, error: { message: '查询执行失败 [u]：SQL 语法错误：请检查关键字 / 括号 / 引号配对', statusCode: 400 } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const err = (await cxGet('/api/query/sql', { query: { sql: 'SELEC 1 FROM PolicyFact' } })
      .catch((e: unknown) => e)) as CxApiError;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(err.status).toBe(400);
    expect(err.message).toContain('SQL 语法错误');
  });
});
