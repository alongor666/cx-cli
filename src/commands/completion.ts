/**
 * cx completion <bash|zsh>
 *
 * 输出静态 shell 补全脚本（命令名 + 全局选项；query 的 key 不做动态补全）。
 * 命令与全局选项清单由 index.ts 从 commander 注册**运行时派生**后传入，
 * 本文件不手抄清单（历史教训：手抄清单曾漏 batch/describe/cube 三个新命令）。
 * 安装方法打到 stderr，脚本本体打到 stdout（便于重定向）。
 */
import kleur from 'kleur';
import { failWith, EXIT } from '../exit-codes.js';

/** 补全目标：由 commander 注册派生（index.ts completionTargets()），SSOT=命令注册本身 */
export interface CompletionTargets {
  commands: string[];
  globalOptions: string[];
}

export function bashScript({ commands, globalOptions }: CompletionTargets): string {
  return `# cx bash completion
_cx_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${commands.join(' ')}" -- "\$cur") )
  else
    COMPREPLY=( \$(compgen -W "${globalOptions.join(' ')}" -- "\$cur") )
  fi
}
complete -F _cx_completions cx
`;
}

export function zshScript({ commands, globalOptions }: CompletionTargets): string {
  return `#compdef cx
# cx zsh completion
_cx() {
  local -a commands
  commands=(${commands.map((c) => `'${c}'`).join(' ')})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  else
    _arguments ${globalOptions.map((o) => `'${o}'`).join(' ')}
  fi
}
_cx "\$@"
`;
}

export function completionCommand(shell: string, targets: CompletionTargets): void {
  try {
    if (shell === 'bash') {
      console.log(bashScript(targets));
      console.error(kleur.gray('# 安装: cx completion bash >> ~/.bashrc && source ~/.bashrc'));
      return;
    }
    if (shell === 'zsh') {
      console.log(zshScript(targets));
      console.error(kleur.gray('# 安装: cx completion zsh > ~/.zsh/completions/_cx（确保 fpath 含该目录）'));
      return;
    }
    console.error(kleur.red(`✘ 不支持的 shell: ${shell}（支持 bash | zsh）`));
    process.exit(EXIT.USAGE);
  } catch (err) {
    failWith(err);
  }
}
