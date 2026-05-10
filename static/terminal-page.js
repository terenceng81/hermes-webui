// Terminal page — standalone terminal + dashboard panel using the same API as the composer terminal:
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
  runHermes: false,
  activeView: 'terminal',
  theme: 'dark',
};

// ── Preset themes ─────────────────────────────────────────────────────────────

const _TERM_THEMES = {
  dark: {
    background: '#0D0D1A', foreground: '#E2E8F0', cursor: '#FFD700',
    selectionBackground: 'rgba(255,215,0,.18)',
    black: '#0D0D1A', red: '#EF5350', green: '#4CAF50', yellow: '#FFC107',
    blue: '#4DD0E1', magenta: '#FFD700', cyan: '#4DD0E1', white: '#E2E8F0',
    brightBlack: '#888', brightRed: '#EF5350', brightGreen: '#4CAF50',
    brightYellow: '#FFD700', brightBlue: '#4DD0E1', brightMagenta: '#FFD700',
    brightCyan: '#4DD0E1', brightWhite: '#FFFFFF',
  },
  matrix: {
    background: '#0A0F0A', foreground: '#00FF41', cursor: '#00FF41',
    selectionBackground: 'rgba(0,255,65,.25)',
    black: '#000', red: '#FF3333', green: '#00FF41', yellow: '#FFFF00',
    blue: '#4444FF', magenta: '#FF55FF', cyan: '#55FFFF', white: '#00FF41',
    brightBlack: '#555', brightRed: '#FF5555', brightGreen: '#55FF55',
    brightYellow: '#FFFF55', brightBlue: '#5555FF', brightMagenta: '#FF55FF',
    brightCyan: '#55FFFF', brightWhite: '#FFFFFF',
  },
};

function _resolveTerminalTheme(theme) {
  if (theme === 'match') return _terminalPageTheme();
  return _TERM_THEMES[theme] || _TERM_THEMES.dark;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function _terminalPageEls() {
  return {
    viewport: document.getElementById('terminalPageViewport'),
    surface: document.getElementById('terminalPageSurface'),
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

// ── xterm.js setup ────────────────────────────────────────────────────────────

function _ensureXtermPage() {
  const { surface } = _terminalPageEls();
  if (!surface) return null;
  if (TERMINAL_PAGE.term) return TERMINAL_PAGE.term;
  if (typeof window.Terminal !== 'function') {
    surface.textContent = 'Terminal library failed to load. Check network access to cdn.jsdelivr.net.';
    return null;
  }
  const storedTheme = TERMINAL_PAGE.theme || localStorage.getItem('hermes-terminal-theme') || 'dark';
  TERMINAL_PAGE.theme = storedTheme;
  const resolvedTheme = _resolveTerminalTheme(storedTheme);

  const term = new window.Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    scrollback: 2000,
    convertEol: false,
    theme: resolvedTheme,
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

  // Apply viewport background to match theme (overrides CSS var)
  const { viewport } = _terminalPageEls();
  if (viewport && resolvedTheme.background) viewport.style.background = resolvedTheme.background;

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

// ── SSE connection ────────────────────────────────────────────────────────────

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

// ── Public API ────────────────────────────────────────────────────────────────

async function initTerminalPage(force) {
  const sid = (typeof S !== 'undefined' && S && S.session) ? S.session.session_id : null;

  // Restore view preference (runs every open so hub/terminal tab stays correct)
  const storedView = localStorage.getItem('hermes-terminal-view') || 'terminal';
  switchTerminalView(storedView, true); // silent=true, skip fit until connected

  // Restore theme preference
  const storedTheme = localStorage.getItem('hermes-terminal-theme') || 'dark';
  setTerminalPageTheme(storedTheme);

  // Restore toggle state
  const toggle = document.getElementById('terminalRunHermesToggle');
  if (toggle) {
    const stored = localStorage.getItem('hermes-terminal-run-hermes');
    if (stored !== null) toggle.checked = stored === '1';
    TERMINAL_PAGE.runHermes = toggle.checked;
  }

  // If hub view is active, nothing more to do
  if (TERMINAL_PAGE.activeView === 'hub') return;

  // Skip full reconnect if already connected to the same session (unless forced)
  if (!force && TERMINAL_PAGE.sessionId && TERMINAL_PAGE.sessionId === sid && TERMINAL_PAGE.source) {
    _fitTerminalPage();
    return;
  }

  const term = _ensureXtermPage();
  if (!term) return;

  if (!sid) {
    term.writeln('\r\n[No active session. Start a chat first, then open Terminal.]\r\n');
    return;
  }

  TERMINAL_PAGE.sessionId = sid;
  const dims = _terminalPageDimensions();

  try {
    await api('/api/terminal/start', { method: 'POST', body: JSON.stringify({ session_id: sid, rows: dims.rows, cols: dims.cols }) });
    _connectTerminalPageOutput();
    _fitTerminalPage();
    if (TERMINAL_PAGE.runHermes && !force) {
      setTimeout(() => sendTerminalPageCommand('hermes\n'), 600);
    }
  } catch (e) {
    term.writeln('\r\n[Failed to start terminal: ' + (e && e.message || e) + ']\r\n');
  }
}

function sendTerminalPageCommand(cmd) {
  const sid = TERMINAL_PAGE.sessionId;
  if (!sid) {
    if (TERMINAL_PAGE.term) TERMINAL_PAGE.term.writeln('\r\n[Not connected. Click Reconnect first.]\r\n');
    return;
  }
  api('/api/terminal/input', { method: 'POST', body: JSON.stringify({ session_id: sid, data: cmd }) })
    .catch(e => console.error('[terminal-page] command error:', e));
}

function setTerminalPageRunHermes(enabled) {
  TERMINAL_PAGE.runHermes = enabled;
  try { localStorage.setItem('hermes-terminal-run-hermes', enabled ? '1' : '0'); } catch (_) {}
}

function setTerminalPageTheme(theme) {
  TERMINAL_PAGE.theme = theme;
  try { localStorage.setItem('hermes-terminal-theme', theme); } catch (_) {}
  document.querySelectorAll('.terminal-theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
  if (!TERMINAL_PAGE.term) return;
  const resolved = _resolveTerminalTheme(theme);
  TERMINAL_PAGE.term.options.theme = resolved;
  const { viewport } = _terminalPageEls();
  if (viewport) viewport.style.background = resolved.background || '';
}

function switchTerminalView(view, silent) {
  TERMINAL_PAGE.activeView = view || 'terminal';
  try { localStorage.setItem('hermes-terminal-view', TERMINAL_PAGE.activeView); } catch (_) {}

  const isHub = TERMINAL_PAGE.activeView === 'hub';
  const tEl = document.getElementById('mainTerminal');
  const hEl = document.getElementById('mainHub');
  const ctrlEl = document.getElementById('terminalControlPanel');
  const hubInfoEl = document.getElementById('terminalHubInfo');
  const refreshBtn = document.getElementById('terminalPageRefreshBtn');
  const hubReloadBtn = document.getElementById('terminalHubReloadBtn');

  if (tEl) tEl.style.display = isHub ? 'none' : '';
  if (hEl) hEl.style.display = isHub ? 'flex' : 'none';
  if (ctrlEl) ctrlEl.style.display = isHub ? 'none' : '';
  if (hubInfoEl) hubInfoEl.style.display = isHub ? '' : 'none';
  if (refreshBtn) refreshBtn.style.display = isHub ? 'none' : '';
  if (hubReloadBtn) hubReloadBtn.style.display = isHub ? '' : 'none';

  document.querySelectorAll('.terminal-view-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === TERMINAL_PAGE.activeView);
  });

  if (!isHub && !silent && TERMINAL_PAGE.term) _fitTerminalPage();
  if (isHub) { _setupHubIframeStatus(); if (!silent) { checkHubStatus(); fetchHubTheme(); } }
}

function terminalCmdHint(el) {
  const hint = document.getElementById('terminalCmdHint');
  if (hint) hint.textContent = el.dataset.hint || '';
}

function setHubTheme(name) {
  document.querySelectorAll('.hub-theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === name);
  });
  fetch('api/dashboard/theme', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(() => {
    const iframe = document.getElementById('hubIframe');
    if (iframe) { iframe.src = iframe.src; }
  }).catch(e => console.error('[hub] theme set failed:', e));
}

async function fetchHubTheme() {
  try {
    const r = await fetch('api/dashboard/theme', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    const active = data.active || 'default';
    document.querySelectorAll('.hub-theme-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === active);
    });
  } catch (_) {}
}

function navHubSection(path) {
  const iframe = document.getElementById('hubIframe');
  if (iframe) iframe.src = 'http://localhost:9119' + path;
}

function _setupHubIframeStatus() {
  const iframe = document.getElementById('hubIframe');
  if (!iframe || iframe._statusSetup) return;
  iframe._statusSetup = true;
  // Update Dashboard dot via iframe load event — avoids Chrome's Private
  // Network Access policy that blocks direct fetch() to localhost:9119.
  iframe.addEventListener('load', () => {
    const el = document.getElementById('hubStatusDash');
    if (el) el.className = 'hub-status-dot hub-status-dot--ok';
  });
}

async function checkHubStatus() {
  const dot = (id, state) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'hub-status-dot' + (state === 'ok' ? ' hub-status-dot--ok' : state === 'err' ? ' hub-status-dot--err' : '');
  };
  dot('hubStatusWebui', 'ok'); // WebUI is always up (we're on it)
  // Gateway: check via same-origin WebUI API
  try {
    const r = await fetch('api/sessions', { credentials: 'same-origin', cache: 'no-store' });
    dot('hubStatusGateway', r.ok ? 'ok' : 'err');
  } catch { dot('hubStatusGateway', 'err'); }
  // Dashboard dot is driven by the iframe load event — no direct fetch
  // (Chrome's Private Network Access policy blocks cross-port fetches to localhost)
  _setupHubIframeStatus();
}

function toggleTerminalSection(id) {
  const body = document.getElementById(id);
  if (!body) return;
  const collapsed = body.classList.toggle('collapsed');
  const chevron = document.getElementById(id + 'Chevron');
  if (chevron) chevron.textContent = collapsed ? '▸' : '▾';
  // Accordion: expanding one section collapses the other
  if (!collapsed) {
    const other = id === 'terminalShellCmds' ? 'terminalConsoleCmds' : 'terminalShellCmds';
    const otherBody = document.getElementById(other);
    if (otherBody && !otherBody.classList.contains('collapsed')) {
      otherBody.classList.add('collapsed');
      const otherChevron = document.getElementById(other + 'Chevron');
      if (otherChevron) otherChevron.textContent = '▸';
    }
  }
}

function clearTerminalPage() {
  if (TERMINAL_PAGE.term) TERMINAL_PAGE.term.clear();
}

function copyTerminalPageOutput() {
  if (!TERMINAL_PAGE.term) return;
  try {
    const sel = TERMINAL_PAGE.term.getSelection ? TERMINAL_PAGE.term.getSelection() : '';
    if (sel) navigator.clipboard.writeText(sel).catch(e => console.error('Copy failed:', e));
  } catch (e) {
    console.error('Failed to copy terminal output:', e);
  }
}

function syncTerminalPageTheme() {
  if (TERMINAL_PAGE.term && TERMINAL_PAGE.theme === 'match') {
    TERMINAL_PAGE.term.options.theme = _terminalPageTheme();
  }
}

// ── Self-initialize via MutationObserver ─────────────────────────────────────
// Watches #panelTerminal for the 'active' class — avoids modifying panels.js.

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
