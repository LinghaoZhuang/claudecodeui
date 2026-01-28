/**
 * TunnelClient - Slave mode tunnel client
 *
 * Connects to master server and handles:
 * - WebSocket tunnel establishment and reconnection
 * - HTTP request forwarding to local services
 * - WebSocket tunnel multiplexing
 */

import WebSocket from 'ws';
import http from 'http';
import { randomUUID } from 'crypto';

class TunnelClient {
  constructor(options = {}) {
    this.masterUrl = options.masterUrl || process.env.MASTER_URL;
    this.slaveId = options.slaveId || process.env.SLAVE_ID;
    this.slaveName = options.slaveName || process.env.SLAVE_NAME || this.slaveId;
    this.secret = options.secret || process.env.CLUSTER_SECRET;
    this.localPort = options.localPort || process.env.PORT || 3001;

    // Reconnection settings
    this.baseDelay = options.baseDelay || 5000; // 5 seconds
    this.maxDelay = options.maxDelay || 60000; // 60 seconds
    this.reconnectAttempts = 0;

    this.ws = null;
    this.authenticated = false;
    this.reconnectTimer = null;
    this.pingInterval = null;

    // Map of tunnelId -> local WebSocket connection
    this.localTunnels = new Map();
  }

  /**
   * Start the tunnel client
   */
  start() {
    if (!this.masterUrl || !this.slaveId || !this.secret) {
      console.error('[TunnelClient] Missing required configuration: MASTER_URL, SLAVE_ID, CLUSTER_SECRET');
      return;
    }

    console.log(`[TunnelClient] Starting tunnel client: ${this.slaveId} (${this.slaveName})`);
    console.log(`[TunnelClient] Connecting to master: ${this.masterUrl}`);

    this.connect();
  }

  /**
   * Connect to master server
   */
  connect() {
    try {
      // Build tunnel URL
      const tunnelUrl = this.masterUrl.replace(/\/?$/, '/cluster/tunnel');

      this.ws = new WebSocket(tunnelUrl);

      this.ws.on('open', () => {
        console.log('[TunnelClient] Connected to master, authenticating...');
        this.authenticate();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          console.error('[TunnelClient] Error parsing message:', error);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[TunnelClient] Disconnected from master: ${code} ${reason}`);
        this.authenticated = false;
        this.stopPing();
        this.cleanupTunnels();
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('[TunnelClient] WebSocket error:', error.message);
      });

    } catch (error) {
      console.error('[TunnelClient] Connection error:', error);
      this.scheduleReconnect();
    }
  }

  /**
   * Send authentication message to master
   */
  authenticate() {
    this.send({
      type: 'auth',
      slaveId: this.slaveId,
      slaveName: this.slaveName,
      secret: this.secret
    });
  }

  /**
   * Handle message from master
   */
  handleMessage(message) {
    switch (message.type) {
      case 'auth_success':
        this.handleAuthSuccess(message);
        break;

      case 'http_request':
        this.handleHttpRequest(message);
        break;

      case 'ws_tunnel_open':
        this.handleWsTunnelOpen(message);
        break;

      case 'ws_message':
        this.handleWsMessage(message);
        break;

      case 'ws_tunnel_close':
        this.handleWsTunnelClose(message);
        break;

      case 'pong':
        // Pong received, connection is alive
        break;

      default:
        console.log('[TunnelClient] Unknown message type:', message.type);
    }
  }

  /**
   * Handle successful authentication
   */
  handleAuthSuccess(message) {
    console.log(`[TunnelClient] Authentication successful: ${message.slaveId}`);
    this.authenticated = true;
    this.reconnectAttempts = 0;
    this.startPing();
  }

  /**
   * Handle HTTP request forwarding
   */
  async handleHttpRequest(message) {
    const { requestId, method, path, headers, body } = message;

    try {
      const response = await this.forwardToLocal(method, path, headers, body);

      this.send({
        type: 'response',
        requestId,
        status: response.status,
        headers: response.headers,
        body: response.body
      });
    } catch (error) {
      console.error('[TunnelClient] Error forwarding request:', error.message);

      this.send({
        type: 'response',
        requestId,
        error: error.message
      });
    }
  }

  /**
   * Forward HTTP request to local service
   */
  forwardToLocal(method, path, headers, body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: this.localPort,
        path,
        method,
        headers: {
          ...headers,
          // Ensure host header points to local
          host: `localhost:${this.localPort}`,
          // Add cluster internal auth header - slave auth middleware will trust this
          'x-cluster-internal-auth': this.secret
        }
      };

      const req = http.request(options, (res) => {
        const chunks = [];

        res.on('data', (chunk) => chunks.push(chunk));

        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8');

          // Convert headers to plain object
          const responseHeaders = {};
          for (const [key, value] of Object.entries(res.headers)) {
            responseHeaders[key] = value;
          }

          resolve({
            status: res.statusCode,
            headers: responseHeaders,
            body: responseBody
          });
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      // Set timeout
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }

  /**
   * Handle WebSocket tunnel open request
   */
  handleWsTunnelOpen(message) {
    const { tunnelId, channel, token } = message;

    try {
      // Determine local WebSocket path based on channel
      const wsPath = channel === 'shell' ? '/shell' : '/ws';
      // Include token in the WebSocket URL for authentication
      const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
      const localWsUrl = `ws://localhost:${this.localPort}${wsPath}${tokenParam}`;

      const localWs = new WebSocket(localWsUrl);

      localWs.on('open', () => {
        console.log(`[TunnelClient] Local WebSocket tunnel opened: ${tunnelId} (${channel})`);
        this.localTunnels.set(tunnelId, localWs);
      });

      localWs.on('message', (data) => {
        this.send({
          type: 'ws_data',
          tunnelId,
          data: data.toString()
        });
      });

      localWs.on('close', () => {
        console.log(`[TunnelClient] Local WebSocket tunnel closed: ${tunnelId}`);
        this.localTunnels.delete(tunnelId);

        this.send({
          type: 'ws_tunnel_closed',
          tunnelId
        });
      });

      localWs.on('error', (error) => {
        console.error(`[TunnelClient] Local WebSocket error for tunnel ${tunnelId}:`, error.message);
      });

    } catch (error) {
      console.error(`[TunnelClient] Error opening tunnel ${tunnelId}:`, error.message);

      this.send({
        type: 'error',
        tunnelId,
        error: error.message
      });
    }
  }

  /**
   * Handle WebSocket message from master
   */
  handleWsMessage(message) {
    const { tunnelId, data } = message;
    const localWs = this.localTunnels.get(tunnelId);

    if (localWs && localWs.readyState === WebSocket.OPEN) {
      localWs.send(data);
    }
  }

  /**
   * Handle WebSocket tunnel close request
   */
  handleWsTunnelClose(message) {
    const { tunnelId } = message;
    const localWs = this.localTunnels.get(tunnelId);

    if (localWs) {
      localWs.close();
      this.localTunnels.delete(tunnelId);
    }
  }

  /**
   * Send message to master
   */
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Calculate delay with exponential backoff and jitter
    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.reconnectAttempts),
      this.maxDelay
    );
    const jitter = Math.random() * 1000; // 0-1 second jitter
    const totalDelay = delay + jitter;

    this.reconnectAttempts++;

    console.log(`[TunnelClient] Reconnecting in ${Math.round(totalDelay / 1000)}s (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, totalDelay);
  }

  /**
   * Start ping interval
   */
  startPing() {
    this.stopPing();

    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({
          type: 'ping',
          timestamp: Date.now()
        });
      }
    }, 30000); // Ping every 30 seconds
  }

  /**
   * Stop ping interval
   */
  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Cleanup all local tunnels
   */
  cleanupTunnels() {
    for (const [tunnelId, ws] of this.localTunnels.entries()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    this.localTunnels.clear();
  }

  /**
   * Stop the tunnel client
   */
  stop() {
    console.log('[TunnelClient] Stopping tunnel client');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopPing();
    this.cleanupTunnels();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.authenticated = false;
  }

  /**
   * Check if connected and authenticated
   */
  isConnected() {
    return this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.authenticated;
  }
}

export default TunnelClient;
