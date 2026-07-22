/**
 * 为 cx 发布产物生成可由自动安装器消费的 manifest。
 * 仅处理本地已编译的二进制；发布工作流负责上传，不在这里访问网络或凭据。
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const names = [
  'cx-darwin-arm64',
  'cx-darwin-x64',
  'cx-linux-arm64',
  'cx-linux-x64',
  'cx-windows-arm64.exe',
  'cx-windows-x64.exe',
];

const assets = await Promise.all(names.map(async (name) => {
  const file = path.join(dist, name);
  const [contents, info] = await Promise.all([readFile(file), stat(file)]);
  return {
    name,
    size: info.size,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}));

async function sourceCommit() {
  if (process.env.CX_SOURCE_COMMIT) return process.env.CX_SOURCE_COMMIT;
  try {
    const syncedSource = (await readFile(path.join(root, 'source-commit.txt'), 'utf8')).trim();
    if (syncedSource) return syncedSource;
  } catch {
    // chexian-api 本地构建没有 source-commit.txt，继续回退当前 Git 提交。
  }
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
    return stdout.trim();
  } catch {
    throw new Error('无法解析源码提交指纹；请设置 CX_SOURCE_COMMIT 后重试');
  }
}

const manifest = {
  version: packageJson.version,
  sourceCommit: await sourceCommit(),
  assets,
};
await writeFile(path.join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await writeFile(
  path.join(dist, 'SHA256SUMS'),
  assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n') + '\n',
  'utf8',
);
console.log(`release manifest: v${manifest.version}, ${assets.length} assets`);
