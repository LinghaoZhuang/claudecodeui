import { useState, useCallback, useRef } from 'react';

/**
 * Generate a stable deduplication key for a message.
 * Priority: uuid > id > timestamp+contentHash
 */
function generateMessageKey(msg) {
  if (msg.uuid) return msg.uuid;
  if (msg.id) return String(msg.id);

  // For converted chat messages (from WebSocket or UI), hash content + timestamp + type
  const ts = msg.timestamp instanceof Date ? msg.timestamp.getTime() : (msg.timestamp ? new Date(msg.timestamp).getTime() : 0);
  const type = msg.type || msg.role || '';
  const toolId = msg.toolId || '';

  let contentSlice = '';
  if (typeof msg.content === 'string') {
    contentSlice = msg.content.slice(0, 200);
  } else if (Array.isArray(msg.content)) {
    contentSlice = JSON.stringify(msg.content).slice(0, 200);
  }

  return `${type}:${ts}:${toolId}:${hashStr(contentSlice)}`;
}

function hashStr(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash;
}

/**
 * useMessages — centralized message state with built-in deduplication
 *
 * Usage:
 *   const { chatMessages, sessionMessages, addMessages, replaceMessages, addOptimisticMessage, updateMessage, clearMessages } = useMessages();
 */
export default function useMessages() {
  const [chatMessages, setChatMessages] = useState([]);
  const [sessionMessages, setSessionMessages] = useState([]);
  const knownKeysRef = useRef(new Set());

  /**
   * Replace all messages (e.g. on session switch).
   * Rebuilds the dedup set from scratch.
   */
  const replaceMessages = useCallback((newChatMessages, newSessionMessages) => {
    const keys = new Set();
    const deduped = [];
    for (const msg of newChatMessages) {
      const key = generateMessageKey(msg);
      if (!keys.has(key)) {
        keys.add(key);
        deduped.push(msg);
      }
    }
    knownKeysRef.current = keys;
    setChatMessages(deduped);
    if (newSessionMessages !== undefined) {
      setSessionMessages(newSessionMessages);
    }
  }, []);

  /**
   * Append messages with automatic deduplication.
   * Returns the count of actually-new messages added.
   */
  const addMessages = useCallback((newChatMsgs, newSessionMsgs) => {
    if (!newChatMsgs || newChatMsgs.length === 0) return;

    const keys = knownKeysRef.current;
    const filtered = [];
    for (const msg of newChatMsgs) {
      const key = generateMessageKey(msg);
      if (!keys.has(key)) {
        keys.add(key);
        filtered.push(msg);
      }
    }

    if (filtered.length > 0) {
      setChatMessages(prev => [...prev, ...filtered]);
    }

    if (newSessionMsgs && newSessionMsgs.length > 0) {
      setSessionMessages(prev => [...prev, ...newSessionMsgs]);
    }
  }, []);

  /**
   * Add a single optimistic message (user-sent).
   * Marked with _optimistic flag so it can be reconciled later.
   */
  const addOptimisticMessage = useCallback((msg) => {
    const key = generateMessageKey(msg);
    knownKeysRef.current.add(key);
    setChatMessages(prev => [...prev, msg]);
  }, []);

  /**
   * Update messages in-place (e.g. tool_result filling in toolResult field).
   * Accepts a mapper function: (msg) => msg
   */
  const updateMessages = useCallback((mapperFn) => {
    setChatMessages(prev => prev.map(mapperFn));
  }, []);

  /**
   * Clear all messages (e.g. new session view).
   */
  const clearMessages = useCallback(() => {
    knownKeysRef.current = new Set();
    setChatMessages([]);
    setSessionMessages([]);
  }, []);

  /**
   * Direct setter for chatMessages (escape hatch for complex logic).
   * When using this, the caller is responsible for dedup.
   */
  const setChatMessagesDirect = useCallback((updater) => {
    setChatMessages(updater);
  }, []);

  /**
   * Direct setter for sessionMessages.
   */
  const setSessionMessagesDirect = useCallback((updater) => {
    setSessionMessages(updater);
  }, []);

  return {
    chatMessages,
    sessionMessages,
    replaceMessages,
    addMessages,
    addOptimisticMessage,
    updateMessages,
    clearMessages,
    setChatMessagesDirect,
    setSessionMessagesDirect,
  };
}
