/**
 * cx analyze <capability>
 *
 * 消费服务端分析能力目录并转发到其已保护的 GET 查询路由。此处不维护 SQL，
 * 也不接受行级导出能力；能力、时间口径和必填参数均由服务端目录决定。
 */
import kleur from 'kleur';
import { createHash } from 'node:crypto';
import { cxGet, cxGetWithMeta } from '../api.js';
import { EXIT, failWith } from '../exit-codes.js';
import { renderOutput, type OutputFormat } from '../output.js';
import { loadConfig } from '../config.js';
import { toWhoamiMachineView } from './whoami.js';
import pkg from '../../package.json' with { type: 'json' };

export interface AnalysisParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date';
  required?: boolean;
  description: string;
  enum?: string[];
}

export interface AnalysisCapability {
  id: string;
  name: string;
  description: string;
  path: string;
  fullPath: string;
  requiredParams: string[];
  allowedParams: string[];
  requiresExplicitBranchForMultiBranch: boolean;
  domain: string;
  fixedParams?: Record<string, string>;
  parameters: AnalysisParameter[];
  timeWindow: string;
  timeWindowNote?: string;
  resultSchema: AnalysisResultSchema;
}

export interface AnalysisResultSchema {
  id: string;
  version: number;
  kind: 'record' | 'records';
  recordsPath: '$' | '$.rows';
  requiredFields: string[];
  dimensionFields: string[];
  metricFields: string[];
}

export function validateAnalysisParams(
  capability: AnalysisCapability,
  params: Record<string, string>,
): string | null {
  if (!Array.isArray(capability.allowedParams) || capability.allowedParams.length === 0) {
    return `能力目录缺少 ${capability.id} 的 allowedParams 契约，请升级服务端`;
  }
  const allowed = new Set(capability.allowedParams);
  const unsupported = Object.keys(params).filter((param) => !allowed.has(param));
  if (unsupported.length === 0) return null;
  return `${capability.name} 不支持参数: ${unsupported.join(', ')}；允许参数: ${capability.allowedParams.join(', ')}`;
}

export interface CapabilitiesResponse {
  success: boolean;
  data: { version: number; minCliVersion: string; capabilities: AnalysisCapability[] };
}

export interface BranchScope {
  defaultBranch?: string;
  visibleBranches: string[];
  canSwitch: boolean;
  canAggregateAll: boolean;
}

interface ScopeResponse {
  success: boolean;
  data: {
    username: string;
    displayName: string;
    role: string;
    organization?: string;
    dataScope?: string;
    branchCode?: string;
    visibleBranches?: string[];
    tokenType?: string;
    allowedRoutes?: string[];
    branchScope?: BranchScope;
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string');
}

function isAnalysisParameter(value: unknown): value is AnalysisParameter {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AnalysisParameter>;
  return typeof item.name === 'string'
    && ['string', 'number', 'boolean', 'date'].includes(String(item.type))
    && typeof item.description === 'string'
    && (item.required === undefined || typeof item.required === 'boolean')
    && (item.enum === undefined || isStringArray(item.enum));
}

function isAnalysisResultSchema(value: unknown): value is AnalysisResultSchema {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AnalysisResultSchema>;
  return typeof item.id === 'string'
    && Number.isInteger(item.version) && Number(item.version) > 0
    && (item.kind === 'record' || item.kind === 'records')
    && (item.recordsPath === '$' || item.recordsPath === '$.rows')
    && isStringArray(item.requiredFields)
    && isStringArray(item.dimensionFields)
    && isStringArray(item.metricFields);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateAnalysisResult(schema: AnalysisResultSchema, data: unknown): string | null {
  let records: unknown[];
  if (schema.kind === 'record') {
    if (schema.recordsPath !== '$' || !isRecord(data)) {
      return `${schema.id}: 预期 response.data 为单一对象`;
    }
    records = [data];
  } else if (schema.recordsPath === '$') {
    if (!Array.isArray(data)) return `${schema.id}: 预期 response.data 为数组`;
    records = data;
  } else {
    if (!isRecord(data) || !Array.isArray(data.rows)) {
      return `${schema.id}: 预期 response.data.rows 为数组`;
    }
    records = data.rows;
  }

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!isRecord(record)) return `${schema.id}: 第 ${index + 1} 条记录不是对象`;
    const missing = schema.requiredFields.filter((field) => !(field in record));
    if (missing.length > 0) {
      return `${schema.id}: 第 ${index + 1} 条记录缺少字段 ${missing.join(', ')}`;
    }
  }
  return null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalize(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().flatMap((key) => value[key] === undefined
        ? []
        : [[key, canonicalize(value[key])]]),
    );
  }
  return value;
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function versionTuple(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const left = versionTuple(actual);
  const right = versionTuple(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

export function decodeCapabilitiesResponse(value: unknown): CapabilitiesResponse {
  const response = value as Partial<CapabilitiesResponse> | null;
  const data = response?.data as CapabilitiesResponse['data'] | undefined;
  if (response?.success !== true || !data || !Number.isInteger(data.version)
    || typeof data.minCliVersion !== 'string' || !Array.isArray(data.capabilities)) {
    throw new Error('能力目录契约异常：缺少 success/data/version/minCliVersion/capabilities');
  }
  for (const item of data.capabilities) {
    if (!item || typeof item !== 'object'
      || typeof item.id !== 'string' || typeof item.name !== 'string'
      || typeof item.description !== 'string' || typeof item.path !== 'string'
      || typeof item.fullPath !== 'string' || !item.fullPath.startsWith('/api/query/')
      || !isStringArray(item.requiredParams) || !isStringArray(item.allowedParams)
      || typeof item.requiresExplicitBranchForMultiBranch !== 'boolean'
      || typeof item.domain !== 'string'
      || (item.fixedParams !== undefined && !isStringRecord(item.fixedParams))
      || !Array.isArray(item.parameters) || !item.parameters.every(isAnalysisParameter)
      || typeof item.timeWindow !== 'string'
      || (item.timeWindowNote !== undefined && typeof item.timeWindowNote !== 'string')
      || !isAnalysisResultSchema(item.resultSchema)) {
      throw new Error('能力目录契约异常：capabilities 含非法项目');
    }
  }
  if (!versionAtLeast(pkg.version, data.minCliVersion)) {
    throw new Error(`当前 cx ${pkg.version} 低于服务端最低版本 ${data.minCliVersion}，请升级 cx`);
  }
  return response as CapabilitiesResponse;
}

/**
 * 分析命令不能沿用 cx query 的“提示后继续”：目录能力面向自动化报告，
 * 非法/缺失切省一律在请求业务数据前拒绝，避免服务端保守回落默认省后被误当目标省。
 */
export function validateBranchSelection(
  requiresExplicitBranch: boolean,
  scope: BranchScope | undefined,
  requestedBranch: string | undefined,
): string | null {
  if (!requiresExplicitBranch && !requestedBranch) return null;
  if (!scope || !Array.isArray(scope.visibleBranches)
    || typeof scope.canSwitch !== 'boolean' || typeof scope.canAggregateAll !== 'boolean') {
    return '身份响应缺少规范化 branchScope，无法安全判断分公司范围；请升级服务端';
  }
  const visible = scope.visibleBranches;
  if (visible.length === 0 || visible.some((branch) => !/^[A-Z]{2}$/.test(branch))) {
    return 'branchScope.visibleBranches 为空或包含非法省代码，已拒绝分析';
  }
  if (scope.canSwitch && visible.length <= 1) {
    return 'branchScope 声明可切省但可见省不足两个，已拒绝分析';
  }
  if (scope.canSwitch && !requestedBranch) {
    return '多省账号执行远程分析必须显式传 --targetBranch=<省代码>';
  }
  if (!requestedBranch) return null;
  if (requestedBranch === 'ALL') {
    return scope.canAggregateAll && visible.length > 1
      ? null
      : '当前账号没有分公司合并视图权限，不能使用 targetBranch=ALL';
  }
  if (!visible.includes(requestedBranch)) {
    return `targetBranch=${requestedBranch} 不在当前可切换范围（${visible.join(', ')}）`;
  }
  return null;
}

export function needsBranchScope(
  capability: Pick<AnalysisCapability, 'requiresExplicitBranchForMultiBranch'>,
  params: Record<string, string>,
): boolean {
  return capability.requiresExplicitBranchForMultiBranch || Boolean(params.targetBranch?.trim());
}

export async function fetchAnalysisCatalog(): Promise<CapabilitiesResponse['data']> {
  const raw = await cxGet<unknown>('/api/discover/analysis-capabilities');
  const response = decodeCapabilitiesResponse(raw);
  return response.data;
}

export async function fetchAnalysisCapabilities(): Promise<AnalysisCapability[]> {
  return (await fetchAnalysisCatalog()).capabilities;
}

export async function analysisCapabilitiesCommand(opts: { format?: OutputFormat }): Promise<void> {
  try {
    const capabilities = await fetchAnalysisCapabilities();
    const format = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');
    console.log(renderOutput(capabilities, format));
  } catch (error) {
    failWith(error);
  }
}

export async function analyzeCommand(
  id: string,
  opts: {
    format?: OutputFormat;
    timeoutMs?: number;
    params: Record<string, string>;
    evidence?: boolean;
  },
): Promise<void> {
  try {
    if (opts.evidence && opts.format && opts.format !== 'json') {
      process.stderr.write(kleur.red('✘ --evidence 仅支持 --format=json') + '\n');
      process.exit(EXIT.USAGE);
    }

    const catalog = await fetchAnalysisCatalog();
    const capabilities = catalog.capabilities;
    const capability = capabilities.find((item) => item.id === id);
    if (!capability) {
      process.stderr.write(kleur.red(`✘ 未知分析能力: ${id}`) + '\n');
      process.stderr.write(kleur.gray(`  可用能力: ${capabilities.map((item) => item.id).join(', ')}`) + '\n');
      process.exit(EXIT.USAGE);
    }

    const missing = capability.requiredParams.filter((param) => !opts.params[param]?.trim());
    if (missing.length > 0) {
      process.stderr.write(kleur.red(`✘ ${capability.name} 缺少必填参数: ${missing.join(', ')}`) + '\n');
      process.exit(EXIT.USAGE);
    }

    const paramIssue = validateAnalysisParams(capability, opts.params);
    if (paramIssue) {
      process.stderr.write(kleur.red(`✘ ${paramIssue}`) + '\n');
      process.exit(EXIT.USAGE);
    }

    let scope: ScopeResponse | undefined;
    if (needsBranchScope(capability, opts.params) || opts.evidence) {
      scope = await cxGet<ScopeResponse>('/api/auth/me');
      const branchIssue = validateBranchSelection(
        capability.requiresExplicitBranchForMultiBranch,
        scope.data.branchScope,
        opts.params.targetBranch?.trim(),
      );
      if (branchIssue) {
        process.stderr.write(kleur.red(`✘ ${branchIssue}`) + '\n');
        process.exit(EXIT.USAGE);
      }
    }

    const effectiveParams = { ...(capability.fixedParams ?? {}), ...opts.params };
    const requestOptions = { query: effectiveParams, timeoutMs: opts.timeoutMs };

    if (!opts.evidence) {
      const response = await cxGet<{ success: boolean; data: unknown }>(capability.fullPath, requestOptions);
      const resultIssue = validateAnalysisResult(capability.resultSchema, response.data);
      if (resultIssue) throw new Error(`分析结果不符合目录契约：${resultIssue}`);
      const format = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');
      console.log(renderOutput(response.data, format));
      return;
    }

    const [dataResponse, versionResponse, health] = await Promise.all([
      cxGetWithMeta<{ success: boolean; data: unknown }>(capability.fullPath, requestOptions),
      cxGet<{ success: boolean; data: Record<string, unknown> }>('/api/data/version'),
      cxGet<Record<string, unknown>>('/health'),
    ]);
    if (!dataResponse.requestId) {
      throw new Error('分析响应缺少 X-Request-Id，无法形成可追踪证据链');
    }
    const response = dataResponse.data;
    const resultIssue = validateAnalysisResult(capability.resultSchema, response.data);
    if (resultIssue) throw new Error(`分析结果不符合目录契约：${resultIssue}`);
    const cfg = loadConfig();
    const branchScope = scope?.data.branchScope;
    const requestedBranch = opts.params.targetBranch?.trim();
    const evidence = {
      schemaVersion: 2,
      source: 'remote',
      generatedAt: new Date().toISOString(),
      requestId: dataResponse.requestId,
      cliVersion: pkg.version,
      capabilityCatalog: {
        version: catalog.version,
        minCliVersion: catalog.minCliVersion,
      },
      capability: {
        id: capability.id,
        name: capability.name,
        description: capability.description,
        domain: capability.domain,
        path: capability.fullPath,
        timeWindow: capability.timeWindow,
        timeWindowNote: capability.timeWindowNote ?? null,
        requiredParams: capability.requiredParams,
        fixedParams: capability.fixedParams ?? {},
        resultSchema: capability.resultSchema,
      },
      parameters: {
        requested: opts.params,
        effective: effectiveParams,
      },
      effectiveBranch: requestedBranch
        || branchScope?.defaultBranch
        || scope?.data.branchCode
        || null,
      branchScope: branchScope ?? null,
      identity: scope
        ? toWhoamiMachineView(scope.data, cfg.tokenId ?? null, cfg.baseUrl)
        : null,
      health: {
        success: health.success,
        message: health.message,
        releaseSha: health.releaseSha,
        builtAt: health.builtAt,
        timestamp: health.timestamp,
      },
      dataVersion: versionResponse.data,
      fingerprints: {
        algorithm: 'sha256',
        parameters: sha256Canonical(effectiveParams),
        request: sha256Canonical({
          capabilityId: capability.id,
          path: capability.fullPath,
          catalogVersion: catalog.version,
          effectiveBranch: requestedBranch
            || branchScope?.defaultBranch
            || scope?.data.branchCode
            || null,
          parameters: effectiveParams,
        }),
        result: sha256Canonical(response.data),
      },
      data: response.data,
    };
    console.log(renderOutput(evidence, 'json'));
  } catch (error) {
    failWith(error);
  }
}
