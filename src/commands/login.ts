/**
 * cx login
 *
 * 接受 PAT，验证一次（GET /api/auth/me），成功后写入 ~/.chexian/config.json
 * 来源优先级：--token（会进 shell history，不推荐）> 管道 stdin（密码管理器注入）> 终端隐藏输入
 */
import kleur from 'kleur';
import readline from 'readline';
import { Writable } from 'stream';
import {
  loadConfig, updateFileConfig, deriveTokenId, normalizeBaseUrl, isInsecureBaseUrl,
} from '../config.js';
import { cxGet } from '../api.js';
import { EXIT, exitCodeForError } from '../exit-codes.js';

interface MeResp {
  success: boolean;
  data?: { username?: string; role?: string };
}

export async function loginCommand(opts: { token?: string; baseUrl?: string }): Promise<void> {
  let baseUrl: string;
  try {
    baseUrl = opts.baseUrl ? normalizeBaseUrl(opts.baseUrl) : loadConfig().baseUrl;
  } catch (err) {
    console.error(kleur.red(`✘ ${(err as Error).message}`));
    process.exit(EXIT.USAGE);
  }
  if (isInsecureBaseUrl(baseUrl)) {
    console.error(kleur.yellow(`⚠ ${baseUrl} 不是 https：PAT 将以明文在网络上传输`));
  }

  let token = opts.token?.trim();
  if (!token) {
    token = process.stdin.isTTY ? await promptToken() : await readStdin();
  }
  if (!token.startsWith('cx_pat_') || !deriveTokenId(token)) {
    console.error(kleur.red('✘ Invalid token format. Expected cx_pat_xxx.yyy'));
    console.error(kleur.gray('  在 Web 端「设置 → 访问令牌」生成 PAT 后重新运行 cx login'));
    process.exit(EXIT.USAGE);
  }

  // 用候选 PAT + 目标 baseUrl 显式校验：不先落盘（失败不会冲掉原有可用令牌），
  // 也不受 CX_PAT 环境变量覆盖（否则校验的其实是环境变量里的旧令牌）。
  let me: MeResp;
  try {
    me = await cxGet<MeResp>('/api/auth/me', { token, baseUrl });
  } catch (err) {
    console.error(kleur.red(`✘ Login failed: ${(err as Error).message}`));
    console.error(kleur.gray('  本地已保存的配置未被修改。'));
    // 退出码契约：401 → 2（鉴权失败）；网络/其它 → 1（通用错误）
    process.exit(exitCodeForError(err));
  }

  updateFileConfig({
    token,
    tokenId: deriveTokenId(token),
    ...(opts.baseUrl ? { baseUrl } : {}),
  });
  console.error(kleur.green(`✔ Logged in as ${me.data?.username ?? '(unknown)'} (${me.data?.role ?? 'unknown role'})`));
  console.error(kleur.gray('  Config: ~/.chexian/config.json'));
  if (process.env.CX_PAT && process.env.CX_PAT !== token) {
    console.error(kleur.yellow('⚠ 环境变量 CX_PAT 已设置且优先于配置文件：当前 shell 中的 cx 仍会使用 CX_PAT。'));
  }
  if (opts.baseUrl && process.env.CX_BASE_URL && process.env.CX_BASE_URL !== baseUrl) {
    console.error(kleur.yellow('⚠ 环境变量 CX_BASE_URL 已设置且优先于配置文件。'));
  }
}

/** 管道输入：读到 EOF（不要求结尾换行；readline.question 在无换行 EOF 时不会回调） */
async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += String(chunk);
  return data.trim();
}

function promptToken(): Promise<string> {
  // 隐藏输入（不在终端回显）
  const muted = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write(kleur.cyan('PAT (input hidden): '));
  return new Promise((resolve) => {
    let answered = false;
    rl.on('SIGINT', () => {
      rl.close();
      process.stderr.write('\n');
      process.exit(130);
    });
    // Ctrl-D / EOF：按空输入处理（随后以用法错误退出），而不是静默挂起后 exit 0
    rl.on('close', () => {
      if (!answered) resolve('');
    });
    rl.question('', (answer) => {
      answered = true;
      rl.close();
      process.stderr.write('\n');
      resolve(answer.trim());
    });
  });
}
