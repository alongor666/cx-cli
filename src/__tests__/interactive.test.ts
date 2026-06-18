import { describe, it, expect, vi } from 'vitest';
import {
  pickRouteFromInput,
  buildParamSpec,
  previewUrl,
  interactiveQueryCommand,
  isInteractiveUnsupported,
  type IO,
} from '../commands/interactive.js';
import type { RouteMeta } from '../commands/routes.js';

const ROUTES: RouteMeta[] = [
  {
    key: 'KPI',
    path: '/kpi',
    fullPath: '/api/query/kpi',
    summary: '关键指标',
    description: '',
    tags: ['kpi'],
    parameters: [
      { name: 'year', type: 'integer', required: true, description: '保单年度' },
      { name: 'org_level_3', type: 'string', required: false, description: '三级机构' },
    ],
  },
  {
    key: 'PATROL',
    path: '/patrol/:domain',
    fullPath: '/api/query/patrol/:domain',
    summary: '盯盘',
    description: '',
    tags: ['patrol'],
    parameters: [
      { name: 'domain', type: 'string', required: true, description: '盯盘域', enum: ['renewal', 'incidents'] },
    ],
  },
];

describe('pickRouteFromInput', () => {
  it('序号 → 命中', () => {
    expect(pickRouteFromInput('1', ROUTES)?.key).toBe('KPI');
    expect(pickRouteFromInput('2', ROUTES)?.key).toBe('PATROL');
  });

  it('序号越界 → null', () => {
    expect(pickRouteFromInput('99', ROUTES)).toBeNull();
  });

  it('key 大小写宽容 + 中划线', () => {
    expect(pickRouteFromInput('kpi', ROUTES)?.key).toBe('KPI');
    expect(pickRouteFromInput('Patrol', ROUTES)?.key).toBe('PATROL');
  });

  it('catalog path 命中', () => {
    expect(pickRouteFromInput('/kpi', ROUTES)?.key).toBe('KPI');
  });

  it('空 / 未命中 → null', () => {
    expect(pickRouteFromInput('', ROUTES)).toBeNull();
    expect(pickRouteFromInput('  ', ROUTES)).toBeNull();
    expect(pickRouteFromInput('nope', ROUTES)).toBeNull();
  });
});

describe('buildParamSpec', () => {
  it('path :var 排前 + 标记 inPath', () => {
    const specs = buildParamSpec(ROUTES[1]);
    expect(specs[0]).toMatchObject({ name: 'domain', inPath: true, required: true });
    expect(specs[0].enum).toEqual(['renewal', 'incidents']);
  });

  it('path :var 不在 query parameters 重复出现', () => {
    const specs = buildParamSpec(ROUTES[1]);
    const domainCount = specs.filter((s) => s.name === 'domain').length;
    expect(domainCount).toBe(1);
  });

  it('query 参数继承 required 标记', () => {
    const specs = buildParamSpec(ROUTES[0]);
    expect(specs.find((s) => s.name === 'year')?.required).toBe(true);
    expect(specs.find((s) => s.name === 'org_level_3')?.required).toBe(false);
    expect(specs.every((s) => s.inPath === false)).toBe(true);
  });

  it('无 parameters 时返回空数组', () => {
    const bare: RouteMeta = { ...ROUTES[0], fullPath: '/api/query/none', parameters: [] };
    expect(buildParamSpec(bare)).toEqual([]);
  });
});

describe('isInteractiveUnsupported（TTY guard 只查 stdin）', () => {
  it('stdin 不是 TTY → 拒绝交互（管道喂数据场景）', () => {
    expect(isInteractiveUnsupported(false)).toBe(true);
    expect(isInteractiveUnsupported(undefined)).toBe(true);
  });

  it('stdin 是 TTY → 允许交互（无论 stdout 是否重定向）', () => {
    // 等价 `cx query -i -f json > result.json`：stdin TTY 可输入，stdout pipe 接数据
    expect(isInteractiveUnsupported(true)).toBe(false);
  });
});

describe('previewUrl', () => {
  it('替换 :var + 拼 query string', () => {
    const url = previewUrl(ROUTES[1], { domain: 'renewal', org: '高新' });
    expect(url).toBe('/api/query/patrol/renewal?org=' + encodeURIComponent('高新'));
  });

  it('缺 path 参数显示 incomplete 而非抛错', () => {
    const url = previewUrl(ROUTES[1], {});
    expect(url).toContain('incomplete');
    expect(url).toContain('domain');
  });

  it('参数为空时只输出 path', () => {
    expect(previewUrl(ROUTES[0], {})).toBe('/api/query/kpi');
  });

  it('忽略空字符串参数', () => {
    expect(previewUrl(ROUTES[0], { year: '2026', org_level_3: '' })).toBe('/api/query/kpi?year=2026');
  });
});

/** 测试用 IO：把脚本化的输入序列按顺序回答。state 是对象引用，close() 通过共享引用更新 closed */
function makeFakeIO(answers: string[]): IO & { state: { closed: boolean; questions: string[] } } {
  const state = { closed: false, questions: [] as string[] };
  let idx = 0;
  return {
    state,
    async question(prompt: string) {
      state.questions.push(prompt);
      const v = answers[idx++];
      if (v === undefined) throw new Error(`FakeIO 输入已用尽，第 ${idx} 次问 ${prompt}`);
      return v;
    },
    close() {
      state.closed = true;
    },
  };
}

describe('interactiveQueryCommand 集成', () => {
  it('wizard 走完后委托 invokeQuery，参数等价 cx query KPI --year=2026 --org_level_3=高新', async () => {
    const io = makeFakeIO([
      '',          // 搜索关键词 → 空，看全部
      '1',         // 选第 1 个 (KPI)
      '2026',      // year（必填）
      '高新',      // org_level_3（可选）
      'y',         // 运行确认
    ]);
    const invokeQuery = vi.fn().mockResolvedValue(undefined);

    await interactiveQueryCommand(
      { format: 'json', limit: 100, timeoutMs: 5000 },
      {
        io,
        fetchRoutes: async () => ROUTES,
        invokeQuery,
      },
    );

    expect(invokeQuery).toHaveBeenCalledTimes(1);
    expect(invokeQuery).toHaveBeenCalledWith('KPI', {
      params: { year: '2026', org_level_3: '高新' },
      format: 'json',
      limit: 100,
      timeoutMs: 5000,
    });
    expect(io.state.closed).toBe(true);
  });

  it('path :var 路由：domain 通过 wizard 收集且命中 invokeQuery', async () => {
    const io = makeFakeIO([
      'patrol',    // 搜索
      '1',         // 选 PATROL（搜索后唯一候选）
      'renewal',   // domain（必填 path）
      'y',         // 确认
    ]);
    const invokeQuery = vi.fn().mockResolvedValue(undefined);

    await interactiveQueryCommand(
      {},
      { io, fetchRoutes: async () => ROUTES, invokeQuery },
    );

    expect(invokeQuery).toHaveBeenCalledWith('PATROL', expect.objectContaining({
      params: { domain: 'renewal' },
    }));
  });

  it('用户回答 n → 不调用 invokeQuery', async () => {
    const io = makeFakeIO([
      '',
      '1',
      '2026',
      '',           // org_level_3 留空（可选）
      'n',          // 拒绝运行
    ]);
    const invokeQuery = vi.fn();

    await interactiveQueryCommand(
      {},
      { io, fetchRoutes: async () => ROUTES, invokeQuery },
    );

    expect(invokeQuery).not.toHaveBeenCalled();
    expect(io.state.closed).toBe(true);
  });

  it('必填参数空回车 → 再追问，直到给出非空值（retry 循环）', async () => {
    const io = makeFakeIO([
      '',          // 搜索
      '1',         // 选 KPI
      '',          // year（必填）— 空回车
      '',          // year 再次空回车（继续被拒）
      '2026',      // year 第三次终于给值
      '',          // org_level_3 可选 跳过
      'y',         // 确认
    ]);
    const invokeQuery = vi.fn().mockResolvedValue(undefined);

    await interactiveQueryCommand(
      {},
      { io, fetchRoutes: async () => ROUTES, invokeQuery },
    );

    expect(invokeQuery).toHaveBeenCalledTimes(1);
    expect(invokeQuery).toHaveBeenCalledWith('KPI', expect.objectContaining({
      params: { year: '2026' },
    }));
    // 至少出现 3 次 year 提问（前 2 次拒绝 + 第 3 次接受）
    const yearPrompts = io.state.questions.filter((q) => q.includes('year='));
    expect(yearPrompts.length).toBeGreaterThanOrEqual(3);
  });

  it('path :var 必填且空回车 → retry 直到给值', async () => {
    const io = makeFakeIO([
      'patrol', // 搜索
      '1',      // 选 PATROL
      '',       // domain 空回车（被拒）
      'renewal', // 给值
      'y',      // 确认
    ]);
    const invokeQuery = vi.fn().mockResolvedValue(undefined);

    await interactiveQueryCommand(
      {},
      { io, fetchRoutes: async () => ROUTES, invokeQuery },
    );

    expect(invokeQuery).toHaveBeenCalledWith('PATROL', expect.objectContaining({
      params: { domain: 'renewal' },
    }));
    const domainPrompts = io.state.questions.filter((q) => q.includes('domain='));
    expect(domainPrompts.length).toBeGreaterThanOrEqual(2);
  });

  it('可选参数空字符串不进入 params', async () => {
    const io = makeFakeIO(['', '1', '2026', '', 'y']);
    const invokeQuery = vi.fn().mockResolvedValue(undefined);

    await interactiveQueryCommand(
      {},
      { io, fetchRoutes: async () => ROUTES, invokeQuery },
    );

    expect(invokeQuery).toHaveBeenCalledWith('KPI', expect.objectContaining({
      params: { year: '2026' },
    }));
  });
});
