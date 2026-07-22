import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ cxGet: vi.fn() }));
vi.mock('../api.js', () => ({ cxGet: mocks.cxGet }));

import {
  analyzeCommand,
  fetchAnalysisCapabilities,
  decodeCapabilitiesResponse,
  needsBranchScope,
  validateAnalysisParams,
  validateBranchSelection,
  versionAtLeast,
} from '../commands/analyze.js';

afterEach(() => {
  vi.restoreAllMocks();
  mocks.cxGet.mockReset();
});

const capabilities = [{
  id: 'operating-trend', name: '经营趋势', description: 'trend', path: '/trend',
  fullPath: '/api/query/trend', requiredParams: ['startDate', 'endDate'],
  allowedParams: ['startDate', 'endDate', 'granularity', 'targetBranch'],
  requiresExplicitBranchForMultiBranch: true, domain: 'operating',
}];

const catalog = {
  success: true,
  data: { version: 3, minCliVersion: '1.1.0', capabilities },
};

const multiScope = {
  defaultBranch: 'SC', visibleBranches: ['SC', 'SX'], canSwitch: true, canAggregateAll: true,
};

describe('cx analyze', () => {
  it('多省分析缺省或无权切省时 fail-closed，禁止回落默认省', () => {
    expect(validateBranchSelection(true, multiScope, undefined)).toMatch(/必须显式传/);
    expect(validateBranchSelection(true, multiScope, 'GD')).toMatch(/不在当前可切换范围/);
    expect(validateBranchSelection(true, multiScope, 'SX')).toBeNull();
    expect(validateBranchSelection(true, multiScope, 'ALL')).toBeNull();
    expect(validateBranchSelection(true, undefined, 'SC')).toMatch(/缺少规范化 branchScope/);
    expect(validateBranchSelection(true, {
      defaultBranch: 'SC', visibleBranches: ['SC'], canSwitch: false, canAggregateAll: false,
    }, 'ALL')).toMatch(/没有分公司合并视图权限/);
  });

  it('只有能力要求切省判断或调用方传了 targetBranch 时才读取身份范围', () => {
    expect(needsBranchScope(capabilities[0], {})).toBe(true);
    expect(needsBranchScope({ requiresExplicitBranchForMultiBranch: false }, {})).toBe(false);
    expect(needsBranchScope(
      { requiresExplicitBranchForMultiBranch: false },
      { targetBranch: 'SC' },
    )).toBe(true);
  });

  it('从服务端能力目录发现而非在 CLI 内置 SQL', async () => {
    mocks.cxGet.mockResolvedValueOnce(catalog);
    await expect(fetchAnalysisCapabilities()).resolves.toEqual(capabilities);
    expect(mocks.cxGet).toHaveBeenCalledWith('/api/discover/analysis-capabilities');
  });

  it('运行时校验目录形态与最低 CLI 版本', () => {
    expect(decodeCapabilitiesResponse(catalog).data.capabilities).toEqual(capabilities);
    expect(() => decodeCapabilitiesResponse({ success: true, data: { version: 3, minCliVersion: '1.1.0' } }))
      .toThrow(/能力目录契约异常/);
    expect(() => decodeCapabilitiesResponse({
      success: true,
      data: { version: 3, minCliVersion: '99.0.0', capabilities },
    })).toThrow(/低于服务端最低版本/);
    expect(versionAtLeast('1.1.0', '1.1.0')).toBe(true);
    expect(versionAtLeast('1.0.9', '1.1.0')).toBe(false);
  });

  it('按能力目录白名单拒绝未支持参数，避免服务端静默忽略', () => {
    expect(validateAnalysisParams(capabilities[0], {
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      targetBranch: 'SC',
    })).toBeNull();
    expect(validateAnalysisParams(capabilities[0], {
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      notAParam: 'x',
    })).toMatch(/不支持参数: notAParam/);
  });

  it('在显式省份下将参数转发给目录声明的只读路由', async () => {
    mocks.cxGet
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce({
        success: true,
        data: { branchCode: 'SC', visibleBranches: ['SC', 'SX'], branchScope: multiScope },
      })
      .mockResolvedValueOnce({ success: true, data: [{ period: '2026-W01', premium: 1 }] });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await analyzeCommand('operating-trend', {
      format: 'json',
      params: { startDate: '2026-01-01', endDate: '2026-01-31', targetBranch: 'SX' },
    });

    expect(mocks.cxGet).toHaveBeenLastCalledWith('/api/query/trend', {
      query: { startDate: '2026-01-01', endDate: '2026-01-31', targetBranch: 'SX' },
      timeoutMs: undefined,
    });
  });
});
