import { describe, it, expect, vi } from 'vitest';
import { parseExtraParams, resolveTarget, resolveWithRefresh } from '../commands/query.js';
import { applyPathParams } from '../path-params.js';

describe('parseExtraParams', () => {
  it('解析 --key=value 形式', () => {
    expect(parseExtraParams(['--year=2026', '--org_level_3=分公司A']))
      .toEqual({ year: '2026', org_level_3: '分公司A' });
  });

  it('忽略不含 = 的参数', () => {
    expect(parseExtraParams(['--year=2026', '--debug'])).toEqual({ year: '2026' });
  });

  it('保留 = 之后的所有内容（含等号）', () => {
    expect(parseExtraParams(['--filter=a=b']))
      .toEqual({ filter: 'a=b' });
  });
});

describe('resolveTarget', () => {
  const routes = [
    { key: 'KPI', path: '/kpi', fullPath: '/api/query/kpi' },
    { key: 'CLAIMS_DETAIL_HEATMAP', path: '/claims-detail/heatmap', fullPath: '/api/query/claims-detail/heatmap' },
  ];

  it('key 宽容匹配（小写/中划线 → 大写下划线）', () => {
    expect(resolveTarget('kpi', routes)?.fullPath).toBe('/api/query/kpi');
    expect(resolveTarget('claims-detail-heatmap', routes)?.fullPath).toBe('/api/query/claims-detail/heatmap');
  });

  it('catalog path 命中', () => {
    expect(resolveTarget('/kpi', routes)?.fullPath).toBe('/api/query/kpi');
    expect(resolveTarget('/claims-detail/heatmap', routes)?.key).toBe('CLAIMS_DETAIL_HEATMAP');
  });

  it('catalog 未登记的 / 开头 path 直通拼接', () => {
    expect(resolveTarget('/repair/overview', routes)?.fullPath).toBe('/api/query/repair/overview');
  });

  it('非 path 且 catalog 无匹配 → null', () => {
    expect(resolveTarget('nonexistent', routes)).toBeNull();
  });
});

describe('resolveWithRefresh（缓存未命中自动刷新）', () => {
  const staleRoutes = [{ key: 'KPI', path: '/kpi', fullPath: '/api/query/kpi' }];
  const freshRoutes = [
    ...staleRoutes,
    { key: 'NEW_ROUTE', path: '/new-route', fullPath: '/api/query/new-route' },
  ];

  it('首次命中 → 不触发刷新', async () => {
    const fetch = vi.fn().mockResolvedValue(staleRoutes);
    const { route, refreshed } = await resolveWithRefresh('KPI', fetch);
    expect(route?.fullPath).toBe('/api/query/kpi');
    expect(refreshed).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(false);
  });

  it('缓存 miss、强制刷新后命中（新路由上线场景）', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(staleRoutes)
      .mockResolvedValueOnce(freshRoutes);
    const { route, refreshed } = await resolveWithRefresh('new-route', fetch);
    expect(route?.fullPath).toBe('/api/query/new-route');
    expect(refreshed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(2, true);
  });

  it('刷新后仍 miss → route 为 null 且标记已刷新', async () => {
    const fetch = vi.fn().mockResolvedValue(staleRoutes);
    const { route, refreshed } = await resolveWithRefresh('nonexistent', fetch);
    expect(route).toBeNull();
    expect(refreshed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('/ 开头 path 直通永远命中 → 不触发刷新', async () => {
    const fetch = vi.fn().mockResolvedValue(staleRoutes);
    const { route, refreshed } = await resolveWithRefresh('/repair/overview', fetch);
    expect(route?.fullPath).toBe('/api/query/repair/overview');
    expect(refreshed).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('applyPathParams (cli)', () => {
  it(':domain 替换且从参数移除', () => {
    const { resolvedPath, restArgs } = applyPathParams('/api/query/patrol/:domain', {
      domain: 'renewal',
      year: '2026',
    });
    expect(resolvedPath).toBe('/api/query/patrol/renewal');
    expect(restArgs).toEqual({ year: '2026' });
  });

  it('缺少 path 参数时抛错', () => {
    expect(() => applyPathParams('/api/query/patrol/:domain', {})).toThrow(/domain/);
  });
});
