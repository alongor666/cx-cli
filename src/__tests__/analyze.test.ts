import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ cxGet: vi.fn(), cxGetWithMeta: vi.fn() }));
vi.mock('../api.js', () => ({ cxGet: mocks.cxGet, cxGetWithMeta: mocks.cxGetWithMeta }));
vi.mock('../config.js', () => ({
  loadConfig: () => ({ baseUrl: 'https://example.test', tokenId: 'pat-test' }),
}));

import {
  analyzeCommand,
  fetchAnalysisCapabilities,
  decodeCapabilitiesResponse,
  needsBranchScope,
  sha256Canonical,
  validateAnalysisParams,
  validateAnalysisResult,
  validateBranchSelection,
  versionAtLeast,
} from '../commands/analyze.js';

afterEach(() => {
  vi.restoreAllMocks();
  mocks.cxGet.mockReset();
  mocks.cxGetWithMeta.mockReset();
});

const capabilities = [{
  id: 'operating-trend', name: '经营趋势', description: 'trend', path: '/trend',
  fullPath: '/api/query/trend', requiredParams: ['startDate', 'endDate'],
  allowedParams: ['startDate', 'endDate', 'granularity', 'targetBranch'],
  requiresExplicitBranchForMultiBranch: true, domain: 'operating',
  parameters: [
    { name: 'startDate', type: 'date', required: true, description: '开始日期' },
    { name: 'endDate', type: 'date', required: true, description: '结束日期' },
    { name: 'targetBranch', type: 'string', description: '分公司' },
  ],
  timeWindow: 'window',
  resultSchema: {
    id: 'operating.trend.v1', version: 1, kind: 'records', recordsPath: '$',
    requiredFields: ['time_period', 'premium'], dimensionFields: ['time_period'], metricFields: ['premium'],
  },
}];

const catalog = {
  success: true,
  data: { version: 5, minCliVersion: '1.3.0', capabilities },
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
    expect(() => decodeCapabilitiesResponse({ success: true, data: { version: 5, minCliVersion: '1.3.0' } }))
      .toThrow(/能力目录契约异常/);
    expect(() => decodeCapabilitiesResponse({
      success: true,
      data: { version: 4, minCliVersion: '99.0.0', capabilities },
    })).toThrow(/低于服务端最低版本/);
    expect(versionAtLeast('1.3.0', '1.3.0')).toBe(true);
    expect(versionAtLeast('1.2.9', '1.3.0')).toBe(false);
  });

  it('按 resultSchema fail-closed 校验形态和必需字段', () => {
    const schema = capabilities[0].resultSchema;
    expect(validateAnalysisResult(schema, [{ time_period: '2026-W01', premium: 1 }])).toBeNull();
    expect(validateAnalysisResult(schema, { time_period: '2026-W01', premium: 1 })).toMatch(/预期.*数组/);
    expect(validateAnalysisResult(schema, [{ time_period: '2026-W01' }])).toMatch(/缺少字段 premium/);
    expect(validateAnalysisResult({ ...schema, recordsPath: '$.rows' }, {
      rows: [{ time_period: '2026-W01', premium: 1 }],
    })).toBeNull();
  });

  it('规范化 SHA-256 不受对象键顺序影响，结果变化会改变指纹', () => {
    const left = sha256Canonical({ b: 2, a: { y: 2, x: 1 } });
    expect(left).toBe(sha256Canonical({ a: { x: 1, y: 2 }, b: 2 }));
    expect(left).not.toBe(sha256Canonical({ a: { x: 1, y: 3 }, b: 2 }));
    expect(left).toMatch(/^[a-f0-9]{64}$/);
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
      .mockResolvedValueOnce({ success: true, data: [{ time_period: '2026-W01', premium: 1 }] });
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

  it('evidence 模式输出单一脱敏证据包并记录有效参数、范围与数据版本', async () => {
    mocks.cxGet
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce({
        success: true,
        data: {
          username: 'tester', displayName: '测试员', role: 'branch_admin',
          branchCode: 'SC', visibleBranches: ['SC', 'SX'], branchScope: multiScope,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { etlDate: '2026-07-21', contentVersion: 'data0001' },
      })
      .mockResolvedValueOnce({
        success: true, message: 'Server is running', releaseSha: 'abc1234',
        builtAt: '2026-07-22T00:00:00.000Z', timestamp: '2026-07-22T01:00:00.000Z',
        pool: { shouldNotLeak: true },
      });
    mocks.cxGetWithMeta.mockResolvedValueOnce({
      data: { success: true, data: [{ time_period: '2026-W01', premium: 1 }] },
      requestId: 'request-123',
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await analyzeCommand('operating-trend', {
      evidence: true,
      params: { startDate: '2026-01-01', endDate: '2026-01-31', targetBranch: 'SX' },
    });

    const evidence = JSON.parse(String(log.mock.calls[0][0]));
    expect(evidence).toMatchObject({
      schemaVersion: 2,
      source: 'remote',
      requestId: 'request-123',
      cliVersion: '1.3.0',
      capabilityCatalog: { version: 5, minCliVersion: '1.3.0' },
      capability: {
        id: 'operating-trend', timeWindow: 'window',
        resultSchema: { id: 'operating.trend.v1', version: 1 },
      },
      effectiveBranch: 'SX',
      branchScope: multiScope,
      identity: { username: 'tester', tokenId: 'pat-test', baseUrl: 'https://example.test' },
      health: { releaseSha: 'abc1234' },
      dataVersion: { etlDate: '2026-07-21', contentVersion: 'data0001' },
      fingerprints: {
        algorithm: 'sha256',
        parameters: expect.stringMatching(/^[a-f0-9]{64}$/),
        request: expect.stringMatching(/^[a-f0-9]{64}$/),
        result: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      data: [{ time_period: '2026-W01', premium: 1 }],
    });
    expect(evidence.health).not.toHaveProperty('pool');
  });
});
