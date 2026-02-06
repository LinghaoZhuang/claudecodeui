import React, { createContext, useContext, useState, useCallback } from 'react';

const SessionProtectionContext = createContext(null);

export const useSessionProtection = () => {
  const context = useContext(SessionProtectionContext);
  if (!context) {
    throw new Error('useSessionProtection must be used within a SessionProtectionProvider');
  }
  return context;
};

export const SessionProtectionProvider = ({ children }) => {
  // Track sessions with active conversations to prevent
  // automatic project updates from interrupting ongoing chats.
  const [activeSessions, setActiveSessions] = useState(new Set());

  // Track which sessions are currently thinking/processing
  const [processingSessions, setProcessingSessions] = useState(new Set());

  // External Message Update Trigger: Incremented when external CLI modifies current session's JSONL
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);

  const markSessionAsActive = useCallback((sessionId) => {
    if (sessionId) {
      setActiveSessions(prev => new Set([...prev, sessionId]));
    }
  }, []);

  const markSessionAsInactive = useCallback((sessionId) => {
    if (sessionId) {
      setActiveSessions(prev => {
        const newSet = new Set(prev);
        newSet.delete(sessionId);
        return newSet;
      });
    }
  }, []);

  const markSessionAsProcessing = useCallback((sessionId) => {
    if (sessionId) {
      setProcessingSessions(prev => new Set([...prev, sessionId]));
    }
  }, []);

  const markSessionAsNotProcessing = useCallback((sessionId) => {
    if (sessionId) {
      setProcessingSessions(prev => {
        const newSet = new Set(prev);
        newSet.delete(sessionId);
        return newSet;
      });
    }
  }, []);

  const replaceTemporarySession = useCallback((realSessionId) => {
    if (realSessionId) {
      setActiveSessions(prev => {
        const newSet = new Set();
        for (const sessionId of prev) {
          if (!sessionId.startsWith('new-session-')) {
            newSet.add(sessionId);
          }
        }
        newSet.add(realSessionId);
        return newSet;
      });
    }
  }, []);

  const triggerExternalUpdate = useCallback(() => {
    setExternalMessageUpdate(prev => prev + 1);
  }, []);

  const hasActiveSession = useCallback((selectedSessionId) => {
    return (selectedSessionId && activeSessions.has(selectedSessionId)) ||
      (activeSessions.size > 0 && [...activeSessions].some(id => id.startsWith('new-session-')));
  }, [activeSessions]);

  const contextValue = {
    activeSessions,
    processingSessions,
    externalMessageUpdate,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
    replaceTemporarySession,
    triggerExternalUpdate,
    hasActiveSession,
  };

  return (
    <SessionProtectionContext.Provider value={contextValue}>
      {children}
    </SessionProtectionContext.Provider>
  );
};

export default SessionProtectionContext;
