import { SearchAddon } from '@xterm/addon-search';

const decorations = {
  matchBackground: '#55452a', matchOverviewRuler: '#ac8343',
  activeMatchBackground: '#73541b', activeMatchBorder: '#ffd274',
  activeMatchColorOverviewRuler: '#ffd274',
};

export function makeTerminalSearch(term, changed) {
  let query = '', caseSensitive = false, enabled = false, disposed = false;
  let result = { found: false, index: -1, count: 0 };
  const addon = new SearchAddon();
  term.loadAddon(addon);
  addon.onDidChangeResults(({ resultIndex, resultCount }) => {
    result = { found: resultCount > 0, index: resultIndex, count: resultCount };
    if (enabled) changed();
  });
  const bufferChange = term.buffer.onBufferChange(() => {
    addon.clearDecorations();
    result = { found: false, index: -1, count: 0 };
    if (enabled) {
      changed();
      if (term.buffer.active.type === 'normal') {
        queueMicrotask(() => { if (!disposed) direction(false, true); });
      }
    }
  });

  function stop() {
    if (disposed || !enabled) return;
    enabled = false;
    addon.clearDecorations();
    if (query) term.clearSelection();
    result = { found: false, index: -1, count: 0 };
  }

  function direction(previous, incremental) {
    if (!enabled || !query || term.buffer.active.type !== 'normal') return;
    const options = { caseSensitive, incremental, decorations };
    const found = previous ? addon.findPrevious(query, options) : addon.findNext(query, options);
    if (!found) result = { found: false, index: -1, count: 0 };
    changed();
  }

  return {
    get state() { return { query, caseSensitive, ...result }; },
    start() { enabled = true; direction(false, true); },
    stop,
    dispose() {
      stop();
      disposed = true;
      bufferChange.dispose();
    },
    config(text, matchCase = caseSensitive) {
      if (query === text && caseSensitive === matchCase) return;
      if (query) term.clearSelection();
      addon.clearDecorations();
      query = text;
      caseSensitive = matchCase;
      result = { found: false, index: -1, count: 0 };
      direction(false, true);
      changed();
    },
    next(previous = false) { direction(previous, false); },
  };
}
