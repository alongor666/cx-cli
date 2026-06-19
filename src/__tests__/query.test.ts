import { describe, it, expect, vi } from 'vitest';
import { parseExtraParams, resolveTarget, resolveWithRefresh, formatLegend } from '../commands/query.js';
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

describe('formatLegend (cx query --describe)', () => {
  const legend = {
    route: 'RENEWAL_TRACKER',
    summary: '续保追踪',
    timeWindow: 'window',
    timeWindowNote: 'start/end 为保单【到期】窗口（续保盯盘口径），非签单日期窗口',
    columns: [
      { column: 'A', metricId: 'renewal_due_count', label: '应续件数', description: '续保窗口内应续保的车辆件数（按车架号去重）', unit: '件' },
      { column: 'C', metricId: 'renewal_renewed_count', label: '已续件数', description: '应续车中已签单成交续保的件数', unit: '件' },
    ],
  };

  it('标题含路由 key + 摘要，消灭裸字母（列字母 + 中文名同现）', () => {
    const out = formatLegend(legend, {});
    expect(out).toContain('字段图例');
    expect(out).toContain('RENEWAL_TRACKER');
    expect(out).toContain('续保追踪');
    // A 裸字母与中文名「应续件数」在同一图例里被绑定呈现
    expect(out).toContain('A');
    expect(out).toContain('应续件数');
    expect(out).toContain('已续件数');
  });

  it('展示时间口径（含到期窗口说明）', () => {
    const out = formatLegend(legend, {});
    expect(out).toContain('时间口径');
    expect(out).toContain('到期');
  });

  it('回显生效时间参数（start/end/cutoff）', () => {
    const out = formatLegend(legend, { start: '2026-06-01', end: '2026-06-30', cutoff: '2026-06-18', orgNames: '天府' });
    expect(out).toContain('生效参数');
    expect(out).toContain('start=2026-06-01');
    expect(out).toContain('cutoff=2026-06-18');
    // 非时间参数不混入「生效参数」行
    expect(out).not.toContain('orgNames=天府');
  });

  it('无时间参数时不打印「生效参数」行', () => {
    const out = formatLegend(legend, { orgNames: '天府' });
    expect(out).not.toContain('生效参数');
  });
});
