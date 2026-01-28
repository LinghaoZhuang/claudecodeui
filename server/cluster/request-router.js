/**
 * Request Router Middleware
 *
 * Express middleware that routes requests based on X-Target-Slave header.
 * - If header is 'local' or not present: pass to local handler
 * - If header specifies a slave ID: forward through tunnel
 */

function createRequestRouter(tunnelManager) {
  return async (req, res, next) => {
    const targetSlave = req.headers['x-target-slave'];

    // Log onboarding requests for debugging
    if (req.originalUrl.includes('onboarding')) {
      console.log('[RequestRouter] Onboarding request:', req.method, req.originalUrl, 'target:', targetSlave || 'local');
    }

    // If no target or 'local', handle locally
    if (!targetSlave || targetSlave === 'local') {
      return next();
    }

    // Check if slave is connected
    if (!tunnelManager.isSlaveConnected(targetSlave)) {
      return res.status(503).json({
        error: 'Slave not connected',
        slaveId: targetSlave,
        message: `The target client '${targetSlave}' is not currently connected`
      });
    }

    try {
      // Forward request through tunnel
      const response = await tunnelManager.forwardHttpRequest(targetSlave, req);

      // Set response headers
      for (const [key, value] of Object.entries(response.headers)) {
        // Skip certain headers that shouldn't be forwarded
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }

      // Send response
      res.status(response.status);

      // Try to parse as JSON, otherwise send as-is
      try {
        const jsonBody = JSON.parse(response.body);
        res.json(jsonBody);
      } catch (e) {
        res.send(response.body);
      }

    } catch (error) {
      console.error(`[RequestRouter] Error forwarding to ${targetSlave}:`, error.message);

      res.status(502).json({
        error: 'Tunnel error',
        slaveId: targetSlave,
        message: error.message
      });
    }
  };
}

export default createRequestRouter;
