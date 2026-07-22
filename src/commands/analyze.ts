/**
 * cx analyze <capability>
 *
 * 消费服务端分析能力目录并转发到其已保护的 GET 查询路由。此处不维护 SQL，
 * 也不接受行级导出能力；能力、时间口径和必填参数均由服务端目录决定。
 */
import kleur from 'kleur';
import { cxGet } from '../api.js';
import { EXIT, failWith } from '../exit-codes.js';
import { renderOutput, type OutputFormat } from '../output.js';

export interface AnalysisCapability {
  id: string;
  name: string;
  description: string;
  path: string;
  fullPath: string;
  requiredParams: string[];
  requiresExplicitBranchForMultiBranch: boolean;
  domain: string;
}

interface CapabilitiesResponse {
  success: boolean;
  data: { version: number; capabilities: AnalysisCapability[] };
}

interface ScopeResponse {
  success: boolean;
  data: { branchCode?: string; visibleBranches?: string[] };
}

/**
 * 分析命令不能沿用 cx query 的“提示后继续”：目录能力面向自动化报告，
 * 非法/缺失切省一律在请求业务数据前拒绝，避免服务端保守回落默认省后被误当目标省。
 */
export function validateBranchSelection(
  requiresExplicitBranch: boolean,
  visibleBranches: string[] | undefined,
  requestedBranch: string | undefined,
): string | null {
  const visible = (visibleBranches ?? []).filter((branch) => /^[A-Z]{2}$/.test(branch));
  if (!requiresExplicitBranch || visible.length <= 1) return null;
  if (!requestedBranch) return '多省账号执行远程分析必须显式传 --targetBranch=<省代码>';
  if (requestedBranch === 'ALL') return null;
  if (!visible.includes(requestedBranch)) {
    return `targetBranch=${requestedBranch} 不在当前可切换范围（${visible.join(', ')}）`;
  }
  return null;
}

export async function fetchAnalysisCapabilities(): Promise<AnalysisCapability[]> {
  const response = await cxGet<CapabilitiesResponse>('/api/discover/analysis-capabilities');
  return response.data.capabilities;
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
  opts: { format?: OutputFormat; timeoutMs?: number; params: Record<string, string> },
): Promise<void> {
  try {
    const capabilities = await fetchAnalysisCapabilities();
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

    const scope = await cxGet<ScopeResponse>('/api/auth/me');
    const branchIssue = validateBranchSelection(
      capability.requiresExplicitBranchForMultiBranch,
      scope.data.visibleBranches,
      opts.params.targetBranch?.trim(),
    );
    if (branchIssue) {
      process.stderr.write(kleur.red(`✘ ${branchIssue}`) + '\n');
      process.exit(EXIT.USAGE);
    }

    const response = await cxGet<{ success: boolean; data: unknown }>(capability.fullPath, {
      query: opts.params,
      timeoutMs: opts.timeoutMs,
    });
    const format = opts.format ?? (process.stdout.isTTY ? 'table' : 'json');
    console.log(renderOutput(response.data, format));
  } catch (error) {
    failWith(error);
  }
}
