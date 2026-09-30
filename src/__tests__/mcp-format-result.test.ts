import { describe, it, expect } from 'vitest';
import { formatResult, unwrapEnvelope, resolveMaxBytes, DEFAULT_MAX_BYTES } from '../mcp/format-result.js';

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('unwrapEnvelope', () => {
  it('只有 data 时剥成 data', () => {
    expect(unwrapEnvelope({ success: true, data: [1, 2] })).toEqual([1, 2]);
  });

  it('保留 meta 等其余信封键，且排在 data 之前（硬截断从尾部砍，meta 必须幸存）', () => {
    const body = { success: true, data: { a: 1 }, meta: { window_start: '2026-01-01', latest_data_date: '2026-09-28' } };
    const out = unwrapEnvelope(body);
    expect(out).toEqual({ data: { a: 1 }, meta: body.meta });
    expect(Object.keys(out as object)).toEqual(['meta', 'data']);
  });

  it('非信封对象原样返回', () => {
    expect(unwrapEnvelope([1])).toEqual([1]);
    expect(unwrapEnvelope(null)).toBeNull();
  });
});

describe('formatResult', () => {
  it('未超限：紧凑 JSON，不截断', () => {
    const r = formatResult({ success: true, data: { x: 1 } }, 1_000);
    expect(r).toEqual({ text: '{"x":1}', truncated: false });
  });

  it('数组型 data 超限：按行截断、保留 meta、头部明示', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, name: '机构名称'.repeat(5) }));
    const r = formatResult({ success: true, data: rows, meta: { rowCount: 500 } }, 5_000);
    expect(r.truncated).toBe(true);
    expect(bytes(r.text)).toBeLessThanOrEqual(5_000);
    expect(r.text).toMatch(/^【结果已截断：data 仅返回前 \d+ \/ 500 行/);
    const json = JSON.parse(r.text.slice(r.text.indexOf('\n') + 1));
    expect(json.meta).toEqual({ rowCount: 500 });
    expect(json.data.length).toBeGreaterThan(0);
    expect(json.data.length).toBeLessThan(500);
  });

  it('裸数组超限同样按行截断', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ i, v: 'x'.repeat(40) }));
    const r = formatResult({ success: true, data: rows }, 2_000);
    expect(r.truncated).toBe(true);
    expect(bytes(r.text)).toBeLessThanOrEqual(2_000);
    expect(Array.isArray(JSON.parse(r.text.slice(r.text.indexOf('\n') + 1)))).toBe(true);
  });

  it('data 为对象、内嵌多个大数组（续保追踪形态）：逐个按行截断，meta 保留', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i, org: '临汾'.repeat(10) }));
    const body = { success: true, data: { orgRows: rows(400), teamRows: rows(300), note: 'x' }, meta: { latest_data_date: '2026-09-28' } };
    const r = formatResult(body, 3_000);
    expect(r.truncated).toBe(true);
    expect(bytes(r.text)).toBeLessThanOrEqual(3_000);
    expect(r.text).toMatch(/data\.orgRows 仅返回前 \d+ \/ 400 行/);
    const json = JSON.parse(r.text.slice(r.text.indexOf('\n') + 1));
    expect(json.meta).toEqual({ latest_data_date: '2026-09-28' });
    expect(json.data.note).toBe('x');
  });

  it('非数组超限：按字节硬截断，不切断多字节字符', () => {
    const r = formatResult({ success: true, data: { big: '保费'.repeat(5_000) } }, 1_500);
    expect(r.truncated).toBe(true);
    expect(bytes(r.text)).toBeLessThanOrEqual(1_500);
    expect(r.text).not.toContain('\uFFFD');
    expect(r.text).toContain('末尾 JSON 不完整');
  });
});

describe('formatResult 字节上限对任意入参成立（评审 F1）', () => {
  it.each([1, 10, 50, 200])('maxBytes=%i 小于截断提示本身时也不超限', (max) => {
    const r = formatResult({ success: true, data: { big: 'x'.repeat(50_000) } }, max);
    expect(r.truncated).toBe(true);
    expect(bytes(r.text)).toBeLessThanOrEqual(max);
  });
});

describe('resolveMaxBytes', () => {
  it('缺省 / 非法 / 过小值回落默认', () => {
    expect(resolveMaxBytes({})).toBe(DEFAULT_MAX_BYTES);
    expect(resolveMaxBytes({ CX_MCP_MAX_BYTES: 'abc' })).toBe(DEFAULT_MAX_BYTES);
    expect(resolveMaxBytes({ CX_MCP_MAX_BYTES: '10' })).toBe(DEFAULT_MAX_BYTES);
  });

  it('合法值生效', () => {
    expect(resolveMaxBytes({ CX_MCP_MAX_BYTES: '250000' })).toBe(250_000);
  });
});
