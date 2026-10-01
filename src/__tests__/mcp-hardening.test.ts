import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildToolsFromRoutes, routeToTool, sanitizeText, toolNameForRoute, type RouteMeta } from '../mcp/build-tools.js';
import { readCatalogCache, writeCatalogCache, canFallBackToCache, MAX_STALE_CACHE_MS } from '../commands/routes.js';
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

  it('fullPath 不在 /api/query/ 下的路由被跳过（防止令牌发往别处）', () => {
    const r = buildToolsFromRoutes([{ ...base, fullPath: 'https://evil.test/api/x' }, { ...base, key: 'AUTH', fullPath: '/api/auth/tokens' }]);
    expect(r.tools).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/不在 \/api\/query\/ 下/);
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

  it('Unicode Tag 字符、bidi isolate、C1 控制符、软连字符、U+061C 一并去掉', () => {
    const tagged = 'ok' + Array.from('ignore', (c) => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');
    expect(sanitizeText(tagged)).toBe('ok');
    expect(sanitizeText('a\u2066b\u2069c\u0085d\u00ADe\u061Cf')).toBe('abcdef');
  });

  it('变体选择符、Hangul 填充符、U+FFF9 一并去掉；Tab/换行保留', () => {
    expect(sanitizeText('a\uFE0Fb\u{E0101}c\u3164d\uFFF9e\tf\ng')).toBe('abcde\tf\ng');
  });

  it('参数名不是普通标识符的路由整条跳过；enum 值清洗并限长', () => {
    const r = buildToolsFromRoutes([{ ...base, parameters: [{ name: 'a\u200Bb', type: 'string', description: '' }] }]);
    expect(r.tools).toEqual([]);
    const tool = routeToTool({ ...base, parameters: [
      { name: 's', type: 'string', description: '', enum: ['ok\u{E0041}', 'x'.repeat(300)] },
    ] } as RouteMeta);
    expect(tool.inputSchema.properties.s.enum?.[0]).toBe('ok');
    expect(Array.from(tool.inputSchema.properties.s.enum?.[1] ?? '')).toHaveLength(201);
  });

  it('截断按码点，不切断代理对', () => {
    expect(sanitizeText('😀😀😀', 2)).toBe('😀😀…');
  });

  it('长描述截断时口径提示仍保留在末尾', () => {
    const tool = routeToTool({ ...base, description: 'x'.repeat(5000), timeWindowLabel: '按签单日' } as RouteMeta);
    expect(tool.description).toMatch(/【按签单日。】$/);
  });

  it('enum 只配 string 类型；空 enum 丢弃', () => {
    const tool = routeToTool({ ...base, parameters: [
      { name: 'n', type: 'number', description: '', enum: ['1', '2'] },
      { name: 'e', type: 'string', description: '', enum: [] },
      { name: 's', type: 'string', description: '', enum: ['a'] },
    ] } as RouteMeta);
    expect(tool.inputSchema.properties.n.enum).toBeUndefined();
    expect(tool.inputSchema.properties.e.enum).toBeUndefined();
    expect(tool.inputSchema.properties.s.enum).toEqual(['a']);
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

  it('单元素数组取唯一值、空数组按未传；多元素数组拒绝（单值参数拼逗号会静默查错）', async () => {
    const { handle, get } = setup();
    await handle('cx_query_ex', { domain: 'x', start: ['2026-01-01'], extra: [] });
    expect(get).toHaveBeenCalledWith(expect.anything(), '/api/query/ex/x', { start: '2026-01-01' });

    get.mockClear();
    const multi = await handle('cx_query_ex', { domain: 'x', start: ['a', 'b'] });
    expect(multi.isError).toBe(true);
    expect((multi.content as Array<{ text: string }>)[0].text).toMatch(/多选参数.*英文逗号/);
    expect(get).not.toHaveBeenCalled();

    expect((await handle('cx_query_ex', { domain: 'x', start: [{ a: 1 }] })).isError).toBe(true);
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

  it('504 不重试（网关已等满超时，重试只会让服务端重算），错误带 status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 504 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(mcpGet({ baseUrl: 'https://h.test', token: 't' }, '/api/x')).rejects.toMatchObject({ status: 504 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

describe('route-catalog 本地缓存兜底', () => {
  let home: string;
  const routes = [{ key: 'KPI' }];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-cache-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('按 baseUrl 隔离：另一台服务端的目录不可用', () => {
    writeCatalogCache('https://a.test', routes);
    expect(readCatalogCache('https://a.test')?.routes).toEqual(routes);
    expect(readCatalogCache('https://b.test')).toBeNull();
  });

  it('mtime 在未来（年龄为负）的缓存不可用', () => {
    writeCatalogCache('https://a.test', routes);
    const file = path.join(home, '.chexian', 'cache', 'catalog.json');
    const future = new Date(Date.now() + 86_400_000);
    fs.utimesSync(file, future, future);
    expect(readCatalogCache('https://a.test')).toBeNull();
  });

  it('canFallBackToCache：401/403 不兜底；超过 7 天不兜底；网络/5xx 且新鲜才兜底', () => {
    const fresh = { routes: [], ageMs: 3600_000 };
    const stale = { routes: [], ageMs: MAX_STALE_CACHE_MS + 1 };
    expect(canFallBackToCache({ status: 401 }, fresh)).toBe(false);
    expect(canFallBackToCache({ status: 403 }, fresh)).toBe(false);
    expect(canFallBackToCache({ status: 502 }, stale)).toBe(false);
    expect(canFallBackToCache(new Error('network'), null)).toBe(false);
    expect(canFallBackToCache({ status: 502 }, fresh)).toBe(true);
    expect(canFallBackToCache(new Error('network'), fresh)).toBe(true);
  });
});
