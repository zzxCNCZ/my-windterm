const colors = {
  address: '#9bdf46', url: '#41d0ec', option: '#f5a04c', number: '#bd94f9',
  string: '#e0ca7f', keyword: '#8eaeff', error: '#ff6e7a', warning: '#ffc06a',
  success: '#8dd868', comment: '#929fa7', command: '#41d0ec', prompt: '#a4dc6a',
};

const tokens = /(?<url>https?:\/\/[^\s<>"'`]+)|(?<address>(?<![\w.:])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])|(?<![\w:])(?:[\da-f]{0,4}:){2,7}[\da-f]{0,4}(?![\w:]))|(?<option>(?<![\w-])--?[a-z][\w-]*)|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)|(?<error>\b(?:error|fatal|failed|failure|denied|could not|not found|exception)\b)|(?<warning>\b(?:warning|warn|deprecated)\b)|(?<success>\b(?:success|completed|passed)\b)|(?<keyword>\b(?:if|else|elif|then|fi|for|while|do|done|return|import|export|class|const|let|fn|def|async|await|null|true|false|select|from|where|join|group by)\b)|(?<number>\b(?:0x[\da-f]+|\d+(?:\.\d+)*)\b)/giu;

export function colorTokens(text, command, palette = colors) {
  if (!text || text.length > 4096) return [];
  const prompt = /^\s*(?:\[[^\]]{1,160}\]|[\w.-]+@[\w.-]+[^#$%]{0,140})[#$%]\s*/u.exec(text)
    ?? /^\s*[#$%❯➜]\s+/u.exec(text);
  if (!command && !prompt && /^\s*(?:#\s|\/\/|\/\*)/u.test(text)) {
    return [{ start: 0, end: text.length, color: palette.comment }];
  }
  const result = [];
  const commandIndex = command ? text.indexOf(command, prompt?.[0].length ?? 0) : prompt?.[0].length ?? -1;
  const verb = commandIndex >= 0 ? /^[^\s]+/u.exec(text.slice(commandIndex))?.[0] : null;
  if (prompt) result.push({ start: 0, end: prompt[0].length, color: palette.prompt });
  if (verb && commandIndex >= (prompt?.[0].length ?? 0)) {
    result.push({ start: commandIndex, end: commandIndex + verb.length, color: palette.command });
  }
  const start = result.at(-1)?.end ?? 0;
  for (const match of text.matchAll(tokens)) {
    if (match.index < start) continue;
    const category = Object.keys(match.groups).find(name => match.groups[name] !== undefined);
    result.push({ start: match.index, end: match.index + match[0].length, color: palette[category] });
    if (result.length >= 32) break;
  }
  return result;
}

export function colorCells(line, scratch, spans, columns) {
  const result = [];
  let offset = 0, index = 0;
  for (let column = 0; column < Math.min(columns, line.length) && index < spans.length; column++) {
    const cell = line.getCell(column, scratch);
    if (!cell) break;
    const width = cell.getWidth();
    if (!width) continue;
    const chars = cell.getChars();
    const end = offset + (chars.length || 1);
    while (index < spans.length && spans[index].end <= offset) index++;
    const span = spans[index];
    if (span && span.start <= offset && span.end >= end && chars.trim() && cell.isFgDefault()
      && cell.isBgDefault() && !cell.isInverse() && !cell.isInvisible() && !cell.isDim()) {
      const last = result.at(-1);
      if (last && last.x + last.width === column && last.foregroundColor === span.color) last.width += width;
      else result.push({ x: column, width, foregroundColor: span.color });
    }
    offset = end;
  }
  return result;
}

export function makeTerminalColors(term, commands, visible) {
  let rows = new Map(), frame = 0, enabled = true;
  let palette = colors;
  function clear() {
    for (const row of rows.values()) row.marker.dispose();
    rows.clear();
  }
  function update() {
    frame = 0;
    const buffer = term.buffer.active;
    if (!enabled || !visible() || buffer.type !== 'normal') { clear(); return; }
    const scratch = buffer.getNullCell();
    const promptCommands = new Map(commands().map(entry => [entry.marker.line, entry.text]));
    rows = new Map([...rows.values()].filter(row => !row.marker.isDisposed).map(row => [row.marker.line, row]));
    const end = buffer.viewportY + term.rows;
    for (const [index, row] of rows) {
      if (index < buffer.viewportY || index >= end) { row.marker.dispose(); rows.delete(index); }
    }
    for (let index = buffer.viewportY; index < end; index++) {
      const line = buffer.getLine(index);
      const runs = line ? colorCells(line, scratch, colorTokens(line.translateToString(true), promptCommands.get(index), palette), term.cols) : [];
      const key = JSON.stringify(runs);
      const previous = rows.get(index);
      if (previous?.key === key) continue;
      if (previous) { previous.marker.dispose(); rows.delete(index); }
      if (!runs.length) continue;
      const marker = term.registerMarker(index - buffer.baseY - buffer.cursorY);
      if (!marker) continue;
      for (const run of runs) term.registerDecoration({ ...run, marker });
      rows.set(index, { marker, key });
    }
  }
  function schedule() {
    if (!frame && visible()) frame = requestAnimationFrame(update);
  }
  return {
    schedule,
    setPalette(theme) {
      palette = {
        address: theme.brightGreen, url: theme.brightCyan, option: theme.brightYellow, number: theme.brightMagenta,
        string: theme.yellow, keyword: theme.brightBlue, error: theme.brightRed, warning: theme.brightYellow,
        success: theme.green, comment: theme.brightBlack, command: theme.cyan, prompt: theme.green,
      };
      schedule();
    },
    enable(value) { enabled = value; if (enabled) schedule(); else clear(); },
    clear,
    dispose() { cancelAnimationFrame(frame); clear(); },
  };
}
