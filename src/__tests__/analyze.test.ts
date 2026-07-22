import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ cxGet: vi.fn() }));
vi.mock('../api.js', () => ({ cxGet: mocks.cxGet }));

import {
  analyzeCommand,
  fetchAnalysisCapabilities,
  validateAnalysisParams,
  validateBranchSelection,
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

describe('cx analyze', () => {
  it('多省分析缺省或无权切省时 fail-closed，禁止回落默认省', () => {
    expect(validateBranchSelection(true, ['SC', 'SX'], undefined)).toMatch(/必须显式传/);
    expect(validateBranchSelection(true, ['SC', 'SX'], 'GD')).toMatch(/不在当前可切换范围/);
    expect(validateBranchSelection(true, ['SC', 'SX'], 'SX')).toBeNull();
    expect(validateBranchSelection(true, ['SC', 'SX'], 'ALL')).toBeNull();
  });

  it('从服务端能力目录发现而非在 CLI 内置 SQL', async () => {
    mocks.cxGet.mockResolvedValueOnce({ success: true, data: { version: 1, capabilities } });
    await expect(fetchAnalysisCapabilities()).resolves.toEqual(capabilities);
    expect(mocks.cxGet).toHaveBeenCalledWith('/api/discover/analysis-capabilities');
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
      .mockResolvedValueOnce({ success: true, data: { version: 1, capabilities } })
      .mockResolvedValueOnce({ success: true, data: { branchCode: 'SC', visibleBranches: ['SC', 'SX'] } })
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
