/**
 * cx completion <bash|zsh>
 *
 * 输出静态 shell 补全脚本（命令名 + 全局选项；query 的 key 不做动态补全）。
 * 安装方法打到 stderr，脚本本体打到 stdout（便于重定向）。
 */
import kleur from 'kleur';
import { failWith, EXIT } from '../exit-codes.js';

const COMMANDS = [
  'login', 'logout', 'whoami', 'routes', 'query', 'sql',
  'fields', 'metrics', 'presets', 'filters', 'data', 'health',
  'config', 'completion', 'help',
];

const GLOBAL_OPTIONS = ['--format', '--no-color', '--quiet', '--verbose', '--help', '--version'];

function bashScript(): string {
  return `# cx bash completion
_cx_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${COMMANDS.join(' ')}" -- "\$cur") )
  else
    COMPREPLY=( \$(compgen -W "${GLOBAL_OPTIONS.join(' ')}" -- "\$cur") )
  fi
}
complete -F _cx_completions cx
`;
}

function zshScript(): string {
  return `#compdef cx
# cx zsh completion
_cx() {
  local -a commands
  commands=(${COMMANDS.map((c) => `'${c}'`).join(' ')})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  else
    _arguments ${GLOBAL_OPTIONS.map((o) => `'${o}'`).join(' ')}
  fi
}
_cx "\$@"
`;
}

export function completionCommand(shell: string): void {
  try {
    if (shell === 'bash') {
      console.log(bashScript());
      console.error(kleur.gray('# 安装: cx completion bash >> ~/.bashrc && source ~/.bashrc'));
      return;
    }
    if (shell === 'zsh') {
      console.log(zshScript());
      console.error(kleur.gray('# 安装: cx completion zsh > ~/.zsh/completions/_cx（确保 fpath 含该目录）'));
      return;
    }
    console.error(kleur.red(`✘ 不支持的 shell: ${shell}（支持 bash | zsh）`));
    process.exit(EXIT.USAGE);
  } catch (err) {
    failWith(err);
  }
}
