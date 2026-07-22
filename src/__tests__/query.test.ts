import { afterEach, describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cxGet: vi.fn(),
  fetchCatalog: vi.fn(),
}));

vi.mock('../api.js', () => ({ cxGet: mocks.cxGet }));
vi.mock('../commands/routes.js', () => ({ fetchCatalog: mocks.fetchCatalog }));

import {
  parseExtraParams,
  resolveTarget,
  resolveWithRefresh,
  formatLegend,
  formatImplicitBranchWarning,
  queryCommand,
} from '../commands/query.js';
import { applyPathParams } from '../path-params.js';
import { cliState } from '../cli-state.js';

afterEach(() => {
  cliState.quiet = false;
  vi.restoreAllMocks();
  mocks.cxGet.mockReset();
  mocks.fetchCatalog.mockReset();
});

describe('parseExtraParams', () => {
  it('解析 --key=value 形式', () => {
    expect(parseExtraParams(['--year=2026', '--org_level_3=分公司A']))
      .toEqual({ year: '2026', org_level_3: '分公司A' });
  });

  it('支持 --key value 形式且不静默吞参', () => {
    expect(parseExtraParams(['--year', '2026', '--org_level_3', '分公司A']))
      .toEqual({ year: '2026', org_level_3: '分公司A' });
  });

  it('裸 flag 与孤儿值 fail-closed', () => {
    expect(() => parseExtraParams(['--year=2026', '--debug'])).toThrow(/缺少值/);
    expect(() => parseExtraParams(['orphan'])).toThrow(/无法识别参数片段/);
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
    const { resolvedPath, restArgs } = applyPathParams('/api/query/example/:domain', {
      domain: 'renewal',
      year: '2026',
    });
    expect(resolvedPath).toBe('/api/query/example/renewal');
    expect(restArgs).toEqual({ year: '2026' });
  });

  it('缺少 path 参数时抛错', () => {
    expect(() => applyPathParams('/api/query/example/:domain', {})).toThrow(/domain/);
  });
});

describe('formatImplicitBranchWarning', () => {
  const multiBranch = { branchCode: 'SC', visibleBranches: ['SC', 'SX'] };

  it('多省账号未指定 targetBranch → 明示默认省与可见省份', () => {
    const warning = formatImplicitBranchWarning(multiBranch, {});
    expect(warning).toContain('默认省 SC');
    expect(warning).toContain('SC, SX');
    expect(warning).toContain('--targetBranch=<省代码>');
  });

  it('显式指定有权省份 → 不提示', () => {
    expect(formatImplicitBranchWarning(multiBranch, { targetBranch: 'SX' })).toBeNull();
    expect(formatImplicitBranchWarning(multiBranch, { targetBranch: 'ALL' })).toBeNull();
  });

  it('显式指定无权省份 → 警告服务端将回落默认省', () => {
    const warning = formatImplicitBranchWarning(multiBranch, { targetBranch: 'BJ' });
    expect(warning).toContain('targetBranch=BJ');
    expect(warning).toContain('默认省 SC');
    expect(warning).toContain('SC, SX');
  });

  it('普通账号传入非本人省份 → 警告参数不会生效', () => {
    const warning = formatImplicitBranchWarning(
      { branchCode: 'SX', visibleBranches: undefined },
      { targetBranch: 'BJ' },
    );
    expect(warning).toContain('默认省 SX');
    expect(warning).toContain('无跨省切换权限');
  });

  it('省代码大小写错误不会被客户端误判为授权', () => {
    const warning = formatImplicitBranchWarning(multiBranch, { targetBranch: 'sx' });
    expect(warning).toContain('targetBranch=sx');
    expect(warning).toContain('默认省 SC');
  });

  it('普通单省用户 → 不提示', () => {
    expect(formatImplicitBranchWarning(
      { branchCode: 'SX', visibleBranches: undefined },
      {},
    )).toBeNull();
  });
});

describe('queryCommand 省份提示请求', () => {
  it('--quiet 时不请求 /api/auth/me，只发送主查询', async () => {
    cliState.quiet = true;
    mocks.fetchCatalog.mockResolvedValue([
      { key: 'KPI', path: '/kpi', fullPath: '/api/query/kpi' },
    ]);
    mocks.cxGet.mockResolvedValue({ success: true, data: [] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await queryCommand('KPI', { params: {}, format: 'json' });

    expect(mocks.cxGet).toHaveBeenCalledTimes(1);
    expect(mocks.cxGet).toHaveBeenCalledWith('/api/query/kpi', {
      query: {},
      timeoutMs: undefined,
    });
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
