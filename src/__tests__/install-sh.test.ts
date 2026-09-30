/**
 * cli/scripts/install.sh 回归：在 UTF-8 locale 下真跑一遍（file:// 假 release）。
 *
 * 2026-09-30 事故：macOS 自带 bash 3.2 在 UTF-8 locale 下把紧跟 `$var` 的全角字符首字节算进变量名，
 * `$cx（` 被解析成未定义的 `cx\xEF`（`（` = EF BC 88），`set -u` 直接退出（v1.4.0 发布后业主首次真实安装即中招）。
 * 此前的实测都用 `env -i`（C locale）跑，恰好绕过。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/install.sh');
const posix = process.platform !== 'win32';
const utf8Locale = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
// 缺陷只在 macOS bash 3.2 上出现：darwin 固定 /bin/sh（即 bash 3.2），避免 PATH 里别的 sh 让真跑用例静默失去覆盖；
// Linux 上 sh 多为 dash、本身不犯此病，该平台的回归由静态用例承担
const shell = process.platform === 'darwin' ? '/bin/sh' : 'sh';

function assetName(): string {
  const osName = execFileSync('uname', ['-s'], { encoding: 'utf8' }).trim() === 'Darwin' ? 'darwin' : 'linux';
  const m = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim();
  return `cx-${osName}-${m === 'arm64' || m === 'aarch64' ? 'arm64' : 'x64'}`;
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-install-sh-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function fakeRelease(tamper = false): string {
  const rel = path.join(dir, 'rel');
  fs.mkdirSync(rel);
  const asset = assetName();
  const body = '#!/bin/sh\necho 9.9.9\n';
  fs.writeFileSync(path.join(rel, asset), tamper ? `${body}# tampered\n` : body, { mode: 0o755 });
  const sha = createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(path.join(rel, 'SHA256SUMS'), `${sha}  ${asset}\n`);
  return `file://${rel}`;
}

function runInstall(base: string) {
  const bin = path.join(dir, 'bin');
  const r = spawnSync(shell, [script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: dir, LANG: utf8Locale, LC_ALL: utf8Locale,
      CX_RELEASE_BASE: base, CX_BIN_DIR: bin, CX_SKIP_MCP: '1',
    },
  });
  return { ...r, bin };
}

describe('install.sh', () => {
  it('变量紧跟非 ASCII 字符时必须加花括号（bash 3.2 UTF-8 locale 会吞字节）', () => {
    const offenders = fs.readFileSync(script, 'utf8').split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !line.trimStart().startsWith('#') && /\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7F])/.test(line));
    expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([]);
  });

  it.runIf(posix)('UTF-8 locale 下完整跑通：下载 → 校验 → 原子安装 → 版本复核', () => {
    const r = runInstall(fakeRelease());
    expect(r.stderr).not.toMatch(/unbound variable/);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/SHA-256 校验通过/);
    expect(r.stderr).toMatch(/已安装 .*（9\.9\.9）/);
    expect(fs.existsSync(path.join(r.bin, 'cx'))).toBe(true);
  });

  it.runIf(posix)('二进制被篡改：校验失败中止，报错文案完整且不留半成品', () => {
    const r = runInstall(fakeRelease(true));
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toMatch(/unbound variable/);
    expect(r.stderr).toMatch(/SHA-256 不匹配（期望 [0-9a-f]{64}，实际 [0-9a-f]{64}），已中止/);
    expect(fs.existsSync(path.join(r.bin, 'cx'))).toBe(false);
  });
});
