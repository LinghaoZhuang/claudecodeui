/**
 * TunnelManager - Master mode tunnel management
 *
 * Manages WebSocket tunnels from slave clients, enabling:
 * - Slave authentication and registration
 * - HTTP request forwarding through tunnels
 * - WebSocket tunnel multiplexing
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';

class TunnelManager {
  constructor(options = {}) {
    this.secret = options.secret || process.env.CLUSTER_SECRET;
    this.authTimeout = options.authTimeout || 10000; // 10 seconds

    // Map of slaveId -> { ws, name, connectedAt, lastPing, authenticated }
    this.slaves = new Map();

    // Map of requestId -> { resolve, reject, timeout }
    this.pendingRequests = new Map();

    // Map of tunnelId -> { slaveId, localWs }
    this.tunnels = new Map();

    // Request timeout (30 seconds)
    this.requestTimeout = options.requestTimeout || 30000;
  }

  /**
   * Handle new WebSocket connection from potential slave
   */
  handleConnection(ws, request) {
    console.log('[TunnelManager] New connection attempt');

    let authenticated = false;
    let slaveId = null;

    // Set authentication timeout
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        console.log('[TunnelManager] Authentication timeout, closing connection');
        ws.close(4001, 'Authentication timeout');
      }
    }, this.authTimeout);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (!authenticated) {
          // Expect auth message first
          if (message.type === 'auth') {
            this.handleAuth(ws, message, authTimer)
              .then((id) => {
                authenticated = true;
                slaveId = id;
              })
              .catch((err) => {
                console.error('[TunnelManager] Auth failed:', err.message);
                ws.close(4002, 'Authentication failed');
              });
          } else {
            ws.close(4003, 'Expected auth message');
          }
        } else {
          // Handle messages from authenticated slave
          this.handleSlaveMessage(slaveId, message);
        }
      } catch (error) {
        console.error('[TunnelManager] Error parsing message:', error);
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (slaveId && this.slaves.has(slaveId)) {
        console.log(`[TunnelManager] Slave disconnected: ${slaveId}`);
        this.slaves.delete(slaveId);

        // Clean up any tunnels for this slave
        for (const [tunnelId, tunnel] of this.tunnels.entries()) {
          if (tunnel.slaveId === slaveId) {
            if (tunnel.localWs && tunnel.localWs.readyState === WebSocket.OPEN) {
              tunnel.localWs.close();
            }
            this.tunnels.delete(tunnelId);
          }
        }
      }
    });

    ws.on('error', (error) => {
      console.error('[TunnelManager] WebSocket error:', error);
    });
  }

  /**
   * Handle authentication message from slave
   */
  async handleAuth(ws, message, authTimer) {
    const { slaveId, slaveName, secret } = message;

    if (!slaveId || !secret) {
      throw new Error('Missing slaveId or secret');
    }

    if (secret !== this.secret) {
      throw new Error('Invalid secret');
    }

    // Check if slave already connected
    if (this.slaves.has(slaveId)) {
      const existing = this.slaves.get(slaveId);
      if (existing.ws.readyState === WebSocket.OPEN) {
        console.log(`[TunnelManager] Replacing existing connection for slave: ${slaveId}`);
        existing.ws.close(4004, 'Replaced by new connection');
      }
    }

    clearTimeout(authTimer);

    // Register the slave
    this.slaves.set(slaveId, {
      ws,
      name: slaveName || slaveId,
      connectedAt: new Date(),
      lastPing: new Date(),
      authenticated: true
    });

    console.log(`[TunnelManager] Slave authenticated: ${slaveId} (${slaveName || slaveId})`);

    // Send auth success response
    ws.send(JSON.stringify({
      type: 'auth_success',
      slaveId
    }));

    return slaveId;
  }

  /**
   * Handle message from authenticated slave
   */
  handleSlaveMessage(slaveId, message) {
    switch (message.type) {
      case 'response':
        this.handleHttpResponse(message);
        break;

      case 'ws_data':
        this.handleWsTunnelData(message);
        break;

      case 'ws_tunnel_closed':
        this.handleWsTunnelClosed(message);
        break;

      case 'ping':
        this.handlePing(slaveId, message);
        break;

      case 'error':
        this.handleSlaveError(slaveId, message);
        break;

      default:
        console.log(`[TunnelManager] Unknown message type from ${slaveId}:`, message.type);
    }
  }

  /**
   * Handle HTTP response from slave
   */
  handleHttpResponse(message) {
    const { requestId, status, headers, body, error } = message;
    const pending = this.pendingRequests.get(requestId);

    if (!pending) {
      console.warn(`[TunnelManager] No pending request for ${requestId}`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);

    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve({ status, headers, body });
    }
  }

  /**
   * Handle WebSocket tunnel data from slave
   */
  handleWsTunnelData(message) {
    const { tunnelId, data } = message;
    const tunnel = this.tunnels.get(tunnelId);

    if (!tunnel) {
      console.warn(`[TunnelManager] No tunnel found for ${tunnelId}`);
      return;
    }

    if (tunnel.localWs && tunnel.localWs.readyState === WebSocket.OPEN) {
      tunnel.localWs.send(data);
    }
  }

  /**
   * Handle WebSocket tunnel close from slave
   */
  handleWsTunnelClosed(message) {
    const { tunnelId } = message;
    const tunnel = this.tunnels.get(tunnelId);

    if (tunnel) {
      if (tunnel.localWs && tunnel.localWs.readyState === WebSocket.OPEN) {
        tunnel.localWs.close();
      }
      this.tunnels.delete(tunnelId);
    }
  }

  /**
   * Handle ping from slave
   */
  handlePing(slaveId, message) {
    const slave = this.slaves.get(slaveId);
    if (slave) {
      slave.lastPing = new Date();
      slave.ws.send(JSON.stringify({ type: 'pong', timestamp: message.timestamp }));
    }
  }

  /**
   * Handle error from slave
   */
  handleSlaveError(slaveId, message) {
    console.error(`[TunnelManager] Error from slave ${slaveId}:`, message.error);

    if (message.requestId) {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.requestId);
        pending.reject(new Error(message.error || 'Slave error'));
      }
    }
  }

  /**
   * Forward HTTP request to slave
   */
  async forwardHttpRequest(slaveId, request) {
    const slave = this.slaves.get(slaveId);

    if (!slave || slave.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Slave ${slaveId} not connected`);
    }

    const requestId = randomUUID();

    // Collect request body
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks).toString('utf-8');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, this.requestTimeout);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      // Send request to slave
      slave.ws.send(JSON.stringify({
        type: 'http_request',
        requestId,
        method: request.method,
        path: request.url,
        headers: this.sanitizeHeaders(request.headers),
        body
      }));
    });
  }

  /**
   * Create WebSocket tunnel to slave
   * @param {string} slaveId - Target slave ID
   * @param {WebSocket} localWs - Local WebSocket connection from user
   * @param {string} channel - Channel type ('ws' or 'shell')
   * @param {string} token - User's JWT token for authentication on slave
   */
  createWsTunnel(slaveId, localWs, channel, token) {
    const slave = this.slaves.get(slaveId);

    if (!slave || slave.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Slave ${slaveId} not connected`);
    }

    const tunnelId = randomUUID();

    // Store tunnel mapping
    this.tunnels.set(tunnelId, {
      slaveId,
      localWs,
      channel
    });

    // Request tunnel creation on slave with token for authentication
    slave.ws.send(JSON.stringify({
      type: 'ws_tunnel_open',
      tunnelId,
      channel,
      token  // Pass user's JWT token to slave
    }));

    // Handle messages from local WebSocket
    localWs.on('message', (data) => {
      if (slave.ws.readyState === WebSocket.OPEN) {
        slave.ws.send(JSON.stringify({
          type: 'ws_message',
          tunnelId,
          data: data.toString()
        }));
      }
    });

    // Handle local WebSocket close
    localWs.on('close', () => {
      if (slave.ws.readyState === WebSocket.OPEN) {
        slave.ws.send(JSON.stringify({
          type: 'ws_tunnel_close',
          tunnelId
        }));
      }
      this.tunnels.delete(tunnelId);
    });

    return tunnelId;
  }

  /**
   * Get list of connected slaves
   */
  getSlaves() {
    const slaves = [];
    for (const [id, slave] of this.slaves.entries()) {
      slaves.push({
        id,
        name: slave.name,
        connectedAt: slave.connectedAt,
        lastPing: slave.lastPing,
        status: slave.ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected'
      });
    }
    return slaves;
  }

  /**
   * Get single slave info
   */
  getSlave(slaveId) {
    const slave = this.slaves.get(slaveId);
    if (!slave) return null;

    return {
      id: slaveId,
      name: slave.name,
      connectedAt: slave.connectedAt,
      lastPing: slave.lastPing,
      status: slave.ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected'
    };
  }

  /**
   * Check if slave is connected
   */
  isSlaveConnected(slaveId) {
    const slave = this.slaves.get(slaveId);
    return slave && slave.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Sanitize headers for forwarding
   */
  sanitizeHeaders(headers) {
    const sanitized = { ...headers };

    // Remove hop-by-hop headers
    delete sanitized['connection'];
    delete sanitized['keep-alive'];
    delete sanitized['proxy-authenticate'];
    delete sanitized['proxy-authorization'];
    delete sanitized['te'];
    delete sanitized['trailers'];
    delete sanitized['transfer-encoding'];
    delete sanitized['upgrade'];

    // Remove our custom header
    delete sanitized['x-target-slave'];

    return sanitized;
  }
}

export default TunnelManager;
