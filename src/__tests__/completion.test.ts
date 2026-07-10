/**
 * completion 脚本生成纯函数测试：清单由调用方（index.ts 从 commander 派生）传入，
 * 断言脚本体完整包含传入的命令与全局选项（防手抄清单回归）。
 */
import { describe, it, expect } from 'vitest';
import { bashScript, zshScript, type CompletionTargets } from '../commands/completion.js';

const targets: CompletionTargets = {
  commands: ['login', 'query', 'describe', 'cube', 'batch', 'help'],
  globalOptions: ['--no-color', '--quiet', '--verbose', '--version', '--help'],
};

describe('completion 脚本生成', () => {
  it('bash 脚本包含全部命令与全局选项', () => {
    const script = bashScript(targets);
    for (const c of targets.commands) expect(script).toContain(c);
    for (const o of targets.globalOptions) expect(script).toContain(o);
    expect(script).toContain('complete -F _cx_completions cx');
  });

  it('zsh 脚本包含全部命令与全局选项', () => {
    const script = zshScript(targets);
    for (const c of targets.commands) expect(script).toContain(`'${c}'`);
    for (const o of targets.globalOptions) expect(script).toContain(`'${o}'`);
    expect(script).toContain('#compdef cx');
  });
});
