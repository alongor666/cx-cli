import { describe, it, expect, vi } from 'vitest';
import { createCallToolHandler } from '../mcp/call-tool.js';
import { WHOAMI_BINDING, type RouteMeta, type DiscoveryToolBinding } from '../mcp/build-tools.js';

const cfg = { baseUrl: 'http://mock', token: 'cx_pat_secret.value' };

const kpiRoute: RouteMeta = {
  key: 'KPI', path: '/kpi', fullPath: '/api/query/kpi', method: 'GET',
  summary: 'KPI', description: 'd', parameters: [], tags: [],
};
const pathRoute: RouteMeta = { ...kpiRoute, key: 'EXAMPLE', fullPath: '/api/query/example/:domain' };
const discovery: DiscoveryToolBinding = {
  endpoint: '/api/discover/fields',
  tool: { name: 'cx_discover_fields', description: '', inputSchema: { type: 'object', properties: {} } },
};

function setup(get = vi.fn()) {
  const handle = createCallToolHandler({
    cfg, routes: [kpiRoute, pathRoute], bindings: [discovery, WHOAMI_BINDING], maxBytes: 100_000, get,
  });
  return { handle, get };
}

describe('createCallToolHandler', () => {
  it('查询工具：透传参数并保留 meta', async () => {
    const { handle, get } = setup(vi.fn().mockResolvedValue({ success: true, data: { p: 1 }, meta: { window_start: '2026-01-01' } }));
    const r = await handle('cx_query_kpi', { startDate: '2026-01-01' });
    expect(get).toHaveBeenCalledWith(cfg, '/api/query/kpi', { startDate: '2026-01-01' });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ data: { p: 1 }, meta: { window_start: '2026-01-01' } });
  });

  it('path 参数替换后不再出现在 query', async () => {
    const { handle, get } = setup(vi.fn().mockResolvedValue({ success: true, data: [] }));
    await handle('cx_query_example', { domain: 'renewal', limit: 5 });
    expect(get).toHaveBeenCalledWith(cfg, '/api/query/example/renewal', { limit: 5 });
  });

  it('cx_whoami 只回白名单字段', async () => {
    const me = {
      success: true,
      data: { username: 'u', role: 'org_user', organization: '天府', branchCode: 'SC', email: 'x@y', authMethods: ['password'], hasPassword: true },
    };
    const { handle, get } = setup(vi.fn().mockResolvedValue(me));
    const r = await handle('cx_whoami', {});
    expect(get).toHaveBeenCalledWith(cfg, '/api/auth/me', {});
    const out = JSON.parse((r.content[0] as { text: string }).text);
    expect(out.organization).toBe('天府');
    expect(out).not.toHaveProperty('email');
    expect(out).not.toHaveProperty('authMethods');
    expect(out).not.toHaveProperty('hasPassword');
  });

  it('发现工具：转发到绑定端点', async () => {
    const { handle, get } = setup(vi.fn().mockResolvedValue({ success: true, data: [{ id: 'f' }] }));
    await handle('cx_discover_fields', { groupable: true });
    expect(get).toHaveBeenCalledWith(cfg, '/api/discover/fields', { groupable: true });
  });

  it('未知工具 → isError 可自修复文案', async () => {
    const { handle } = setup();
    expect(await handle('nope', {})).toEqual({ isError: true, content: [{ type: 'text', text: 'Unknown tool: nope' }] });
  });

  it('上游失败 / 缺 path 参数 → isError，不抛出到传输层', async () => {
    const { handle } = setup(vi.fn().mockRejectedValue(new Error('API 400: 缺少 sql 参数')));
    const r1 = await handle('cx_query_kpi', {});
    expect(r1).toMatchObject({ isError: true, content: [{ text: 'API 400: 缺少 sql 参数' }] });
    const r2 = await handle('cx_query_example', {});
    expect(r2.isError).toBe(true);
    expect((r2.content[0] as { text: string }).text).toContain('缺少必需的 path 参数: domain');
  });
});
