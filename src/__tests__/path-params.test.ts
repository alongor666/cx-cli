import { describe, it, expect } from 'vitest';
import { applyPathParams } from '../path-params.js';

describe('applyPathParams', () => {
  it('无 path 参数时原样返回，args 不变', () => {
    const { resolvedPath, restArgs } = applyPathParams('/api/query/kpi', { year: 2026 });
    expect(resolvedPath).toBe('/api/query/kpi');
    expect(restArgs).toEqual({ year: 2026 });
  });

  it(':domain 被替换且从 args 移除', () => {
    const { resolvedPath, restArgs } = applyPathParams('/api/query/example/:domain', {
      domain: 'renewal',
      year: 2026,
    });
    expect(resolvedPath).toBe('/api/query/example/renewal');
    expect(restArgs).toEqual({ year: 2026 });
  });

  it('多段模板逐一替换（/example/:domain/narrative）', () => {
    const { resolvedPath } = applyPathParams('/api/query/example/:domain/narrative', {
      domain: 'renewal',
    });
    expect(resolvedPath).toBe('/api/query/example/renewal/narrative');
  });

  it('path 参数值做 URI 编码', () => {
    const { resolvedPath } = applyPathParams('/api/query/example/:domain', { domain: '续保' });
    expect(resolvedPath).toBe(`/api/query/example/${encodeURIComponent('续保')}`);
  });

  it('缺少必需 path 参数时抛错', () => {
    expect(() => applyPathParams('/api/query/example/:domain', {})).toThrow(/domain/);
  });

  it('不可变：原 args 对象不被修改', () => {
    const args = { domain: 'renewal' };
    applyPathParams('/api/query/example/:domain', args);
    expect(args).toEqual({ domain: 'renewal' });
  });
});
