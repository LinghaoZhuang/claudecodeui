/**
 * ClusterContext - React context for cluster management
 *
 * Provides:
 * - List of connected slave clients
 * - Currently selected client (persisted in localStorage)
 * - Methods to switch between clients
 * - Periodic polling for client status updates
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { authenticatedFetch } from '../utils/api';

const ClusterContext = createContext(null);

// Storage key for persisting selected client
const SELECTED_CLIENT_KEY = 'cluster-selected-client';

// Polling interval for client status (30 seconds)
const POLL_INTERVAL = 30000;

export function ClusterProvider({ children }) {
  // Cluster mode status
  const [clusterMode, setClusterMode] = useState('standalone'); // standalone, master, slave
  const [isMaster, setIsMaster] = useState(false);

  // List of connected clients (includes 'local')
  const [clients, setClients] = useState([]);

  // Currently selected client ID
  const [selectedClientId, setSelectedClientId] = useState(() => {
    try {
      return localStorage.getItem(SELECTED_CLIENT_KEY) || 'local';
    } catch {
      return 'local';
    }
  });

  // Loading and error states
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Polling timer ref
  const pollTimerRef = useRef(null);

  /**
   * Fetch cluster status and client list
   */
  const fetchClusterStatus = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/cluster/status');
      if (!response.ok) {
        throw new Error('Failed to fetch cluster status');
      }

      const data = await response.json();
      setClusterMode(data.mode);
      setIsMaster(data.isMaster);

      // If in master mode, fetch detailed client list
      if (data.isMaster) {
        const clientsResponse = await authenticatedFetch('/api/cluster/slaves');
        if (clientsResponse.ok) {
          const clientsData = await clientsResponse.json();
          setClients(clientsData.clients || []);
        }
      } else {
        // Not in master mode - only local is available
        setClients([{
          id: 'local',
          name: 'Local Server',
          status: 'connected',
          isLocal: true
        }]);
        // Reset to local if not in master mode
        if (selectedClientId !== 'local') {
          setSelectedClientId('local');
          localStorage.setItem(SELECTED_CLIENT_KEY, 'local');
        }
      }

      setError(null);
    } catch (err) {
      console.error('[ClusterContext] Error fetching cluster status:', err);
      setError(err.message);
      // Default to standalone mode on error
      setClusterMode('standalone');
      setIsMaster(false);
      setClients([{
        id: 'local',
        name: 'Local Server',
        status: 'connected',
        isLocal: true
      }]);
    } finally {
      setIsLoading(false);
    }
  }, [selectedClientId]);

  /**
   * Select a client by ID
   */
  const selectClient = useCallback((clientId) => {
    // Validate client exists
    const client = clients.find(c => c.id === clientId);
    if (!client) {
      console.warn(`[ClusterContext] Client not found: ${clientId}`);
      return;
    }

    // Check if client is connected
    if (client.status !== 'connected') {
      console.warn(`[ClusterContext] Client not connected: ${clientId}`);
      return;
    }

    setSelectedClientId(clientId);

    // Persist to localStorage
    try {
      localStorage.setItem(SELECTED_CLIENT_KEY, clientId);
    } catch (err) {
      console.error('[ClusterContext] Error saving selected client:', err);
    }

    // Dispatch custom event for components that need to react to client change
    window.dispatchEvent(new CustomEvent('cluster-client-changed', {
      detail: { clientId, client }
    }));
  }, [clients]);

  /**
   * Get currently selected client object
   */
  const selectedClient = clients.find(c => c.id === selectedClientId) || {
    id: 'local',
    name: 'Local Server',
    status: 'connected',
    isLocal: true
  };

  /**
   * Check if a specific client is connected
   */
  const isClientConnected = useCallback((clientId) => {
    const client = clients.find(c => c.id === clientId);
    return client && client.status === 'connected';
  }, [clients]);

  // Initial fetch
  useEffect(() => {
    fetchClusterStatus();
  }, [fetchClusterStatus]);

  // Start polling when in master mode
  useEffect(() => {
    if (isMaster) {
      pollTimerRef.current = setInterval(fetchClusterStatus, POLL_INTERVAL);
    }

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isMaster, fetchClusterStatus]);

  // Validate selected client still exists when clients list changes
  useEffect(() => {
    if (clients.length > 0 && selectedClientId !== 'local') {
      const clientExists = clients.some(c => c.id === selectedClientId);
      if (!clientExists) {
        console.log(`[ClusterContext] Selected client ${selectedClientId} no longer available, switching to local`);
        selectClient('local');
      }
    }
  }, [clients, selectedClientId, selectClient]);

  const value = {
    // State
    clusterMode,
    isMaster,
    clients,
    selectedClientId,
    selectedClient,
    isLoading,
    error,

    // Actions
    selectClient,
    isClientConnected,
    refreshClients: fetchClusterStatus
  };

  return (
    <ClusterContext.Provider value={value}>
      {children}
    </ClusterContext.Provider>
  );
}

/**
 * Hook to access cluster context
 */
export function useCluster() {
  const context = useContext(ClusterContext);
  if (!context) {
    throw new Error('useCluster must be used within a ClusterProvider');
  }
  return context;
}

/**
 * Get current selected client ID from localStorage (for use outside React)
 */
export function getSelectedClientId() {
  try {
    return localStorage.getItem(SELECTED_CLIENT_KEY) || 'local';
  } catch {
    return 'local';
  }
}

export default ClusterContext;
