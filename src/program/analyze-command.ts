import type { Command } from 'commander';
import { analyzeCommand } from '../commands/analyze.js';
import { parseExtraParams } from '../commands/query.js';
import type { OutputFormat } from '../output.js';

export type AnalyzeHandler = typeof analyzeCommand;

/** 注册 analyze 命令；handler 可注入，使 argv→Commander→params 契约可端到端测试。 */
export function registerAnalyzeCommand(program: Command, handler: AnalyzeHandler = analyzeCommand): Command {
  return program
    .command('analyze <capability>')
    .description('执行服务端登记的远程聚合分析能力；多省账号必须显式传 --targetBranch')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option('-f, --format <fmt>', '输出格式 table|json|csv')
    .option('--timeout <ms>', '请求超时毫秒数')
    .option('--evidence', '输出供 skills 复核的脱敏证据包（JSON）')
    .action((capability: string, options: { format?: OutputFormat; timeout?: string; evidence?: boolean }, cmd: Command) => handler(capability, {
      format: options.format,
      timeoutMs: options.timeout ? Number(options.timeout) : undefined,
      evidence: Boolean(options.evidence),
      params: parseExtraParams(cmd.args.slice(1)),
    }));
}
