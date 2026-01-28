import { useState, useEffect, useRef } from 'react';

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

export function useWebSocket() {
  const [ws, setWs] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef(null);
  const currentClientRef = useRef(getSelectedClientId());

  useEffect(() => {
    connect();

    // Listen for cluster client changes
    const handleClientChange = (event) => {
      const newClientId = event.detail?.clientId || 'local';
      if (newClientId !== currentClientRef.current) {
        console.log('[WebSocket] Client changed, reconnecting...', newClientId);
        currentClientRef.current = newClientId;
        // Close current connection and reconnect
        if (ws) {
          ws.close();
        }
        connect();
      }
    };

    window.addEventListener('cluster-client-changed', handleClientChange);

    return () => {
      window.removeEventListener('cluster-client-changed', handleClientChange);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (ws) {
        ws.close();
      }
    };
  }, []); // Keep dependency array but add proper cleanup

  const connect = async () => {
    try {
      const isPlatform = import.meta.env.VITE_IS_PLATFORM === 'true';
      const selectedClient = getSelectedClientId();

      // Construct WebSocket URL
      let wsUrl;

      if (isCapacitor()) {
        // Capacitor mode: Connect to remote server
        const token = localStorage.getItem('auth-token');
        wsUrl = `wss://${REMOTE_SERVER}/ws`;
        if (token) {
          wsUrl += `?token=${encodeURIComponent(token)}`;
        }
        // Add slave parameter if not local
        if (selectedClient && selectedClient !== 'local') {
          wsUrl += `${wsUrl.includes('?') ? '&' : '?'}_slave=${encodeURIComponent(selectedClient)}`;
        }
      } else if (isPlatform) {
        // Platform mode: Use same domain as the page (goes through proxy)
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${protocol}//${window.location.host}/ws`;
        // Add slave parameter if not local
        if (selectedClient && selectedClient !== 'local') {
          wsUrl += `?_slave=${encodeURIComponent(selectedClient)}`;
        }
      } else {
        // OSS mode: Connect to same host:port that served the page
        const token = localStorage.getItem('auth-token');
        if (!token) {
          console.warn('No authentication token found for WebSocket connection');
          return;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
        // Add slave parameter if not local
        if (selectedClient && selectedClient !== 'local') {
          wsUrl += `&_slave=${encodeURIComponent(selectedClient)}`;
        }
      }

      const websocket = new WebSocket(wsUrl);

      websocket.onopen = () => {
        setIsConnected(true);
        setWs(websocket);
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setMessages(prev => [...prev, data]);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        setIsConnected(false);
        setWs(null);

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  };

  const sendMessage = (message) => {
    if (ws && isConnected) {
      ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  };

  return {
    ws,
    sendMessage,
    messages,
    isConnected
  };
}
