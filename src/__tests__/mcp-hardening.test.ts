import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildToolsFromRoutes, sanitizeText, toolNameForRoute, type RouteMeta } from '../mcp/build-tools.js';
import { createCallToolHandler } from '../mcp/call-tool.js';
import { mcpGet } from '../mcp/api.js';
import { jsonAdapter, sameEntry } from '../mcp/clients.js';

const base = {
  key: 'KPI', path: '/kpi', fullPath: '/api/query/kpi', method: 'GET',
  summary: 'KPI', description: 'd', parameters: [], tags: [],
};

describe('buildToolsFromRoutes 护栏', () => {
  it('单个参数项形状异常只跳过该路由并告警，不拖垮整个 server', () => {
    const r = buildToolsFromRoutes([{ ...base, key: 'BAD', parameters: [null] }, base]);
    expect(r.tools.map((t) => t.name)).toEqual(['cx_query_kpi']);
    expect(r.warnings.join('\n')).toMatch(/形状异常/);
  });

  it('fullPath 不在 /api/ 下的路由被跳过（防止令牌发往别处）', () => {
    const r = buildToolsFromRoutes([{ ...base, fullPath: 'https://evil.test/api/x' }]);
    expect(r.tools).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/不在 \/api\/ 下/);
  });

  it('工具名非法字符替换、截断到 64，重名只保留第一个并告警', () => {
    expect(toolNameForRoute('CLAIMS.DETAIL/X')).toBe('cx_query_claims_detail_x');
    expect(toolNameForRoute('A'.repeat(100))).toHaveLength(64);
    const r = buildToolsFromRoutes([base, { ...base, key: 'kpi' }]);
    expect(r.tools).toHaveLength(1);
    expect(r.warnings.join('\n')).toMatch(/重名/);
  });

  it('描述去掉零宽/控制字符并限长', () => {
    expect(sanitizeText('a​b\u0007c‮d')).toBe('abcd');
    expect(sanitizeText('x'.repeat(10), 4)).toBe('xxxx…');
  });
});

describe('createCallToolHandler 参数校验', () => {
  const route: RouteMeta = {
    ...base, key: 'EX', fullPath: '/api/query/ex/:domain',
    parameters: [{ name: 'domain', type: 'string', description: '' }, { name: 'start', type: 'date', description: '' }],
  };
  const setup = (get = vi.fn().mockResolvedValue({ success: true, data: [] })) => ({
    get,
    handle: createCallToolHandler({ cfg: { baseUrl: 'http://m', token: 't' }, routes: [route], bindings: [], maxBytes: 100_000, get }),
  });

  it('对象/数组参数直接报错，不以 "[object Object]" 静默发出', async () => {
    const { handle, get } = setup();
    const r = await handle('cx_query_ex', { domain: 'x', start: { y: 1 } });
    expect(r.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('未声明参数照常透传，但单独追加一块提示（数据块保持纯 JSON）', async () => {
    const { handle } = setup();
    const r = await handle('cx_query_ex', { domain: 'x', startDate: '2026-01-01' });
    const blocks = r.content as Array<{ text: string }>;
    expect(JSON.parse(blocks[0].text)).toEqual([]);
    expect(blocks[1].text).toMatch(/startDate.*不在本工具声明的参数中/);
  });

  it('声明过的参数与 path 参数不触发提示', async () => {
    const { handle } = setup();
    const r = await handle('cx_query_ex', { domain: 'x', start: '2026-01-01' });
    expect(r.content).toHaveLength(1);
  });
});

describe('mcpGet', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('path 参数 .. 逃逸在发请求前被拒绝', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(mcpGet({ baseUrl: 'https://h.test', token: 't' }, '/api/query/ex/../../auth/tokens'))
      .rejects.toThrow(/\.\./);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('503 重试后成功', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":1}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(mcpGet({ baseUrl: 'https://h.test', token: 't' }, '/api/x')).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('jsonAdapter 不覆盖用户配置', () => {
  it('servers 节点存在但不是对象时拒绝写入，原文件不动', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-clients-'));
    const file = path.join(dir, 'config.json');
    const original = JSON.stringify({ mcp: { servers: [{ name: 'other' }] } });
    fs.writeFileSync(file, original);
    const adapter = jsonAdapter({ id: 'z', label: 'Z', file, detectDir: dir, keyPath: ['mcp', 'servers'] });
    expect(() => adapter.install({ command: '/cx', args: ['mcp'] })).toThrow(/不是对象/);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sameEntry 容忍 mcp get 输出把含空格路径拆散', () => {
    expect(sameEntry(
      { command: '/bin/node', args: ['/Users/John', 'Doe/cx/dist/index.js', 'mcp'] },
      { command: '/bin/node', args: ['/Users/John Doe/cx/dist/index.js', 'mcp'] },
    )).toBe(true);
  });
});
