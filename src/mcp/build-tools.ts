/**
 * 把 /api/auth/route-catalog 返回的路由元数据转成 MCP tools
 *
 * 口径文案不在本文件复制：timeWindowLabel 由服务端 SSOT（query-routes-metadata.ts
 * TIME_WINDOW_LABELS）随 catalog 下发；本文件只负责拼装与护栏。catalog 字段的
 * 增减由 tests/api/route-catalog-mcp-contract.test.ts 对账（留在主仓：cli/ 同步到公开镜像，镜像里没有 server/）——服务端加字段而 MCP 未表态即红。
 */
import { mcpGet, type McpConfig } from './api.js';

export interface RouteParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date';
  required?: boolean;
  description: string;
  enum?: string[];
}

export interface RouteMeta {
  key: string;
  path: string;
  fullPath: string;
  /** 仅 GET 会被映射为工具；其余方法跳过并告警（MCP 通道只读） */
  method: string;
  summary: string;
  description: string;
  parameters: RouteParam[];
  /** 时间窗口语义枚举（B290 口径消歧；旧服务端可能缺省） */
  timeWindow?: string;
  /** 服务端 SSOT 派生的时间口径中文提示（旧服务端可能缺省） */
  timeWindowLabel?: string;
  /** 时间口径补充说明 */
  timeWindowNote?: string;
  /** 路由级数据范围提示（'all' | 'org' | 'telemarketing' | 'any'） */
  dataScope?: string;
  /** 界面已下线；效果已由服务端折进 description，此处仅声明已知 */
  uiRetired?: boolean;
  tags: string[];
}

/**
 * MCP 已表态（消费或明确忽略）的 catalog 字段全集。
 * 服务端新增字段 → 契约测试红 → 必须在这里登记并决定是否拼进工具描述。
 */
export const KNOWN_CATALOG_FIELDS: readonly string[] = [
  'key', 'path', 'fullPath', 'method', 'summary', 'description', 'parameters',
  'timeWindow', 'timeWindowLabel', 'timeWindowNote', 'dataScope', 'uiRetired', 'tags',
];

/** 行级权限提示：所有查询结果都按调用令牌的数据范围自动收窄 */
const DATA_SCOPE_HINT =
  '数据范围: 结果已按本令牌的行级权限自动收窄，合计/排名只代表该范围而非全省，范围用 cx_whoami 查看';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

function paramTypeToJsonSchema(t: RouteParam['type']): string {
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  // date 和 string 在 JSON Schema 里都是 string（date 用 description 标注）
  return 'string';
}

function stripTrailingPeriod(s: string): string {
  return s.replace(/[。.]+$/, '');
}

/** 工具描述单段上限：描述会在 tools/list 时进入每个 Agent 的上下文，服务端文案不设防就是注入面 */
export const MAX_DESCRIPTION_CHARS = 2000;

/**
 * 去掉不可见的指令夹带（保留 Tab / 换行）：控制符 Cc、格式符 Cf（零宽、双向控制含 isolate、软连字符、
 * Unicode Tag 等）、变体选择符、Hangul 填充符，以及 Tag 区未分配码点；按码点截断到上限（不切断代理对）。
 */
const INVISIBLE = /(?![\t\n])[\p{Cc}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{E0000}-\u{E007F}\u3164\u115F\u1160\uFFA0]/gu;

export function sanitizeText(s: string, max = MAX_DESCRIPTION_CHARS): string {
  const chars = Array.from(s.replace(INVISIBLE, ''));
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** MCP 工具名须匹配 ^[a-zA-Z0-9_-]{1,64}$：非法字符替换为 _，超长截断 */
export function toolNameForRoute(key: string): string {
  return `cx_query_${key.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`.slice(0, 64);
}

export function routeToTool(meta: RouteMeta): McpTool {
  const properties: Record<string, { type: string; description: string; enum?: string[] }> = {};
  const required: string[] = [];
  for (const p of meta.parameters) {
    const desc = sanitizeText(p.description ?? '', 500);
    properties[p.name] = {
      type: paramTypeToJsonSchema(p.type),
      description: p.type === 'date' ? `${desc} (date YYYY-MM-DD)` : desc,
      // enum 只配 string：type:number 配字符串 enum 是无解 schema；空 enum 同样无解
      ...(paramTypeToJsonSchema(p.type) === 'string' && Array.isArray(p.enum) && p.enum.length > 0
        ? { enum: p.enum.map((v) => sanitizeText(String(v), 200)) } : {}),
    };
    if (p.required) required.push(p.name);
  }
  // 提示与补充说明解耦：旧服务端缺 label 时 note 也照样透出（此前 note 挂在 hint 上会被整体丢弃）；
  // 缺 label 时退化为裸枚举值而不是在本地复制一份文案（复制即漂移源）
  const windowText = meta.timeWindowLabel ?? (meta.timeWindow ? `时间口径类型: ${meta.timeWindow}` : undefined);
  const caliber = [windowText, meta.timeWindowNote]
    .filter((s): s is string => Boolean(s))
    .map(stripTrailingPeriod);
  if (meta.dataScope) caliber.push(DATA_SCOPE_HINT);
  const caliberText = caliber.length > 0 ? ` 【${caliber.join('。')}。】` : '';
  return {
    name: toolNameForRoute(meta.key),
    // 只截正文：口径/数据范围提示拼在末尾，整段截断会最先把它们砍掉
    description: sanitizeText(`${stripTrailingPeriod(meta.summary)}. ${meta.description}`,
      Math.max(0, MAX_DESCRIPTION_CHARS - caliberText.length)) + sanitizeText(caliberText),
    inputSchema: {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  };
}

export interface CatalogBuildResult {
  tools: McpTool[];
  routes: RouteMeta[];
  warnings: string[];
}

function isRouteParam(p: unknown): p is RouteParam {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  // 参数名直接成为 inputSchema 的属性名进入 Agent 上下文：只收普通标识符（服务端现有参数名全部满足）
  return typeof o.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(o.name)
    && (o.description === undefined || typeof o.description === 'string')
    && (o.enum === undefined || Array.isArray(o.enum));
}

function isRouteMeta(r: unknown): r is RouteMeta {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return typeof o.key === 'string' && o.key.length > 0 && typeof o.fullPath === 'string'
    && typeof o.summary === 'string' && typeof o.description === 'string'
    && Array.isArray(o.parameters) && o.parameters.every(isRouteParam);
}

/** 纯函数：catalog 路由 → 工具。非 GET / 非 /api/query/ 路径 / 重名跳过，未知字段与缺口径告警，不静默 */
export function buildToolsFromRoutes(rawRoutes: unknown[]): CatalogBuildResult {
  const warnings: string[] = [];
  const routes: RouteMeta[] = [];
  const seenNames = new Set<string>();
  for (const raw of rawRoutes) {
    if (!isRouteMeta(raw)) {
      warnings.push(`跳过形状异常的路由条目: ${String(JSON.stringify(raw)).slice(0, 120)}`);
      continue;
    }
    if (raw.method !== 'GET') {
      warnings.push(`跳过非 GET 路由 ${raw.key}（method=${raw.method}）：MCP 通道只读`);
      continue;
    }
    // 服务端契约：route-catalog 只下发 /api/query/* 路由
    if (!raw.fullPath.startsWith('/api/query/')) {
      warnings.push(`跳过 fullPath 不在 /api/query/ 下的路由 ${raw.key}: ${raw.fullPath.slice(0, 120)}`);
      continue;
    }
    const name = toolNameForRoute(raw.key);
    if (seenNames.has(name)) {
      warnings.push(`跳过重名路由 ${raw.key}：工具名 ${name} 已被占用`);
      continue;
    }
    seenNames.add(name);
    const unknown = Object.keys(raw).filter((k) => !KNOWN_CATALOG_FIELDS.includes(k));
    if (unknown.length > 0) warnings.push(`路由 ${raw.key} 含 MCP 未识别字段: ${unknown.join(', ')}`);
    if (raw.timeWindow && !raw.timeWindowLabel) {
      warnings.push(`路由 ${raw.key} timeWindow=${raw.timeWindow} 缺 timeWindowLabel（服务端版本过旧？）`);
    }
    routes.push(raw);
  }
  return { tools: routes.map(routeToTool), routes, warnings };
}

/** raw：服务端原样下发的路由数组，供写本地缓存（与 CLI 共用，CLI 需要未经 MCP 过滤的全集） */
export async function fetchAllTools(cfg: McpConfig): Promise<CatalogBuildResult & { raw: unknown[] }> {
  const resp = await mcpGet<unknown>(cfg, '/api/auth/route-catalog');
  const routes = (resp as { data?: { routes?: unknown } } | null)?.data?.routes;
  if (!Array.isArray(routes)) {
    throw new Error('route-catalog 响应形状异常：缺 data.routes 数组（服务端版本不兼容？）');
  }
  return { ...buildToolsFromRoutes(routes), raw: routes };
}

/**
 * 转发型工具：cx_discover_<name> → /api/discover/<name>，cx_whoami → /api/auth/me
 *
 * project：可选的响应投影（白名单字段），用于只暴露调用方需要的最小信息。
 */
export interface DiscoveryToolBinding {
  tool: McpTool;
  endpoint: string;
  project?: (data: unknown) => unknown;
}

/** /api/auth/me 白名单投影：只给 LLM 判断数据范围所需字段，不外泄账号其余属性 */
export function projectWhoami(data: unknown): unknown {
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    username: d.username ?? null,
    displayName: d.displayName ?? null,
    role: d.role ?? null,
    organization: d.organization ?? null,
    branchCode: d.branchCode ?? null,
    visibleBranches: d.visibleBranches ?? [],
    branchScope: d.branchScope ?? null,
    tokenType: d.tokenType ?? null,
  };
}

export const WHOAMI_BINDING: DiscoveryToolBinding = {
  endpoint: '/api/auth/me',
  project: projectWhoami,
  tool: {
    name: 'cx_whoami',
    description:
      '查看本令牌的身份与数据范围（角色 / 机构 / 可见分省）。所有 cx_query_* 结果都按这个范围自动收窄：' +
      'organization 非空说明只能看到该机构的数据，此时「合计」「排名」都只代表该机构，不能当作全省口径回答。' +
      '回答任何合计、占比、排名类问题前先调用一次。',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY_ANNOTATIONS,
  },
};

/** fetchSummaries=false：服务端已不可达（catalog 走了缓存兜底）时跳过摘要拉取，不再白等一轮超时 */
export async function buildDiscoveryTools(cfg: McpConfig, fetchSummaries = true): Promise<DiscoveryToolBinding[]> {
  const [fieldsResp, metricsResp, presetsResp] = fetchSummaries ? await Promise.all([
    mcpGet<{ success: boolean; data: Array<{ id: string; groupable?: boolean }> }>(cfg, '/api/discover/fields').catch(() => null),
    mcpGet<{ success: boolean; data: Array<{ id: string; category: string }> }>(cfg, '/api/discover/metrics').catch(() => null),
    mcpGet<{ success: boolean; data: { vehicleQuickFilters: string[] } }>(cfg, '/api/discover/presets').catch(() => null),
  ]) : [null, null, null];

  // 启动时摘要拉取失败就不写数字：宁可不说，也不给 LLM 一个陈旧的计数
  const fields = Array.isArray(fieldsResp?.data) ? fieldsResp.data : null;
  const metrics = Array.isArray(metricsResp?.data) ? metricsResp.data : null;
  const groupableFieldIds = sanitizeText((fields ?? []).filter((f) => f.groupable).slice(0, 15).map((f) => String(f.id)).join(', '), 500);
  const metricCategories = metrics ? sanitizeText(Array.from(new Set(metrics.map((m) => String(m.category)))).join(', '), 500) : '';
  const vehicleFilters = sanitizeText((Array.isArray(presetsResp?.data?.vehicleQuickFilters) ? presetsResp.data.vehicleQuickFilters : []).map(String).join(', '), 500);

  const fieldsSummary = fields ? `（${fields.length} 个字段，含 column 可查列名 / queryable / 真实类型）` : '（含 column 可查列名 / queryable / 真实类型）';
  const metricsSummary = metrics ? `（${metrics.length} 个）。可按 category 过滤：${metricCategories}` : '。可按 category 过滤（分类清单见返回值）';

  return [
    {
      endpoint: '/api/discover/fields',
      tool: {
        name: 'cx_discover_fields',
        description: `列出字段注册表${fieldsSummary}。groupable=true 仅返回可分组（VARCHAR/TEXT）字段；verbose=true 附 ETL 入库别名。${groupableFieldIds ? `常用可分组字段：${groupableFieldIds}。` : ''}`,
        inputSchema: {
          type: 'object',
          properties: {
            groupable: { type: 'boolean', description: '是否仅列出可分组字段' },
            verbose: { type: 'boolean', description: '附带 ETL 入库元数据（ingestTypes/ingestAliases，不可 SELECT）' },
          },
        },
        annotations: READ_ONLY_ANNOTATIONS,
      },
    },
    {
      endpoint: '/api/discover/metrics',
      tool: {
        name: 'cx_discover_metrics',
        description: `列出指标注册表${metricsSummary}。指标 SQL 不暴露 — 必须通过 cx_query_pivot 或 cx_query_sql 取数。`,
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', description: metricCategories ? `指标分类（${metricCategories}）` : '指标分类' },
          },
        },
        annotations: READ_ONLY_ANNOTATIONS,
      },
    },
    {
      endpoint: '/api/discover/presets',
      tool: {
        name: 'cx_discover_presets',
        description: `列出筛选器 schema 和车型快捷预设${vehicleFilters ? `：${vehicleFilters}` : '（清单见返回值）'}。`,
        inputSchema: { type: 'object', properties: {} },
        annotations: READ_ONLY_ANNOTATIONS,
      },
    },
    WHOAMI_BINDING,
  ];
}
