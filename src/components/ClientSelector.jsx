/**
 * ClientSelector - Dropdown component for selecting target client
 *
 * Features:
 * - Shows current client name with status indicator
 * - Lists all connected clients with status
 * - Includes 'Local' option for master server
 * - Updates localStorage and triggers context update on selection
 */

import React, { useState, useRef, useEffect } from 'react';
import { useCluster } from '../contexts/ClusterContext';
import { ChevronDown, Server, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';

function ClientSelector({ className }) {
  const {
    isMaster,
    clients,
    selectedClientId,
    selectedClient,
    selectClient,
    refreshClients,
    isLoading
  } = useCluster();

  const [isOpen, setIsOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const dropdownRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Don't render if not in master mode
  if (!isMaster) {
    return null;
  }

  const handleSelect = (clientId) => {
    selectClient(clientId);
    setIsOpen(false);
  };

  const handleRefresh = async (e) => {
    e.stopPropagation();
    setIsRefreshing(true);
    try {
      await refreshClients();
    } finally {
      setIsRefreshing(false);
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'connected':
        return 'bg-green-500';
      case 'disconnected':
        return 'bg-red-500';
      default:
        return 'bg-gray-400';
    }
  };

  const getStatusIcon = (status) => {
    if (status === 'connected') {
      return <Wifi className="w-3 h-3 text-green-500" />;
    }
    return <WifiOff className="w-3 h-3 text-red-500" />;
  };

  return (
    <div className={cn("relative", className)} ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "w-full flex items-center justify-between gap-2 px-3 py-2",
          "bg-muted/50 hover:bg-muted border border-border rounded-lg",
          "transition-colors duration-200",
          "text-sm font-medium text-foreground"
        )}
        disabled={isLoading}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Server className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <span className="truncate">
            {selectedClient?.name || 'Select Client'}
          </span>
          <span className={cn(
            "w-2 h-2 rounded-full flex-shrink-0",
            getStatusColor(selectedClient?.status)
          )} />
        </div>
        <ChevronDown className={cn(
          "w-4 h-4 text-muted-foreground transition-transform duration-200",
          isOpen && "rotate-180"
        )} />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className={cn(
          "absolute top-full left-0 right-0 mt-1 z-50",
          "bg-card border border-border rounded-lg shadow-lg",
          "overflow-hidden"
        )}>
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Target Client
            </span>
            <button
              onClick={handleRefresh}
              className="p-1 hover:bg-accent rounded transition-colors"
              disabled={isRefreshing}
              title="Refresh client list"
            >
              <RefreshCw className={cn(
                "w-3 h-3 text-muted-foreground",
                isRefreshing && "animate-spin"
              )} />
            </button>
          </div>

          {/* Client List */}
          <div className="max-h-64 overflow-y-auto">
            {clients.map((client) => (
              <button
                key={client.id}
                onClick={() => handleSelect(client.id)}
                disabled={client.status !== 'connected'}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5",
                  "hover:bg-accent transition-colors duration-150",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                  selectedClientId === client.id && "bg-accent"
                )}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {client.isLocal ? (
                    <Server className="w-4 h-4 text-primary flex-shrink-0" />
                  ) : (
                    <Server className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  )}
                  <div className="min-w-0 flex-1 text-left">
                    <div className="text-sm font-medium text-foreground truncate">
                      {client.name}
                    </div>
                    {!client.isLocal && client.connectedAt && (
                      <div className="text-xs text-muted-foreground">
                        Connected {new Date(client.connectedAt).toLocaleTimeString()}
                      </div>
                    )}
                  </div>
                </div>
                {getStatusIcon(client.status)}
              </button>
            ))}

            {clients.length === 0 && (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                No clients available
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-3 py-2 border-t border-border bg-muted/30">
            <p className="text-xs text-muted-foreground">
              {clients.filter(c => c.status === 'connected').length} of {clients.length} clients connected
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default ClientSelector;
