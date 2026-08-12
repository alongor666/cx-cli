/**
 * `cx routes` 的「界面已下线」透出（复审 P2-8）
 *
 * 修的什么：后端路由元数据早有 uiRetired 标注、/route-catalog 也已回传，但 `cx routes` 的
 * 表格只渲染 key/path/summary/timeWindow，json/csv 也不含 description，命令行用户看到的
 * 仍是 `PREMIUM_REPORT /premium-report 保费报表 window`——与下线前逐字相同。
 *
 * 这里锁三种输出各一条：table 打标 + 表尾图例给服务端原文；json / csv 带 description 与
 * uiRetired 布尔位。去掉任一处渲染，对应用例立刻变红（变异实测见 PR 说明）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cxGet: vi.fn(),
  getCachePath: vi.fn(() => '/tmp/does-not-exist/catalog.json'),
  failWith: vi.fn(),
  note: vi.fn(),
  existsSync: vi.fn(() => false),
  writeFileSync: vi.fn(),
}));

vi.mock('../api.js', () => ({ cxGet: mocks.cxGet }));
vi.mock('../config.js', () => ({ getCachePath: mocks.getCachePath }));
vi.mock('../exit-codes.js', () => ({ failWith: mocks.failWith }));
vi.mock('../cli-state.js', () => ({ note: mocks.note }));
vi.mock('fs', () => ({
  default: {
    existsSync: mocks.existsSync,
    writeFileSync: mocks.writeFileSync,
    statSync: vi.fn(() => ({ mtimeMs: 0 })),
    readFileSync: vi.fn(() => '{}'),
  },
}));

import {
  UI_RETIRED_MARK,
  buildRouteTableRow,
  buildUiRetiredLegend,
  isUiRetired,
  projectRoutesForExport,
  routesCommand,
  uiRetiredNote,
  type RouteMeta,
} from '../commands/routes.js';

/**
 * 服务端 UI_RETIRED_CATALOG_NOTE 追加进 description 后的形态（夹具，非 CLI 的文案事实源）。
 * CLI 不复写这段中文：它只按锚点符号 `⚠` 把服务端原文透出。
 */
const RETIRED_NOTE =
  '⚠ 界面已下线：本路由已无对应页面（前端零调用），仅保留程序化访问与权限校验；不要把它当作界面入口推荐。';

const route = (over: Partial<RouteMeta> = {}): RouteMeta => ({
  key: 'KPI',
  path: '/kpi',
  fullPath: '/api/query/kpi',
  summary: '核心指标',
  description: '返回核心指标。',
  tags: ['core'],
  parameters: [],
  timeWindow: 'window',
  ...over,
});

const retiredRoute = route({
  key: 'PREMIUM_REPORT',
  path: '/premium-report',
  fullPath: '/api/query/premium-report',
  summary: '保费报表',
  description: `保费报表明细。${RETIRED_NOTE}`,
  tags: ['premium'],
  uiRetired: true,
});

describe('cx routes · 下线标注的识别与取原文', () => {
  it('uiRetired 为真才算下线；旧缓存缺省字段视为未下线', () => {
    expect(isUiRetired(retiredRoute)).toBe(true);
    expect(isUiRetired(route())).toBe(false);
    expect(isUiRetired({ ...retiredRoute, uiRetired: undefined })).toBe(false);
  });

  it('取出的标注是服务端原文（CLI 不自己拼中文）', () => {
    expect(uiRetiredNote(retiredRoute)).toBe(RETIRED_NOTE);
    expect(uiRetiredNote(route())).toBeNull();
  });

  it('锚点抽不到（服务端文案换形态）时退回整段 description，不哑掉', () => {
    const weird = { ...retiredRoute, description: '保费报表明细。界面已下线（无锚点符号）' };
    expect(uiRetiredNote(weird)).toBe(weird.description);
  });
});

describe('cx routes · table 输出', () => {
  it('下线路由的 key 被打上标记，普通路由不动', () => {
    expect(buildRouteTableRow(retiredRoute)[0]).toBe(`${UI_RETIRED_MARK} PREMIUM_REPORT`);
    expect(buildRouteTableRow(route())[0]).toBe('KPI');
  });

  it('表尾图例逐条给出服务端标注原文；无下线路由时为空', () => {
    const legend = buildUiRetiredLegend([route(), retiredRoute]);
    expect(legend).toHaveLength(1);
    expect(legend[0]).toContain('PREMIUM_REPORT');
    expect(legend[0]).toContain(RETIRED_NOTE);
    expect(buildUiRetiredLegend([route()])).toEqual([]);
  });
});

describe('cx routes · json / csv 输出', () => {
  it('投影带 description（含标注原文）与 uiRetired 布尔位，且保留既有字段', () => {
    const [normal, retired] = projectRoutesForExport([route(), retiredRoute]);

    expect(retired.uiRetired).toBe(true);
    expect(String(retired.description)).toContain(RETIRED_NOTE);
    expect(normal.uiRetired).toBe(false);
    // 既有契约字段不能因为加字段而丢（agent 一次发现拿到完整 schema）
    expect(Object.keys(normal)).toEqual([
      'key', 'path', 'summary', 'description', 'uiRetired', 'timeWindow', 'tags', 'parameters',
    ]);
  });
});

describe('cx routes · 端到端（命令真的把标注打印出来）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.cxGet.mockReset();
  });

  const mockCatalog = () => {
    mocks.cxGet.mockResolvedValue({
      success: true,
      data: { version: 1, routes: [route(), retiredRoute] },
    });
  };

  it('table 模式：下线路由带标记，且图例原文出现在输出里', async () => {
    mockCatalog();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await routesCommand({ format: 'table', refresh: true });

    const output = log.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(output).toContain(`${UI_RETIRED_MARK} PREMIUM_REPORT`);
    expect(output).toContain(RETIRED_NOTE);
    expect(mocks.failWith).not.toHaveBeenCalled();
  });

  it('json 模式：标注原文与 uiRetired 都在输出里', async () => {
    mockCatalog();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await routesCommand({ format: 'json', refresh: true });

    const output = log.mock.calls.map((args) => args.join(' ')).join('\n');
    const parsed = JSON.parse(output) as Array<Record<string, unknown>>;
    const retired = parsed.find((r) => r.key === 'PREMIUM_REPORT');
    expect(retired?.uiRetired).toBe(true);
    expect(String(retired?.description)).toContain(RETIRED_NOTE);
  });

  it('csv 模式：标注原文进了 description 列', async () => {
    mockCatalog();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await routesCommand({ format: 'csv', refresh: true });

    const output = log.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(output.split('\n')[0]).toContain('description');
    expect(output).toContain('界面已下线');
    expect(output).toContain('uiRetired');
  });
});
