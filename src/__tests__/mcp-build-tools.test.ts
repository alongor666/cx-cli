import { describe, it, expect } from 'vitest';
import { routeToTool, buildToolsFromRoutes, projectWhoami, type RouteMeta } from '../mcp/build-tools.js';

const sampleRoute: RouteMeta = {
  key: 'KPI',
  path: '/kpi',
  fullPath: '/api/query/kpi',
  method: 'GET',
  summary: 'KPI 大盘指标',
  description: '返回保费/件数/赔款核心 KPI',
  parameters: [
    { name: 'year', type: 'number', description: '保单年度' },
    { name: 'start_date', type: 'date', description: '开始日期' },
    { name: 'granularity', type: 'string', description: '粒度', enum: ['week', 'month'] },
    { name: 'org', type: 'string', description: '机构', required: true },
  ],
  tags: ['kpi'],
};

describe('routeToTool', () => {
  it('生成 cx_query_<key> 名字（小写）', () => {
    expect(routeToTool(sampleRoute).name).toBe('cx_query_kpi');
  });

  it('描述拼接 summary + description', () => {
    const tool = routeToTool(sampleRoute);
    expect(tool.description).toContain('KPI 大盘指标');
    expect(tool.description).toContain('返回保费');
  });

  it('参数类型转 JSON Schema：number → number, date → string', () => {
    const props = routeToTool(sampleRoute).inputSchema.properties;
    expect(props.year.type).toBe('number');
    expect(props.start_date.type).toBe('string');
    expect(props.start_date.description).toMatch(/YYYY-MM-DD/);
  });

  it('enum 透传', () => {
    expect(routeToTool(sampleRoute).inputSchema.properties.granularity.enum)
      .toEqual(['week', 'month']);
  });

  it('required 仅当至少一个参数标注 required', () => {
    const tool = routeToTool(sampleRoute);
    expect(tool.inputSchema.required).toEqual(['org']);
  });

  it('无 required 参数时 required 字段为 undefined（不出现空数组）', () => {
    const noReq: RouteMeta = { ...sampleRoute, parameters: [{ name: 'a', type: 'string', description: 'x' }] };
    expect(routeToTool(noReq).inputSchema.required).toBeUndefined();
  });

  it('服务端下发的 timeWindowLabel + note 注入 description（B290 口径消歧）', () => {
    const ytd: RouteMeta = {
      ...sampleRoute, key: 'PLAN_ACHIEVEMENT',
      timeWindow: 'ytd-progress',
      timeWindowLabel: '时间口径: 年度计划进度，禁止用于回答任意日期窗口的提问',
      timeWindowNote: '达成率 = 实际 ÷ (年计划 × 时间进度)。',
    };
    const desc = routeToTool(ytd).description;
    expect(desc).toContain('禁止用于回答任意日期窗口的提问');
    expect(desc).toContain('达成率 = 实际 ÷ (年计划 × 时间进度)');
    expect(desc).not.toMatch(/。。/);
  });

  it('缺 timeWindowLabel 时 note 仍透出（不再随提示整体丢弃）', () => {
    const desc = routeToTool({ ...sampleRoute, timeWindow: 'future-mode', timeWindowNote: '到期窗口非签单窗口' }).description;
    expect(desc).toContain('到期窗口非签单窗口');
  });

  it('有 timeWindow 缺 label（服务端未部署新版）退化为裸枚举值', () => {
    expect(routeToTool({ ...sampleRoute, timeWindow: 'window' }).description).toContain('时间口径类型: window');
  });

  it('旧服务端（无口径字段）不注入口径块且不报错', () => {
    expect(routeToTool(sampleRoute).description).not.toContain('【');
  });

  it('dataScope 存在时注入行级权限提示', () => {
    expect(routeToTool({ ...sampleRoute, dataScope: 'any' }).description).toContain('cx_whoami');
  });

  it('工具带只读注解', () => {
    expect(routeToTool(sampleRoute).annotations?.readOnlyHint).toBe(true);
  });
});

describe('buildToolsFromRoutes', () => {
  it('非 GET 路由跳过并告警', () => {
    const { tools, warnings } = buildToolsFromRoutes([{ ...sampleRoute, method: 'POST' }]);
    expect(tools).toHaveLength(0);
    expect(warnings[0]).toContain('非 GET');
  });

  it('形状异常条目跳过并告警，不抛错', () => {
    const { tools, warnings } = buildToolsFromRoutes([{ key: 'X' }, sampleRoute]);
    expect(tools).toHaveLength(1);
    expect(warnings[0]).toContain('形状异常');
  });

  it('未识别字段 / 有 timeWindow 缺 label 均告警', () => {
    const { warnings } = buildToolsFromRoutes([{ ...sampleRoute, timeWindow: 'window', brandNew: 1 }]);
    expect(warnings.some((w) => w.includes('brandNew'))).toBe(true);
    expect(warnings.some((w) => w.includes('缺 timeWindowLabel'))).toBe(true);
  });
});

describe('projectWhoami', () => {
  it('只保留数据范围相关字段', () => {
    expect(Object.keys(projectWhoami({ username: 'u', email: 'e', passwordHash: 'h' })).sort()).toEqual(
      ['branchCode', 'branchScope', 'displayName', 'organization', 'role', 'tokenType', 'username', 'visibleBranches'],
    );
  });
});
