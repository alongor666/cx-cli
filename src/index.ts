#!/usr/bin/env node
/**
 * cx — chexian-api 只读 CLI
 *
 * 鉴权：PAT（Personal Access Token）
 * 权限：完全继承 PAT 关联用户（allowedRoutes / dataScope / organization）
 * 限制：强制只读，仅 GET /api/query/* 与 /api/data/* 部分端点
 */
import { Command } from 'commander';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { whoamiCommand } from './commands/whoami.js';
import { routesCommand } from './commands/routes.js';
import { queryCommand, parseExtraParams } from './commands/query.js';
import { fieldsCommand } from './commands/fields.js';
import { metricsCommand } from './commands/metrics.js';
import { presetsCommand } from './commands/presets.js';
import { sqlCommand } from './commands/sql.js';

const program = new Command();

program
  .name('cx')
  .description('chexian-api 只读 CLI (PAT auth)')
  .version('0.1.0');

program
  .command('login')
  .description('保存 PAT 到 ~/.chexian/config.json')
  .option('-t, --token <pat>', '直接传入 PAT（也支持 stdin/交互式）')
  .option('-b, --base-url <url>', '后端 baseUrl，覆盖默认 https://chexian.cretvalu.com')
  .action(loginCommand);

program
  .command('logout')
  .description('清除本地保存的 PAT（不会吊销服务端 token）')
  .action(logoutCommand);

program
  .command('whoami')
  .description('显示当前 PAT 对应的用户与角色')
  .action(whoamiCommand);

program
  .command('routes')
  .description('列出所有可用 query 路由')
  .option('--refresh', '强制刷新 route-catalog 缓存')
  .option('--tag <tag>', '按 tag 过滤（如 kpi / trend / cross-sell）')
  .action(routesCommand);

program
  .command('query <key>')
  .description('调用查询路由：cx query KPI [--year=2026] [--org_level_3=分公司A] [--format=json]')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .option('-f, --format <fmt>', '输出格式 table|json|csv', 'table')
  .action((key, options, cmd) => {
    const extras = parseExtraParams(cmd.args.slice(1));
    queryCommand(key, { format: options.format, params: extras });
  });

program
  .command('fields')
  .description('列出字段注册表（42 个字段）。--groupable 仅列可分组（VARCHAR/TEXT）字段。')
  .option('--groupable', '只列出可分组字段')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action((options) => {
    fieldsCommand({ groupable: Boolean(options.groupable), format: options.format });
  });

program
  .command('metrics')
  .description('列出指标注册表（25 个指标）。--category 按分类过滤。')
  .option('--category <cat>', '指标分类（foundation|ratio|cost|cross_sell|growth|repair|plan|structure）')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action((options) => {
    metricsCommand({ category: options.category, format: options.format });
  });

program
  .command('presets')
  .description('列出筛选器 schema 与 9 个车型快捷预设。')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action((options) => {
    presetsCommand({ format: options.format });
  });

program
  .command('sql <query>')
  .description('DuckDB SELECT/WITH 直通：cx sql "SELECT customer_category, COUNT(*) c FROM PolicyFact GROUP BY 1"')
  .option('-f, --format <fmt>', '输出格式 table|json|csv')
  .action((query, options) => {
    sqlCommand(query, { format: options.format });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
