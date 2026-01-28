/**
 * Cluster API Routes
 *
 * Provides endpoints for cluster management:
 * - GET /api/cluster/slaves - list all connected slaves
 * - GET /api/cluster/slaves/:id - get single slave info
 * - GET /api/cluster/slaves/:id/health - health check for slave
 * - GET /api/cluster/status - overall cluster status
 */

import express from 'express';

function createClusterRoutes(tunnelManager) {
  const router = express.Router();

  /**
   * GET /api/cluster/status
   * Get overall cluster status and mode information
   */
  router.get('/status', (req, res) => {
    const deploymentMode = process.env.DEPLOYMENT_MODE || 'standalone';
    const slaves = tunnelManager ? tunnelManager.getSlaves() : [];

    res.json({
      mode: deploymentMode,
      isMaster: deploymentMode === 'master',
      connectedSlaves: slaves.length,
      slaves: slaves.map(s => ({
        id: s.id,
        name: s.name,
        status: s.status
      }))
    });
  });

  /**
   * GET /api/cluster/slaves
   * List all connected slave clients
   */
  router.get('/slaves', (req, res) => {
    if (!tunnelManager) {
      return res.status(400).json({
        error: 'Not in master mode',
        message: 'Cluster slave management is only available in master mode'
      });
    }

    const slaves = tunnelManager.getSlaves();

    // Always include 'local' as the first option
    const clients = [
      {
        id: 'local',
        name: 'Local Server',
        status: 'connected',
        isLocal: true,
        connectedAt: null,
        lastPing: null
      },
      ...slaves.map(s => ({
        ...s,
        isLocal: false
      }))
    ];

    res.json({
      success: true,
      clients
    });
  });

  /**
   * GET /api/cluster/slaves/:id
   * Get single slave information
   */
  router.get('/slaves/:id', (req, res) => {
    const { id } = req.params;

    if (!tunnelManager) {
      return res.status(400).json({
        error: 'Not in master mode'
      });
    }

    // Handle local server request
    if (id === 'local') {
      return res.json({
        success: true,
        client: {
          id: 'local',
          name: 'Local Server',
          status: 'connected',
          isLocal: true
        }
      });
    }

    const slave = tunnelManager.getSlave(id);

    if (!slave) {
      return res.status(404).json({
        error: 'Slave not found',
        slaveId: id
      });
    }

    res.json({
      success: true,
      client: {
        ...slave,
        isLocal: false
      }
    });
  });

  /**
   * GET /api/cluster/slaves/:id/health
   * Health check for a specific slave
   */
  router.get('/slaves/:id/health', async (req, res) => {
    const { id } = req.params;

    if (!tunnelManager) {
      return res.status(400).json({
        error: 'Not in master mode'
      });
    }

    // Handle local server health check
    if (id === 'local') {
      return res.json({
        success: true,
        healthy: true,
        slaveId: 'local',
        message: 'Local server is healthy'
      });
    }

    const slave = tunnelManager.getSlave(id);

    if (!slave) {
      return res.status(404).json({
        error: 'Slave not found',
        slaveId: id,
        healthy: false
      });
    }

    const isConnected = tunnelManager.isSlaveConnected(id);

    res.json({
      success: true,
      healthy: isConnected,
      slaveId: id,
      name: slave.name,
      status: slave.status,
      lastPing: slave.lastPing,
      message: isConnected ? 'Slave is healthy' : 'Slave is disconnected'
    });
  });

  return router;
}

export default createClusterRoutes;
