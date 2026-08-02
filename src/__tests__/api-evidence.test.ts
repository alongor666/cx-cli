import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  loadConfig: () => ({ baseUrl: 'https://example.test', token: 'test-token' }),
}));
vi.mock('../http.js', () => ({
  attachTlsPersistence: vi.fn(),
}));

import { cxGetWithMeta } from '../api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cxGetWithMeta analysis evidence transport', () => {
  it('单次请求发送 evidence 协议头并保留服务端原子快照头', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: true, data: [{ premium: 1 }] }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'request-1',
          'X-Cx-Analysis-Evidence': 'encoded-snapshot',
        },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const response = await cxGetWithMeta('/api/query/trend', {
      query: { startDate: '2026-01-01' },
      analysisEvidence: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0].toString()).toBe(
      'https://example.test/api/query/trend?startDate=2026-01-01',
    );
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer test-token',
      'X-Cx-Analysis-Evidence': '2',
    });
    expect(response).toMatchObject({
      requestId: 'request-1',
      analysisEvidence: 'encoded-snapshot',
    });
  });
});
