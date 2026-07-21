import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cxGet: vi.fn(),
  loadConfig: vi.fn(() => ({
    baseUrl: 'https://example.test',
    token: 'test-token',
    tokenId: 'pat-1',
  })),
  failWith: vi.fn(),
}));

vi.mock('../api.js', () => ({ cxGet: mocks.cxGet }));
vi.mock('../config.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('../exit-codes.js', () => ({ failWith: mocks.failWith }));

import { whoamiCommand } from '../commands/whoami.js';

describe('whoamiCommand — 分公司范围回显', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.cxGet.mockReset();
    mocks.failWith.mockReset();
  });

  it('回显多省账号的默认省与 visibleBranches', async () => {
    mocks.cxGet.mockResolvedValue({
      success: true,
      data: {
        username: 'multi-admin',
        displayName: 'Multi Admin',
        role: 'branch_admin',
        branchCode: 'SC',
        visibleBranches: ['SC', 'SX'],
        tokenType: 'pat',
      },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await whoamiCommand();

    const output = log.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(output).toContain('DefaultBranch: SC');
    expect(output).toContain('VisibleBranches: SC, SX');
    expect(mocks.cxGet).toHaveBeenCalledWith('/api/auth/me');
  });
});
