import { describe, it, expect } from 'vitest';
import { renderOutput } from '../output.js';

describe('renderOutput', () => {
  const rows = [
    { name: 'alice', score: 90 },
    { name: 'bob', score: 85 },
  ];

  it('json: 直接序列化', () => {
    const out = renderOutput({ data: rows }, 'json');
    expect(JSON.parse(out)).toEqual({ data: rows });
  });

  it('csv: 头 + 数据，处理特殊字符', () => {
    const out = renderOutput([{ a: 'hi, "world"', b: 1 }], 'csv');
    expect(out.split('\n')[0]).toBe('a,b');
    expect(out.split('\n')[1]).toBe('"hi, ""world""",1');
  });

  it('table: 渲染为字符串（包含表头）', () => {
    const out = renderOutput(rows, 'table');
    expect(out).toMatch(/name/);
    expect(out).toMatch(/score/);
    expect(out).toMatch(/alice/);
  });

  it('从 .data.rows 自动挖出 rows', () => {
    const wrapped = { data: { rows } };
    const out = renderOutput(wrapped, 'csv');
    expect(out).toContain('alice');
  });

  it('空数组：返回 (no rows)', () => {
    expect(renderOutput([], 'table')).toMatch(/no rows/);
  });

  // Bug fix: KPI 等单 object 响应原先走不进任何分支 → "(no rows)"
  it('单 object table: 渲染为 field/value 两列纵向表', () => {
    const kpi = { vehicle_premium: 169340278.56, policy_count: 2489786, latest_policy_date: '2026-05-11' };
    const out = renderOutput(kpi, 'table');
    expect(out).toMatch(/field/);
    expect(out).toMatch(/value/);
    expect(out).toMatch(/vehicle_premium/);
    expect(out).toMatch(/169340278/);
    expect(out).toMatch(/policy_count/);
    expect(out).toMatch(/2026-05-11/);
    expect(out).not.toMatch(/no rows/);
  });

  it('单 object csv: 渲染为单行 CSV', () => {
    const out = renderOutput({ a: 1, b: 'x' }, 'csv');
    const lines = out.split('\n');
    expect(lines[0]).toBe('a,b');
    expect(lines[1]).toBe('1,x');
  });

  it('空 object：返回 (no rows)', () => {
    expect(renderOutput({}, 'table')).toMatch(/no rows/);
  });

  // 回归: codex P2 — 空 wrapper 必须落到 (no rows)，不能被 KV 渲染吞掉
  it('空 rows wrapper { rows: [] }: 返回 (no rows) 而非 KV', () => {
    const out = renderOutput({ rows: [] }, 'table');
    expect(out).toMatch(/no rows/);
    // KV 渲染会产生 field/value 表头，确保没走到那
    expect(out).not.toMatch(/field/);
    expect(out).not.toMatch(/value/);
  });

  it('空 data array { data: [] }: 返回 (no rows)', () => {
    expect(renderOutput({ data: [] }, 'table')).toMatch(/no rows/);
  });

  it('空 nested rows { data: { rows: [] } }: 返回 (no rows)', () => {
    expect(renderOutput({ data: { rows: [] } }, 'table')).toMatch(/no rows/);
  });

  // 回归: .data.rows 优先级必须高于顶层 .rows（与注释一致）
  it('同时含 .rows 与 .data.rows 时，优先取 .data.rows', () => {
    const wrapped = {
      rows: [{ name: 'stale', score: 0 }],
      data: { rows: [{ name: 'real', score: 99 }] },
    };
    const out = renderOutput(wrapped, 'csv');
    expect(out).toContain('real');
    expect(out).not.toContain('stale');
  });

  // 回归: CSV 字段含 \r 必须被引号包裹，避免错行
  it('csv: 含 \\r 的字段被引号包裹', () => {
    const out = renderOutput([{ note: 'line1\r\nline2' }], 'csv');
    expect(out).toBe('note\n"line1\r\nline2"');
  });
});
