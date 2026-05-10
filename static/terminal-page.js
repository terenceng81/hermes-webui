// Terminal page — standalone terminal panel with xterm.js integration
// Separate from the composer terminal in terminal.js

const TERMINAL_PAGE = {
  term: null,
  fitAddon: null,
  ws: null,
  sessionId: null,
  workspace: null,
  resizeObserver: null,
  typedLine: '',
  isOpen: false,
};

function _terminalPageEls() {
  return {
    viewport: document.getElementById('terminalPageViewport'),
    surface: document.getElementById('terminalPageSurface'),
    workspaceSelect: document.getElementById('terminalPageWorkspaceSelect'),
    refreshBtn: document.getElementById('terminalPageRefreshBtn'),
    copyBtn: document.getElementById('terminalPageCopyBtn'),
    clearBtn: document.getElementById('terminalPageClearBtn'),
  };
}

function _terminalPageTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  const background = getComputedStyle(document.documentElement).getPropertyValue('--code-bg').trim() || (isDark ? '#1A1A2E' : '#F5F0E5');
  const foreground = getComputedStyle(document.documentElement).getPropertyValue('--pre-text').trim() || getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || (isDark ? '#E2E8F0' : '#1A1610');
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || (isDark ? '#C0C0C0' : '#5C5344');
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-text').trim() || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || (isDark ? '#FFD700' : '#8B6508');
  const error = getComputedStyle(document.documentElement).getPropertyValue('--error').trim() || (isDark ? '#EF5350' : '#C62828');
  const success = getComputedStyle(document.documentElement).getPropertyValue('--success').trim() || (isDark ? '#4CAF50' : '#3D8B40');
  const warning = getComputedStyle(document.documentElement).getPropertyValue('--warning').trim() || (isDark ? '#FFA726' : '#E68A00');
  const info = getComputedStyle(document.documentElement).getPropertyValue('--info').trim() || (isDark ? '#4DD0E1' : '#0288A8');
  return {
    background,
    foreground,
    cursor: accent,
    selectionBackground: getComputedStyle(document.documentElement).getPropertyValue('--accent-bg-strong').trim() || (isDark ? 'rgba(255,215,0,.18)' : 'rgba(184,134,11,.18)'),
    black: isDark ? '#0D0D1A' : '#1A1610',
    red: error,
    green: success,
    yellow: warning,
    blue: info,
    magenta: accent,
    cyan: info,
    white: foreground,
    brightBlack: muted,
    brightRed: error,
    brightGreen: success,
    brightYellow: accent,
    brightBlue: info,
    brightMagenta: accent,
    brightCyan: info,
    brightWhite: isDark ? '#FFFFFF' : '#0F0D08',
  };
}

function _xtermReadyForPage() {
  return typeof window.Terminal === 'function';
}

function _ensureXtermPage() {
  const { surface } = _terminalPageEls();
  if (!surface) return null;
  if (TERMINAL_PAGE.term) return TERMINAL_PAGE.term;
  if (!_xtermReadyForPage()) {
    surface.textContent = 'Terminal library failed to load. Check network access to cdn.jsdelivr.net.';
    return null;
  }

  const term = new window.Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    scrollback: 1000,
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
  TERMINAL_PAGE.isOpen = true;

  term.onData(data => {
    if (TERMINAL_PAGE.ws && TERMINAL_PAGE.ws.readyState === WebSocket.OPEN) {
      TERMINAL_PAGE.ws.send(JSON.stringify({ type: 'input', data }));
    }
    _trackTerminalPageInput(data);
  });

  if (fitAddon) {
    try {
      fitAddon.fit();
    } catch (e) {
      console.warn('xterm fit failed:', e);
    }
  }

  _setupTerminalPageResize();
  return term;
}

function _trackTerminalPageInput(data) {
  if (data === '\r' || data === '\n') {
    TERMINAL_PAGE.typedLine = '';
    return;
  }
  if (data === '') {
    TERMINAL_PAGE.typedLine = '';
    return;
  }
  if (data === '' || data === '\b') {
    TERMINAL_PAGE.typedLine = TERMINAL_PAGE.typedLine.slice(0, -1);
    return;
  }
  if (data.length === 1 && data >= ' ') {
    TERMINAL_PAGE.typedLine += data;
  } else if (data.length > 1 && /^[\x20-\x7e]+$/.test(data)) {
    TERMINAL_PAGE.typedLine += data;
  }
}

function _setupTerminalPageResize() {
  if (TERMINAL_PAGE.resizeObserver) return;
  const { viewport } = _terminalPageEls();
  if (!viewport) return;

  TERMINAL_PAGE.resizeObserver = new ResizeObserver(() => {
    if (TERMINAL_PAGE.fitAddon && TERMINAL_PAGE.term) {
      try {
        TERMINAL_PAGE.fitAddon.fit();
      } catch (e) {
        console.warn('Terminal page fit failed:', e);
      }
    }
  });
  TERMINAL_PAGE.resizeObserver.observe(viewport);
}

async function initTerminalPage() {
  TERMINAL_PAGE.sessionId = S.session ? S.session.session_id : null;
  TERMINAL_PAGE.workspace = S.session ? S.session.workspace : null;

  _ensureXtermPage();

  if (!TERMINAL_PAGE.sessionId) {
    if (TERMINAL_PAGE.term) {
      TERMINAL_PAGE.term.write('\r\nNo active session. Please start a chat conversation first.\r\n');
    }
    return;
  }

  _connectTerminalPage();
}

function _connectTerminalPage() {
  if (TERMINAL_PAGE.ws && TERMINAL_PAGE.ws.readyState === WebSocket.OPEN) {
    return;
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${window.location.host}/api/pty?session_id=${encodeURIComponent(TERMINAL_PAGE.sessionId)}`;

  try {
    TERMINAL_PAGE.ws = new WebSocket(wsUrl);

    TERMINAL_PAGE.ws.onopen = () => {
      if (TERMINAL_PAGE.term) {
        TERMINAL_PAGE.term.write('\r\n[Connected to terminal]\r\n');
      }
    };

    TERMINAL_PAGE.ws.onmessage = (event) => {
      if (!TERMINAL_PAGE.term) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output' && msg.data) {
          TERMINAL_PAGE.term.write(msg.data);
        }
      } catch (e) {
        TERMINAL_PAGE.term.write(event.data);
      }
    };

    TERMINAL_PAGE.ws.onerror = (err) => {
      if (TERMINAL_PAGE.term) {
        TERMINAL_PAGE.term.write('\r\n[Terminal connection error]\r\n');
      }
      console.error('Terminal page WebSocket error:', err);
    };

    TERMINAL_PAGE.ws.onclose = () => {
      if (TERMINAL_PAGE.term) {
        TERMINAL_PAGE.term.write('\r\n[Terminal connection closed]\r\n');
      }
    };
  } catch (e) {
    if (TERMINAL_PAGE.term) {
      TERMINAL_PAGE.term.write(`\r\n[Failed to connect: ${e.message}]\r\n`);
    }
    console.error('Terminal page connection failed:', e);
  }
}

function switchTerminalPageWorkspace() {
  const { workspaceSelect } = _terminalPageEls();
  if (workspaceSelect) {
    TERMINAL_PAGE.workspace = workspaceSelect.value;
  }
  // Reconnect with new workspace
  if (TERMINAL_PAGE.ws) {
    TERMINAL_PAGE.ws.close();
    TERMINAL_PAGE.ws = null;
  }
  _connectTerminalPage();
}

function clearTerminalPage() {
  if (TERMINAL_PAGE.term) {
    TERMINAL_PAGE.term.clear();
  }
}

function copyTerminalPageOutput() {
  if (!TERMINAL_PAGE.term) return;
  try {
    const buffer = TERMINAL_PAGE.term.getSelectionData ? TERMINAL_PAGE.term.getSelectionData() : TERMINAL_PAGE.term.buffer.active.getLine(0);
    if (buffer) {
      const text = TERMINAL_PAGE.term.buffer.active.getLine(0);
      if (text) {
        navigator.clipboard.writeText(text).catch(err => {
          console.error('Copy failed:', err);
        });
      }
    }
  } catch (e) {
    console.error('Failed to copy terminal output:', e);
  }
}

function syncTerminalPageTheme() {
  if (TERMINAL_PAGE.term) {
    TERMINAL_PAGE.term.options.theme = _terminalPageTheme();
  }
}

// Self-initialize: watch for panelTerminal becoming active instead of
// requiring panels.js to call initTerminalPage() explicitly. This keeps
// terminal-page.js self-contained and avoids modifying panels.js logic.
(function _watchTerminalPanel() {
  function _isTerminalActive() {
    const el = document.getElementById('panelTerminal');
    return el && el.classList.contains('active');
  }

  let _initialized = false;
  const _observer = new MutationObserver(() => {
    if (_isTerminalActive() && !_initialized) {
      _initialized = true;
      initTerminalPage();
    } else if (!_isTerminalActive()) {
      _initialized = false;
    }
  });

  function _startWatching() {
    const panel = document.getElementById('panelTerminal');
    if (panel) {
      _observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        const p = document.getElementById('panelTerminal');
        if (p) _observer.observe(p, { attributes: true, attributeFilter: ['class'] });
      }, { once: true });
    }
  }

  _startWatching();
})();
