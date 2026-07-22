#!/usr/bin/env node
/**
 * cx — chexian-api 只读 CLI
 *
 * 鉴权：PAT（Personal Access Token）
 * 权限：完全继承 PAT 关联用户（allowedRoutes / dataScope / organization）
 * 限制：强制只读，POST/PUT/DELETE 由服务端 readonlyMiddleware 一律 403
 *
 * 退出码契约：0 成功 · 1 通用错误 · 2 鉴权失败 · 3 权限不足 · 4 用法错误 · 5 限流
 */
import { cliState } from './cli-state.js'; // 必须第一个 import（NO_COLOR 预处理）
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { whoamiCommand } from './commands/whoami.js';
import { routesCommand } from './commands/routes.js';
import { queryCommand, parseExtraParams } from './commands/query.js';
// interactive 走 lazy import：仅 wizard 入口 (-i / 无 key) 时才加载 readline + interactive.ts，
// 保持非交互冷启动的零依赖载入（CI cli-perf-sentinel 闸）
import { fieldsCommand } from './commands/fields.js';
import { metricsCommand } from './commands/metrics.js';
import { describeCommand } from './commands/describe.js';
import { cubeCommand } from './commands/cube.js';
import { presetsCommand } from './commands/presets.js';
import { sqlCommand } from './commands/sql.js';
import { filtersCommand } from './commands/filters.js';
import { dataCommand, type DataSub } from './commands/data.js';
import { healthCommand } from './commands/health.js';
import { batchCommand } from './commands/batch.js';
import {
  configGetCommand, configSetCommand, configUnsetCommand,
  configListCommand, configPathCommand,
} from './commands/config-cmd.js';
import { completionCommand } from './commands/completion.js';
import { analysisCapabilitiesCommand } from './commands/analyze.js';
import { registerAnalyzeCommand } from './program/analyze-command.js';
import { apiDebug } from './api.js';
import kleur from 'kleur';
import { EXIT, exitCodeForError } from './exit-codes.js';

const program = new Command();

program
  .name('cx')
  .description('chexian-api 只读 CLI（PAT 鉴权）— 车险数据分析平台命令行入口')
  .version(pkg.version)
  .option('--no-color', '禁用彩色输出（也尊重 NO_COLOR 环境变量）')
  .option('-q, --quiet', '抑制提示性输出（错误仍打印到 stderr）')
  .option('--verbose', 'stderr 打印请求 URL 与耗时')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    cliState.quiet = Boolean(opts.quiet);
    cliState.verbose = Boolean(opts.verbose);
    apiDebug.verbose = cliState.verbose;
  })
  .addHelpText('after', `
示例:
  $ cx login                          保存 PAT
  $ cx routes --search 赔案           按关键词找路由
  $ cx query KPI --year=2026          调用 KPI 查询
  $ cx query /repair/overview         path 直通调用
  $ echo "SELECT ..." | cx sql -      stdin 管道 SQL
  $ cx health                         连通性诊断

退出码: 0 成功 · 1 通用错误 · 2 鉴权失败 · 3 权限不足 · 4 用法错误 · 5 限流`);

program
  .command('login')
  .description('保存 PAT 到 ~/.chexian/config.json（chmod 600）')
  .option('-t, --token <pat>', '直接传入 PAT（也支持 stdin/交互式）')
  .option('-b, --base-url <url>', '后端 baseUrl，覆盖默认 https://chexian.cretvalu.com')
  .action(loginCommand);

program
  .command('logout')
  .description('清除本地保存的 PAT（不会吊销服务端 token）')
  .action(logoutCommand);

program
  .command('whoami')
  .description('显示当前 PAT 对应的用户、角色、数据范围与 baseUrl')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action((options) => whoamiCommand({ format: options.format }));

registerAnalyzeCommand(program);

program
  .command('capabilities')
  .description('列出服务端登记的远程分析能力及必填参数')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action((options) => analysisCapabilitiesCommand({ format: options.format }));

program
  .command('routes')
  .description('列出所有可用查询路由（按 tag 分组）')
  .option('--refresh', '强制刷新 route-catalog 缓存')
  .option('--tag <tag>', '按 tag 过滤（如 kpi / trend / claims-detail / repair）')
  .option('--search <kw>', '按关键词搜索 key/path/summary/description')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action(routesCommand)
  .addHelpText('after', `
示例:
  $ cx routes --tag claims-detail
  $ cx routes --search 维修
  $ cx routes --format=json | jq '.[].key'`);

program
  .command('query [key|path]')
  .description('调用查询路由（key 宽容匹配 / catalog path / 以 / 开头直通）；缺 key 或 -i 进入交互式构建器')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .option('-f, --format <fmt>', '输出格式 table|json|csv（非终端默认 json）')
  .option('-l, --limit <n>', '客户端截断行数（仅列表型响应）')
  .option('--timeout <ms>', '请求超时毫秒数')
  .option('-i, --interactive', '交互式构建查询（无 key 时自动进入）')
  .option('--describe', '先打印字段图例到 stderr（裸输出列→中文名/口径/单位+生效时间口径），再返回数据')
  .action(async (key, options, cmd) => {
    const wizardOpts = {
      format: options.format,
      limit: options.limit ? Number(options.limit) : undefined,
      timeoutMs: options.timeout ? Number(options.timeout) : undefined,
    };
    if (!key || options.interactive) {
      const { interactiveQueryCommand } = await import('./commands/interactive.js');
      return interactiveQueryCommand(wizardOpts);
    }
    const extras = parseExtraParams(cmd.args.slice(1));
    return queryCommand(key, { ...wizardOpts, params: extras, describe: Boolean(options.describe) });
  })
  .addHelpText('after', `
示例:
  $ cx query                                  （无 key → 交互式 wizard）
  $ cx query -i                               （强制 wizard）
  $ cx query KPI --year=2026 --org_level_3=分公司A
  $ cx query claims-detail-heatmap --dateStart=2026-01-01
  $ cx query /renewal-tracker                   （path 直通）
  $ cx query RENEWAL_TRACKER --describe --start=2026-06-01 --end=2026-06-30 --cutoff=2026-06-18   （先看 A-E 字段图例）
  $ cx query TREND --limit=10 --format=csv`);

program
  .command('sql <query>')
  .description('DuckDB SELECT/WITH 直通；参数为 - 时从 stdin 读取')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .option('--timeout <ms>', '请求超时毫秒数')
  .action((query, options) =>
    sqlCommand(query, {
      format: options.format,
      timeoutMs: options.timeout ? Number(options.timeout) : undefined,
    }),
  )
  .addHelpText('after', `
示例:
  $ cx sql "SELECT customer_category, COUNT(*) c FROM PolicyFact GROUP BY 1"
  $ echo "SELECT org_level_3, SUM(premium) FROM PolicyFact GROUP BY 1" | cx sql -`);

program
  .command('fields')
  .description('列出字段注册表（含 column 可查列名 / queryable / 真实类型）。--groupable 仅列可分组字段；--verbose 附 ETL 入库别名。')
  .option('--groupable', '只列出可分组字段')
  .option('--verbose', '附带 ETL 入库元数据（ingestTypes/ingestAliases，不可 SELECT）')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action((options) => {
    fieldsCommand({
      groupable: Boolean(options.groupable),
      verbose: Boolean(options.verbose),
      format: options.format,
    });
  });

program
  .command('metrics')
  .description('列出指标注册表。--category 按分类过滤。')
  .option('--category <cat>', '指标分类（foundation|ratio|cost|cross_sell|growth|repair|plan|structure|renewal|sales_team）')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action((options) => {
    metricsCommand({ category: options.category, format: options.format });
  });

program
  .command('describe <relation>')
  .description('自省视图 schema（列名/类型）。relation 须在联邦白名单内（PolicyFact / RenewalTrackerFact 等派生视图）。')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action((relation, options) => {
    describeCommand(relation, { format: options.format });
  });

program
  .command('cube')
  .description('语义层「选指标 × 任意维度子集」可组合查询。续保族需 --start/--end/--cutoff；PolicyFact 指标走标准筛选器。额外 --<筛选>=值 透传。')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .requiredOption('--metric <id>', '单个指标 id（续保 renewal_*_count / PolicyFact 可加/比率指标）')
  .option('--dims <d1,d2,...>', '逗号分隔维度子集（续保 0-4 维 / PolicyFact 1-2 维）')
  .option('--start <date>', '续保路径：到期窗口起 YYYY-MM-DD')
  .option('--end <date>', '续保路径：到期窗口止 YYYY-MM-DD')
  .option('--cutoff <date>', '续保路径：观察截止日 YYYY-MM-DD')
  .option('-l, --limit <n>', '返回行数，默认 100，上限 500')
  .option('-f, --format <fmt>', '输出格式 table|json|csv（非终端默认 json）')
  .option('--timeout <ms>', '请求超时毫秒数')
  .action((options, cmd) => {
    const extras = parseExtraParams(cmd.args);
    return cubeCommand({
      metric: options.metric,
      dims: options.dims,
      start: options.start,
      end: options.end,
      cutoff: options.cutoff,
      limit: options.limit ? Number(options.limit) : undefined,
      format: options.format,
      timeoutMs: options.timeout ? Number(options.timeout) : undefined,
      params: extras,
    });
  })
  .addHelpText('after', `
示例:
  $ cx cube --metric=renewal_renewed_count --dims=org_level_3,is_new_car --start=2026-06-01 --end=2026-06-30 --cutoff=2026-06-18
  $ cx cube --metric=renewal_due_count --dims=org_level_3 --start=2026-06-01 --end=2026-06-30 --cutoff=2026-06-18 --orgNames=天府
  $ cx cube --metric=total_premium --dims=org_level_3,customer_category   （PolicyFact 可加/比率指标走 pivot，1-2 维）`);

program
  .command('presets')
  .description('列出筛选器 schema 与车型快捷预设。')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action((options) => {
    presetsCommand({ format: options.format });
  });

program
  .command('filters')
  .description('列出筛选维度的可选值（写查询条件前先看维度有哪些值）；本地缓存 4h，--refresh 强刷')
  .option('--dimension <name>', '只看指定维度（如 org_level_3）')
  .option('--refresh', '强制刷新本地缓存（按 PAT tokenId 隔离）')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action((options) =>
    filtersCommand({ dimension: options.dimension, refresh: Boolean(options.refresh), format: options.format }),
  )
  .addHelpText('after', `
示例:
  $ cx filters --dimension org_level_3
  $ cx filters --refresh                  强制重新拉取`);

program
  .command('data <sub>')
  .description('数据域只读元信息：version（数据新鲜度）| files（文件清单）| metadata（数据集元数据）')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action((sub: string, options) => {
    const valid: DataSub[] = ['version', 'files', 'metadata'];
    if (!valid.includes(sub as DataSub)) {
      console.error(`✘ 未知子命令: ${sub}（支持 ${valid.join(' | ')}）`);
      process.exit(EXIT.USAGE);
    }
    return dataCommand(sub as DataSub, { format: options.format });
  })
  .addHelpText('after', `
示例:
  $ cx data version       查看当前数据日期（ETL 新鲜度）
  $ cx data files         已加载数据文件清单`);

program
  .command('health')
  .description('一站式连通性诊断（/health 存活 + 数据版本 + 延迟）')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action((options) => healthCommand({ format: options.format }));

program
  .command('batch')
  .description('从 stdin 读 JSONL（{route, params?}）批量调用，复用 keep-alive 连接')
  .option('-c, --concurrency <n>', '并发数（默认 8）', '8')
  .option('--summary', '末尾在 stderr 输出汇总（total/ok/fail/p50/p95/total_ms）')
  .option('--timeout <ms>', '单次请求超时毫秒数')
  .action((options) =>
    batchCommand({
      concurrency: Math.max(1, Number(options.concurrency) || 8),
      summary: Boolean(options.summary),
      timeoutMs: options.timeout ? Number(options.timeout) : undefined,
    }),
  )
  .addHelpText('after', `
路由寻址（同 cx query）:
  catalog key   route: "KPI"                  → 大小写/连字符宽容（/-_ 互通）
  catalog path  route: "/kpi"                 → 包装为 /api/query/kpi
  /api/* 直通   route: "/api/data/version"    → 不加前缀
  顶层直通      route: "/health"              → 不在 catalog 时 fall back 顶层

示例:
  $ echo '{"route":"KPI","params":{"year":2026}}' | cx batch --summary
  $ printf '{"route":"/health"}\\n%.0s' {1..50} | cx batch --concurrency=4 --summary
  $ cx routes --format=json | jq -c '.[] | {route: .path}' | cx batch`);

const configCmd = program
  .command('config')
  .description('管理本地配置 ~/.chexian/config.json（白名单: baseUrl）');
configCmd.command('get <key>').description('读取配置项').action(configGetCommand);
configCmd.command('set <key> <value>').description('写入配置项（baseUrl 校验 URL 格式）').action(configSetCommand);
configCmd.command('unset <key>').description('清除配置项（恢复默认）').action(configUnsetCommand);
configCmd.command('list').description('列出全部配置（token 脱敏）').action(configListCommand);
configCmd.command('path').description('打印配置文件路径').action(configPathCommand);
configCmd.addHelpText('after', `
示例:
  $ cx config set baseUrl http://localhost:3000    切到本地后端
  $ cx config unset baseUrl                        恢复生产默认`);

/** 补全清单从 commander 注册运行时派生（SSOT=命令注册），杜绝手抄清单漏新命令 */
function completionTargets(root: Command): { commands: string[]; globalOptions: string[] } {
  return {
    commands: [...root.commands.map((c) => c.name()), 'help'],
    globalOptions: [
      ...root.options.map((o) => o.long).filter((f): f is string => Boolean(f)),
      '--help',
    ],
  };
}

program
  .command('completion <shell>')
  .description('输出 shell 补全脚本（bash | zsh）')
  .action((shell: string) => completionCommand(shell, completionTargets(program)));

// 退出码契约统一化：commander 内置校验错误（缺参数 / 未知命令 / 未知选项）默认走 "error:" + exit 1，
// 这绕过了 failWith 出口。递归给所有命令（含 config 嵌套子命令）挂 exitOverride 改为抛错，
// 并把默认 "error: xxx" 重渲染为 "✘ xxx" + 可操作提示，最终由下方 catch 统一映射到 exit 4。
// 帮助文本走 writeOut（stdout）不受影响，已快照的 <cmd> --help 输出零漂移。
function applyExitContract(cmd: Command): void {
  cmd.exitOverride();
  cmd.configureOutput({
    writeErr: (str) => {
      if (str.startsWith('error: ')) {
        process.stderr.write(kleur.red('✘ ' + str.slice('error: '.length)));
        process.stderr.write(kleur.dim('  运行 cx --help 或 cx <命令> --help 查看用法') + '\n');
      } else {
        process.stderr.write(str); // 无命令时的 help 输出等原样透传
      }
    },
  });
  cmd.commands.forEach(applyExitContract);
}
applyExitContract(program);

program.parseAsync(process.argv).catch((err) => {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  // 帮助 / 版本展示：正常退出（writeOut 已打印内容）
  if (code === 'commander.helpDisplayed' || code === 'commander.help' || code === 'commander.version') {
    process.exit(EXIT.OK);
  }
  // commander 内置用法错误：消息已由 writeErr 渲染为 ✘ + 提示，这里只定退出码
  if (code.startsWith('commander.')) {
    process.exit(EXIT.USAGE);
  }
  // 其它运行时错误：✘ 前缀 + 按错误类型映射退出码（CxApiError 401→2 / 403→3 / 429→5）
  process.stderr.write((err instanceof Error ? kleur.red(`✘ ${err.message}`) : String(err)) + '\n');
  process.exit(exitCodeForError(err));
});
