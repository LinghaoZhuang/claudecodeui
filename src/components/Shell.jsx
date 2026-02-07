import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from 'react-i18next';
import { IS_PLATFORM } from '../constants/config';

// Remote server for Capacitor environment
const REMOTE_SERVER = 'code.zaneleo.top';

// Storage key for selected cluster client
const SELECTED_CLIENT_KEY = 'cluster-selected-client';

// Check if running in Capacitor environment
const isCapacitor = () => {
  return typeof window !== 'undefined' && window.Capacitor !== undefined;
};

// Get selected cluster client ID
const getSelectedClientId = () => {
  try {
    return localStorage.getItem(SELECTED_CLIENT_KEY) || 'local';
  } catch {
    return 'local';
  }
};

const xtermStyles = `
  .xterm .xterm-screen {
    outline: none !important;
  }
  .xterm:focus .xterm-screen {
    outline: none !important;
  }
  .xterm-screen:focus {
    outline: none !important;
  }
`;

if (typeof document !== 'undefined') {
  const styleSheet = document.createElement('style');
  styleSheet.type = 'text/css';
  styleSheet.innerText = xtermStyles;
  document.head.appendChild(styleSheet);
}

function Shell({ selectedProject, selectedSession, initialCommand, isPlainShell = false, onProcessComplete, minimal = false, autoConnect = false }) {
  const { t } = useTranslation('chat');
  const terminalRef = useRef(null);
  const terminal = useRef(null);
  const fitAddon = useRef(null);
  const ws = useRef(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isKeepAlive, setIsKeepAlive] = useState(false);
  const [tmuxSession, setTmuxSession] = useState(null);
  const [attachCommand, setAttachCommand] = useState(null);
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const actionsMenuRef = useRef(null);
  const isConnectingRef = useRef(false);
  const isConnectedRef = useRef(false);
  const forceResizeRef = useRef(false);  // Force resize PTY on reconnect

  const selectedProjectRef = useRef(selectedProject);
  const selectedSessionRef = useRef(selectedSession);
  const initialCommandRef = useRef(initialCommand);
  const isPlainShellRef = useRef(isPlainShell);
  const onProcessCompleteRef = useRef(onProcessComplete);

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
    selectedSessionRef.current = selectedSession;
    initialCommandRef.current = initialCommand;
    isPlainShellRef.current = isPlainShell;
    onProcessCompleteRef.current = onProcessComplete;
  });

  const connectWebSocket = useCallback(async () => {
    if (isConnectedRef.current) return;

    try {
      const selectedClient = getSelectedClientId();
      let wsUrl;

      if (isCapacitor()) {
        // Capacitor mode: Connect to remote server
        const token = localStorage.getItem('auth-token');
        wsUrl = `wss://${REMOTE_SERVER}/shell`;
        if (token) {
          wsUrl += `?token=${encodeURIComponent(token)}`;
        }
        // Add slave parameter if not local
        if (selectedClient && selectedClient !== 'local') {
          wsUrl += `${wsUrl.includes('?') ? '&' : '?'}_slave=${encodeURIComponent(selectedClient)}`;
        }
      } else if (IS_PLATFORM) {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${protocol}//${window.location.host}/shell`;
        // Add slave parameter if not local
        if (selectedClient && selectedClient !== 'local') {
          wsUrl += `?_slave=${encodeURIComponent(selectedClient)}`;
        }
      } else {
        const token = localStorage.getItem('auth-token');
        if (!token) {
          console.error('No authentication token found for Shell WebSocket connection');
          return;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${protocol}//${window.location.host}/shell?token=${encodeURIComponent(token)}`;
        // Add slave parameter if not local
        if (selectedClient && selectedClient !== 'local') {
          wsUrl += `&_slave=${encodeURIComponent(selectedClient)}`;
        }
      }

      ws.current = new WebSocket(wsUrl);

      ws.current.onopen = () => {
        isConnectedRef.current = true;
        isConnectingRef.current = false;
        setIsConnected(true);
        setIsConnecting(false);

        setTimeout(() => {
          if (fitAddon.current && terminal.current) {
            const el = terminalRef.current;
            if (el && el.offsetWidth >= 100 && el.offsetHeight >= 50) {
              fitAddon.current.fit();
            }

            ws.current.send(JSON.stringify({
              type: 'init',
              projectPath: selectedProjectRef.current.fullPath || selectedProjectRef.current.path,
              sessionId: isPlainShellRef.current ? null : selectedSessionRef.current?.id,
              hasSession: isPlainShellRef.current ? false : !!selectedSessionRef.current,
              provider: isPlainShellRef.current ? 'plain-shell' : (selectedSessionRef.current?.__provider || 'claude'),
              cols: terminal.current.cols,
              rows: terminal.current.rows,
              initialCommand: initialCommandRef.current,
              isPlainShell: isPlainShellRef.current,
              forceResize: forceResizeRef.current  // Force PTY resize to this client's dimensions
            }));

            // Reset forceResize flag after sending
            forceResizeRef.current = false;
          }
        }, 100);
      };

      ws.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'output') {
            let output = data.data;

            if (isPlainShellRef.current && onProcessCompleteRef.current) {
              const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, '');
              if (cleanOutput.includes('Process exited with code 0')) {
                onProcessCompleteRef.current(0);
              } else if (cleanOutput.match(/Process exited with code (\d+)/)) {
                const exitCode = parseInt(cleanOutput.match(/Process exited with code (\d+)/)[1]);
                if (exitCode !== 0) {
                  onProcessCompleteRef.current(exitCode);
                }
              }
            }

            if (terminal.current) {
              terminal.current.write(output);
            }
          } else if (data.type === 'url_open') {
            window.open(data.url, '_blank');
          } else if (data.type === 'session_info') {
            setIsKeepAlive(data.keepAlive || false);
            setTmuxSession(data.tmuxSession || null);
            setAttachCommand(data.attachCommand || null);
          }
        } catch (error) {
          console.error('[Shell] Error handling WebSocket message:', error, event.data);
        }
      };

      ws.current.onclose = (event) => {
        isConnectedRef.current = false;
        isConnectingRef.current = false;
        setIsConnected(false);
        setIsConnecting(false);

        if (terminal.current) {
          terminal.current.clear();
          terminal.current.write('\x1b[2J\x1b[H');
        }
      };

      ws.current.onerror = (error) => {
        isConnectedRef.current = false;
        isConnectingRef.current = false;
        setIsConnected(false);
        setIsConnecting(false);
      };
    } catch (error) {
      isConnectedRef.current = false;
      isConnectingRef.current = false;
      setIsConnected(false);
      setIsConnecting(false);
    }
  }, []);

  const connectToShell = useCallback(() => {
    if (!isInitialized || isConnectedRef.current || isConnectingRef.current) return;
    isConnectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket();
  }, [isInitialized, connectWebSocket]);

  const disconnectFromShell = useCallback(() => {
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }

    if (terminal.current) {
      terminal.current.clear();
      terminal.current.write('\x1b[2J\x1b[H');
    }

    setIsConnected(false);
    setIsConnecting(false);
  }, []);

  // Reconnect and sync resolution to this client's dimensions
  const reconnectShell = useCallback(() => {
    forceResizeRef.current = true;  // Force resize on reconnect

    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }

    if (terminal.current) {
      terminal.current.clear();
      terminal.current.write('\x1b[2J\x1b[H');
    }

    setIsConnected(false);
    setIsConnecting(false);

    // Auto reconnect after a short delay
    setTimeout(() => {
      connectWebSocket();
    }, 100);
  }, [connectWebSocket]);

  const sessionDisplayName = useMemo(() => {
    if (!selectedSession) return null;
    return selectedSession.__provider === 'cursor'
      ? (selectedSession.name || 'Untitled Session')
      : (selectedSession.summary || 'New Session');
  }, [selectedSession]);

  const sessionDisplayNameShort = useMemo(() => {
    if (!sessionDisplayName) return null;
    return sessionDisplayName.slice(0, 30);
  }, [sessionDisplayName]);

  const sessionDisplayNameLong = useMemo(() => {
    if (!sessionDisplayName) return null;
    return sessionDisplayName.slice(0, 50);
  }, [sessionDisplayName]);

  const restartShell = () => {
    setIsRestarting(true);

    // Send kill command to server to actually kill the PTY process
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({
        type: 'kill'
      }));
    }

    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }

    if (terminal.current) {
      terminal.current.dispose();
      terminal.current = null;
      fitAddon.current = null;
    }

    setIsConnected(false);
    setIsInitialized(false);
    setIsKeepAlive(false);
    setTmuxSession(null);
    setAttachCommand(null);

    setTimeout(() => {
      setIsRestarting(false);
    }, 200);
  };

  const toggleKeepAlive = () => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({
        type: 'keepalive',
        enabled: !isKeepAlive
      }));
    }
  };

  const [copySuccess, setCopySuccess] = useState(false);
  const copyAttachCommand = () => {
    if (attachCommand) {
      navigator.clipboard.writeText(attachCommand).then(() => {
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 1500);
      }).catch(() => {});
    }
  };

  // Close actions menu when clicking outside
  useEffect(() => {
    if (!showActionsMenu) return;
    const handleClick = (e) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target)) {
        setShowActionsMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('touchstart', handleClick);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('touchstart', handleClick);
    };
  }, [showActionsMenu]);

  // Terminal connection persists across session/project changes
  // User can manually restart if needed

  useEffect(() => {
    if (!terminalRef.current || !selectedProject || isRestarting || terminal.current) {
      return;
    }


    terminal.current = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      allowProposedApi: true,
      allowTransparency: false,
      convertEol: true,
      scrollback: 10000,
      tabStopWidth: 4,
      windowsMode: false,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
        cursorAccent: '#1e1e1e',
        selection: '#264f78',
        selectionForeground: '#ffffff',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#ffffff',
        extendedAnsi: [
          '#000000', '#800000', '#008000', '#808000',
          '#000080', '#800080', '#008080', '#c0c0c0',
          '#808080', '#ff0000', '#00ff00', '#ffff00',
          '#0000ff', '#ff00ff', '#00ffff', '#ffffff'
        ]
      }
    });

    fitAddon.current = new FitAddon();
    const webglAddon = new WebglAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.current.loadAddon(fitAddon.current);
    terminal.current.loadAddon(webLinksAddon);
    // Note: ClipboardAddon removed - we handle clipboard operations manually in attachCustomKeyEventHandler

    try {
      terminal.current.loadAddon(webglAddon);
    } catch (error) {
      console.warn('[Shell] WebGL renderer unavailable, using Canvas fallback');
    }

    terminal.current.open(terminalRef.current);

    terminal.current.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'c' && terminal.current.hasSelection()) {
        document.execCommand('copy');
        return false;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
        navigator.clipboard.readText().then(text => {
          if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
              type: 'input',
              data: text
            }));
          }
        }).catch(() => {});
        return false;
      }

      return true;
    });

    setTimeout(() => {
      if (fitAddon.current && terminal.current) {
        const el = terminalRef.current;
        if (el && el.offsetWidth >= 100 && el.offsetHeight >= 50) {
          fitAddon.current.fit();
        }
        if (terminal.current && ws.current && ws.current.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({
            type: 'resize',
            cols: terminal.current.cols,
            rows: terminal.current.rows
          }));
        }
      }
    }, 100);

    setIsInitialized(true);
    terminal.current.onData((data) => {
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({
          type: 'input',
          data: data
        }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (fitAddon.current && terminal.current) {
        // Skip resize when terminal container is hidden (e.g., switched to chat tab)
        // This prevents sending tiny dimensions to the shared PTY
        const el = terminalRef.current;
        if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) {
          return;
        }

        // Skip resize if container is too narrow (likely hidden or transitioning)
        if (el.offsetWidth < 100 || el.offsetHeight < 50) {
          return;
        }

        setTimeout(() => {
          if (!fitAddon.current || !terminal.current) return;
          fitAddon.current.fit();
          const cols = terminal.current.cols;
          const rows = terminal.current.rows;

          // Only send resize if dimensions are reasonable
          if (cols > 10 && rows > 2 && ws.current && ws.current.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
              type: 'resize',
              cols,
              rows
            }));
          }
        }, 50);
      }
    });

    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    return () => {
      resizeObserver.disconnect();

      if (ws.current && (ws.current.readyState === WebSocket.OPEN || ws.current.readyState === WebSocket.CONNECTING)) {
        ws.current.close();
      }
      ws.current = null;

      if (terminal.current) {
        terminal.current.dispose();
        terminal.current = null;
      }
    };
  }, [selectedProject?.path || selectedProject?.fullPath, isRestarting]);

  useEffect(() => {
    if (!autoConnect || !isInitialized || isConnectingRef.current || isConnectedRef.current) return;
    connectToShell();
  }, [autoConnect, isInitialized, connectToShell]);

  if (!selectedProject) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-gray-500 dark:text-gray-400">
          <div className="w-16 h-16 mx-auto mb-4 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold mb-2">{t('shell.selectProject.title')}</h3>
          <p>{t('shell.selectProject.description')}</p>
        </div>
      </div>
    );
  }

  if (minimal) {
    return (
      <div className="h-full w-full bg-gray-900">
        <div ref={terminalRef} className="h-full w-full focus:outline-none" style={{ outline: 'none' }} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-900 w-full">
      <div className="flex-shrink-0 bg-gray-800 border-b border-gray-700 px-4 py-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            {selectedSession && (
              <span className="text-xs text-blue-300">
                ({sessionDisplayNameShort}...)
              </span>
            )}
            {!selectedSession && (
              <span className="text-xs text-gray-400">{t('shell.status.newSession')}</span>
            )}
            {!isInitialized && (
              <span className="text-xs text-yellow-400">{t('shell.status.initializing')}</span>
            )}
            {isRestarting && (
              <span className="text-xs text-blue-400">{t('shell.status.restarting')}</span>
            )}
            {tmuxSession && isConnected && (
              <span className="text-xs text-gray-500" title={tmuxSession}>
                [{tmuxSession}]
              </span>
            )}
          </div>
          <div className="flex items-center space-x-3">
            <div className="relative" ref={actionsMenuRef}>
              <button
                onClick={() => setShowActionsMenu(!showActionsMenu)}
                className="px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded flex items-center space-x-1"
              >
                {isKeepAlive && (
                  <svg className="w-3 h-3 text-yellow-400" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                  </svg>
                )}
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                </svg>
              </button>

              {showActionsMenu && (
                <div className="absolute right-0 top-full mt-1 bg-gray-800 border border-gray-600 rounded shadow-lg z-50 min-w-[160px]">
                  {isConnected && (
                    <button
                      onClick={() => { reconnectShell(); setShowActionsMenu(false); }}
                      className="w-full px-3 py-2 text-xs text-left text-gray-300 hover:bg-gray-700 hover:text-white flex items-center space-x-2"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <span>{t('shell.actions.reconnect')}</span>
                    </button>
                  )}

                  {isConnected && (
                    <button
                      onClick={() => { toggleKeepAlive(); setShowActionsMenu(false); }}
                      className={`w-full px-3 py-2 text-xs text-left flex items-center space-x-2 ${isKeepAlive ? 'text-yellow-400 hover:bg-gray-700' : 'text-gray-300 hover:bg-gray-700 hover:text-white'}`}
                    >
                      <svg className="w-3.5 h-3.5" fill={isKeepAlive ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                      </svg>
                      <span>{isKeepAlive ? t('shell.actions.keepAliveOff') : t('shell.actions.keepAlive')}</span>
                    </button>
                  )}

                  {isConnected && attachCommand && (
                    <button
                      onClick={() => { copyAttachCommand(); setShowActionsMenu(false); }}
                      className="w-full px-3 py-2 text-xs text-left text-gray-300 hover:bg-gray-700 hover:text-white flex items-center space-x-2"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                      </svg>
                      <span>{copySuccess ? t('shell.actions.copied') : t('shell.actions.copyAttach')}</span>
                    </button>
                  )}

                  <button
                    onClick={() => { restartShell(); setShowActionsMenu(false); }}
                    disabled={isRestarting}
                    className="w-full px-3 py-2 text-xs text-left text-red-400 hover:bg-gray-700 hover:text-red-300 disabled:opacity-50 flex items-center space-x-2"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    <span>{t('shell.actions.restart')}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 p-2 overflow-hidden relative">
        <div ref={terminalRef} className="h-full w-full focus:outline-none" style={{ outline: 'none' }} />

        {!isInitialized && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-90">
            <div className="text-white">{t('shell.loading')}</div>
          </div>
        )}

        {isInitialized && !isConnected && !isConnecting && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-90 p-4">
            <div className="text-center max-w-sm w-full">
              <button
                onClick={connectToShell}
                className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center justify-center space-x-2 text-base font-medium w-full sm:w-auto"
                title={t('shell.actions.connectTitle')}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <span>{t('shell.actions.connect')}</span>
              </button>
              <p className="text-gray-400 text-sm mt-3 px-2">
                {isPlainShell ?
                  t('shell.runCommand', { command: initialCommand || t('shell.defaultCommand'), projectName: selectedProject.displayName }) :
                  selectedSession ?
                    t('shell.resumeSession', { displayName: sessionDisplayNameLong }) :
                    t('shell.startSession')
                }
              </p>
            </div>
          </div>
        )}

        {isConnecting && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-90 p-4">
            <div className="text-center max-w-sm w-full">
              <div className="flex items-center justify-center space-x-3 text-yellow-400">
                <div className="w-6 h-6 animate-spin rounded-full border-2 border-yellow-400 border-t-transparent"></div>
                <span className="text-base font-medium">{t('shell.connecting')}</span>
              </div>
              <p className="text-gray-400 text-sm mt-3 px-2">
                {isPlainShell ?
                  t('shell.runCommand', { command: initialCommand || t('shell.defaultCommand'), projectName: selectedProject.displayName }) :
                  t('shell.startCli', { projectName: selectedProject.displayName })
                }
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default Shell;