function absolutePath(path) {
  return path?.startsWith('/') && path.length <= 4096 && new TextEncoder().encode(path).length <= 4096
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(path) ? path : null;
}

export function terminalDirectory(code, payload) {
  if (code === 1337) return payload.startsWith('CurrentDir=') ? absolutePath(payload.slice(11)) : null;
  if (code !== 7 || payload.length > 13000) return null;
  const match = /^file:\/\/[^/\s@?#]*([^?#]*)$/u.exec(payload);
  if (!match || !match[1].startsWith('/')) return null;
  try {
    return absolutePath(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

const shellFunction = String.raw`__mwt_report_cwd() {
  local previous_status=$?
  case "$PWD" in *[[:cntrl:]]*) return "$previous_status" ;; esac
  if [ -n "${'$'}{TMUX-}" ]; then
    printf '\033Ptmux;\033\033]1337;CurrentDir=%s\007\033\\' "$PWD"
  else
    printf '\033]1337;CurrentDir=%s\007' "$PWD"
  fi
  return "$previous_status"
}`;

export const directoryHooks = {
  bash: shellFunction + '\n' + String.raw`case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
  'declare -a '*) PROMPT_COMMAND+=(__mwt_report_cwd) ;;
  *) PROMPT_COMMAND="${'$'}{PROMPT_COMMAND-}"$'\n'__mwt_report_cwd ;;
esac`,
  zsh: shellFunction + '\nautoload -Uz add-zsh-hook\nadd-zsh-hook precmd __mwt_report_cwd',
  fish: String.raw`function __mwt_report_cwd --on-event fish_prompt
  if string match -rq '[[:cntrl:]]' -- "$PWD"
    return
  end
  if set -q TMUX
    printf '\033Ptmux;\033\033]1337;CurrentDir=%s\007\033\\' "$PWD"
  else
    printf '\033]1337;CurrentDir=%s\007' "$PWD"
  end
end`,
};
