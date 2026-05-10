// Terminal page — standalone terminal panel using the same API as the composer terminal:
//   POST /api/terminal/start  — start/restart the terminal
//   SSE  /api/terminal/output — receive output
//   POST /api/terminal/input  — send keystrokes
//   POST /api/terminal/close  — close the terminal

const TERMINAL_PAGE = {
  term: null,
  fitAddon: null,
  source: null,    // EventSource for SSE output
  sessionId: null,
  resizeObserver: null,
};

function _terminalPageEls() {
  return {
    viewport: document.getElementById('terminalPageViewport'),
    surface: document.getElementById('terminalPageSurface'),
    workspaceSelect: document.getElementById('terminalPageWorkspaceSelect'),
  };
}

function _terminalPageTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  const g = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
  const background = g('--code-bg', isDark ? '#1A1A2E' : '#F5F0E5');
  const foreground = g('--pre-text', g('--text', isDark ? '#E2E8F0' : '#1A1610'));
  const muted = g('--muted', isDark ? '#C0C0C0' : '#5C5344');
  const accent = g('--accent-text', g('--accent', isDark ? '#FFD700' : '#8B6508'));
  const error = g('--error', isDark ? '#EF5350' : '#C62828');
  const success = g('--success', isDark ? '#4CAF50' : '#3D8B40');
  const warning = g('--warning', isDark ? '#FFA726' : '#E68A00');
  const info = g('--info', isDark ? '#4DD0E1' : '#0288A8');
  return {
    background, foreground, cursor: accent,
    selectionBackground: g('--accent-bg-strong', isDark ? 'rgba(255,215,0,.18)' : 'rgba(184,134,11,.18)'),
    black: isDark ? '#0D0D1A' : '#1A1610',
    red: error, green: success, yellow: warning, blue: info,
    magenta: accent, cyan: info, white: foreground,
    brightBlack: muted, brightRed: error, brightGreen: success,
    brightYellow: accent, brightBlue: info, brightMagenta: accent,
    brightCyan: info, brightWhite: isDark ? '#FFFFFF' : '#0F0D08',
  };
}

function _terminalPageDimensions() {
  const term = TERMINAL_PAGE.term;
  if (term && term.cols && term.rows) return { rows: term.rows, cols: term.cols };
  return { rows: 24, cols: 80 };
}

function _ensureXtermPage() {
  const { surface } = _terminalPageEls();
  if (!surface) return null;
  if (TERMINAL_PAGE.term) return TERMINAL_PAGE.term;
  if (typeof window.Terminal !== 'function') {
    surface.textContent = 'Terminal library failed to load. Check network access to cdn.jsdelivr.net.';
    return null;
  }
  const term = new window.Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    scrollback: 2000,
    convertEol: false,
    theme: _terminalPageTheme(),
  });
  let fitAddon = null;
  if (window.FitAddon && typeof window.FitAddon.FitAddon === 'function') {
    fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
  }
  if (window.WebLinksAddon && typeof window.WebLinksAddon.WebLinksAddon === 'function') {
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
  }
  term.open(surface);
  TERMINAL_PAGE.term = term;
  TERMINAL_PAGE.fitAddon = fitAddon;

  term.onData(data => {
    const sid = TERMINAL_PAGE.sessionId;
    if (!sid) return;
    api('/api/terminal/input', { method: 'POST', body: JSON.stringify({ session_id: sid, data }) })
      .catch(e => console.error('[terminal-page] input error:', e));
  });

  if (fitAddon) { try { fitAddon.fit(); } catch (_) {} }
  _setupTerminalPageResize();
  return term;
}

function _fitTerminalPage() {
  if (!TERMINAL_PAGE.fitAddon || !TERMINAL_PAGE.term) return;
  try {
    TERMINAL_PAGE.fitAddon.fit();
    const dims = _terminalPageDimensions();
    const sid = TERMINAL_PAGE.sessionId;
    if (sid) {
      api('/api/terminal/resize', { method: 'POST', body: JSON.stringify({ session_id: sid, rows: dims.rows, cols: dims.cols }) })
        .catch(() => {});
    }
  } catch (_) {}
}

function _setupTerminalPageResize() {
  if (TERMINAL_PAGE.resizeObserver) return;
  const { viewport } = _terminalPageEls();
  if (!viewport) return;
  TERMINAL_PAGE.resizeObserver = new ResizeObserver(() => _fitTerminalPage());
  TERMINAL_PAGE.resizeObserver.observe(viewport);
}

function _connectTerminalPageOutput() {
  const sid = TERMINAL_PAGE.sessionId;
  if (!sid) return;
  if (TERMINAL_PAGE.source) { try { TERMINAL_PAGE.source.close(); } catch (_) {} TERMINAL_PAGE.source = null; }

  const url = new URL('api/terminal/output', document.baseURI || location.href);
  url.searchParams.set('session_id', sid);
  const source = new EventSource(url.href, { withCredentials: true });
  TERMINAL_PAGE.source = source;

  source.addEventListener('output', ev => {
    if (TERMINAL_PAGE.source !== source) return;
    let text = '';
    try { text = (JSON.parse(ev.data) || {}).text || ''; } catch (_) { text = ev.data || ''; }
    if (TERMINAL_PAGE.term && text) TERMINAL_PAGE.term.write(text);
  });

  source.addEventListener('terminal_closed', () => {
    if (TERMINAL_PAGE.source !== source) return;
    if (TERMINAL_PAGE.term) TERMINAL_PAGE.term.writeln('\r\n[terminal closed]\r\n');
    try { source.close(); } catch (_) {}
    TERMINAL_PAGE.source = null;
  });

  source.addEventListener('terminal_error', ev => {
    if (TERMINAL_PAGE.source !== source) return;
    let msg = 'terminal error';
    try { msg = (JSON.parse(ev.data) || {}).error || msg; } catch (_) {}
    if (TERMINAL_PAGE.term) TERMINAL_PAGE.term.writeln('\r\n[' + msg + ']\r\n');
    try { source.close(); } catch (_) {}
    TERMINAL_PAGE.source = null;
  });
}

async function initTerminalPage() {
  const sid = (typeof S !== 'undefined' && S && S.session) ? S.session.session_id : null;
  const workspace = (typeof S !== 'undefined' && S && S.session) ? S.session.workspace : null;

  const term = _ensureXtermPage();
  if (!term) return;

  if (!sid || !workspace) {
    term.writeln('\r\n[No active workspace session. Start a chat first, then open Terminal.]\r\n');
    return;
  }

  TERMINAL_PAGE.sessionId = sid;
  const dims = _terminalPageDimensions();

  try {
    await api('/api/terminal/start', { method: 'POST', body: JSON.stringify({ session_id: sid, rows: dims.rows, cols: dims.cols }) });
    _connectTerminalPageOutput();
    _fitTerminalPage();
  } catch (e) {
    term.writeln('\r\n[Failed to start terminal: ' + (e && e.message || e) + ']\r\n');
  }
}

function clearTerminalPage() {
  if (TERMINAL_PAGE.term) TERMINAL_PAGE.term.clear();
}

function copyTerminalPageOutput() {
  if (!TERMINAL_PAGE.term) return;
  try {
    const sel = TERMINAL_PAGE.term.getSelection ? TERMINAL_PAGE.term.getSelection() : '';
    const text = sel || '';
    if (text) navigator.clipboard.writeText(text).catch(e => console.error('Copy failed:', e));
  } catch (e) {
    console.error('Failed to copy terminal output:', e);
  }
}

function switchTerminalPageWorkspace() {
  initTerminalPage();
}

function syncTerminalPageTheme() {
  if (TERMINAL_PAGE.term) TERMINAL_PAGE.term.options.theme = _terminalPageTheme();
}

// Self-initialize by watching #panelTerminal for the 'active' class.
// Avoids requiring panels.js to call initTerminalPage() explicitly.
(function _watchTerminalPanel() {
  let _activated = false;

  function _check() {
    const el = document.getElementById('panelTerminal');
    const isActive = el && el.classList.contains('active');
    if (isActive && !_activated) {
      _activated = true;
      initTerminalPage();
    } else if (!isActive) {
      _activated = false;
    }
  }

  function _startWatching() {
    const panel = document.getElementById('panelTerminal');
    if (panel) {
      new MutationObserver(_check).observe(panel, { attributes: true, attributeFilter: ['class'] });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        const p = document.getElementById('panelTerminal');
        if (p) new MutationObserver(_check).observe(p, { attributes: true, attributeFilter: ['class'] });
      }, { once: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _startWatching, { once: true });
  } else {
    _startWatching();
  }
})();
