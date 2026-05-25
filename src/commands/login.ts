/**
 * cx login
 *
 * 接受 PAT（--token），验证一次（GET /api/auth/me），成功后写入 ~/.chexian/config.json
 */
import kleur from 'kleur';
import readline from 'readline';
import { Writable } from 'stream';
import { loadConfig, saveConfig } from '../config.js';
import { cxGet, CxApiError } from '../api.js';

export async function loginCommand(opts: { token?: string; baseUrl?: string }): Promise<void> {
  const cfg = loadConfig();
  if (opts.baseUrl) cfg.baseUrl = opts.baseUrl;

  let token = opts.token;
  if (!token) {
    token = await promptToken();
  }
  if (!token.startsWith('cx_pat_')) {
    console.error(kleur.red('✘ Invalid token format. Expected cx_pat_xxx.yyy'));
    process.exit(1);
  }

  cfg.token = token;
  // 临时写入再校验，方便 cxGet 直接读
  saveConfig(cfg);

  try {
    const me = await cxGet<{ success: boolean; data: { username: string; role: string } }>('/api/auth/me');
    cfg.tokenId = token.slice('cx_pat_'.length, 'cx_pat_'.length + 8);
    saveConfig(cfg);
    console.error(kleur.green(`✔ Logged in as ${me.data.username} (${me.data.role})`));
    console.error(kleur.gray(`  Config: ~/.chexian/config.json`));
  } catch (err) {
    // 校验失败回滚
    delete cfg.token;
    delete cfg.tokenId;
    saveConfig(cfg);
    if (err instanceof CxApiError) {
      console.error(kleur.red(`✘ Login failed: ${err.message}`));
    } else {
      console.error(kleur.red(`✘ Login failed: ${(err as Error).message}`));
    }
    process.exit(1);
  }
}

function promptToken(): Promise<string> {
  // 隐藏输入（不在终端回显）
  const muted = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write(kleur.cyan('PAT (input hidden): '));
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer.trim());
    });
  });
}
