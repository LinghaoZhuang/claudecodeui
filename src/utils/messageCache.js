/**
 * MessageCache - IndexedDB based message caching system
 *
 * Provides fast local storage for chat messages with:
 * - Instant loading from cache when switching sessions
 * - Incremental sync with server
 * - Offline message viewing
 * - Automatic migration from localStorage
 */

const DB_NAME = 'ClaudeCodeChat';
const DB_VERSION = 1;

// Store names
const MESSAGES_STORE = 'messages';
const SYNC_STATE_STORE = 'syncState';

class MessageCache {
  constructor() {
    this.db = null;
    this.dbReady = null;
  }

  /**
   * Initialize the IndexedDB database
   */
  async init() {
    if (this.dbReady) {
      return this.dbReady;
    }

    this.dbReady = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('[MessageCache] Failed to open IndexedDB:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('[MessageCache] IndexedDB initialized');
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Messages store: stores individual messages
        // Index by sessionId for fast retrieval
        if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
          const messagesStore = db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
          messagesStore.createIndex('sessionId', 'sessionId', { unique: false });
          messagesStore.createIndex('sessionTimestamp', ['sessionId', 'timestamp'], { unique: false });
          messagesStore.createIndex('projectSession', ['projectName', 'sessionId'], { unique: false });
        }

        // Sync state store: tracks last sync time per session
        if (!db.objectStoreNames.contains(SYNC_STATE_STORE)) {
          db.createObjectStore(SYNC_STATE_STORE, { keyPath: 'sessionId' });
        }

        console.log('[MessageCache] IndexedDB schema created/upgraded');
      };
    });

    return this.dbReady;
  }

  /**
   * Generate a unique message ID
   */
  generateMessageId(message, sessionId) {
    // Use existing id if available, otherwise generate from content hash
    if (message.uuid) return `${sessionId}_${message.uuid}`;
    if (message.id) return `${sessionId}_${message.id}`;

    // Generate ID from timestamp and content hash
    const timestamp = message.timestamp ? new Date(message.timestamp).getTime() : Date.now();
    const contentHash = this.hashString(JSON.stringify(message).slice(0, 200));
    return `${sessionId}_${timestamp}_${contentHash}`;
  }

  /**
   * Simple string hash function
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Get messages for a session from cache
   * @param {string} sessionId - The session ID
   * @param {number} limit - Maximum number of messages to return (0 for all)
   * @param {number} beforeTimestamp - Only return messages before this timestamp (for pagination)
   * @returns {Promise<Array>} Array of messages sorted by timestamp
   */
  async getMessages(sessionId, limit = 0, beforeTimestamp = null) {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([MESSAGES_STORE], 'readonly');
      const store = transaction.objectStore(MESSAGES_STORE);
      const index = store.index('sessionId');
      const request = index.getAll(sessionId);

      request.onsuccess = () => {
        let messages = request.result || [];

        // Sort by timestamp
        messages.sort((a, b) => {
          const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return timeA - timeB;
        });

        // Filter by beforeTimestamp if specified
        if (beforeTimestamp) {
          messages = messages.filter(m => {
            const msgTime = m.timestamp ? new Date(m.timestamp).getTime() : 0;
            return msgTime < beforeTimestamp;
          });
        }

        // Apply limit if specified
        if (limit > 0 && messages.length > limit) {
          messages = messages.slice(-limit);
        }

        resolve(messages);
      };

      request.onerror = () => {
        console.error('[MessageCache] Error getting messages:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Save messages to cache
   * @param {Array} messages - Array of messages to save
   * @param {string} sessionId - The session ID
   * @param {string} projectName - The project name
   */
  async saveMessages(messages, sessionId, projectName) {
    if (!messages || messages.length === 0) return;

    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([MESSAGES_STORE], 'readwrite');
      const store = transaction.objectStore(MESSAGES_STORE);

      let savedCount = 0;

      messages.forEach(message => {
        const id = this.generateMessageId(message, sessionId);
        const timestamp = message.timestamp ? new Date(message.timestamp).getTime() : Date.now();

        const record = {
          id,
          sessionId,
          projectName,
          timestamp,
          rawData: message,
          syncedAt: Date.now()
        };

        const request = store.put(record);
        request.onsuccess = () => {
          savedCount++;
        };
        request.onerror = () => {
          console.warn('[MessageCache] Error saving message:', request.error);
        };
      });

      transaction.oncomplete = () => {
        console.log(`[MessageCache] Saved ${savedCount} messages for session ${sessionId}`);
        resolve(savedCount);
      };

      transaction.onerror = () => {
        console.error('[MessageCache] Transaction error:', transaction.error);
        reject(transaction.error);
      };
    });
  }

  /**
   * Get the last sync state for a session
   * @param {string} sessionId - The session ID
   * @returns {Promise<Object|null>} Sync state or null if not found
   */
  async getSyncState(sessionId) {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([SYNC_STATE_STORE], 'readonly');
      const store = transaction.objectStore(SYNC_STATE_STORE);
      const request = store.get(sessionId);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        console.error('[MessageCache] Error getting sync state:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Update the sync state for a session
   * @param {string} sessionId - The session ID
   * @param {number} lastSyncTimestamp - The server timestamp of last sync
   * @param {number} messageCount - Total message count at sync time
   */
  async updateSyncState(sessionId, lastSyncTimestamp, messageCount = 0) {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([SYNC_STATE_STORE], 'readwrite');
      const store = transaction.objectStore(SYNC_STATE_STORE);

      const record = {
        sessionId,
        lastSyncTimestamp,
        messageCount,
        updatedAt: Date.now()
      };

      const request = store.put(record);

      request.onsuccess = () => {
        resolve(true);
      };

      request.onerror = () => {
        console.error('[MessageCache] Error updating sync state:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Clear all messages for a session
   * @param {string} sessionId - The session ID
   */
  async clearSession(sessionId) {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([MESSAGES_STORE, SYNC_STATE_STORE], 'readwrite');

      // Clear messages
      const messagesStore = transaction.objectStore(MESSAGES_STORE);
      const index = messagesStore.index('sessionId');
      const request = index.openCursor(sessionId);

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      // Clear sync state
      const syncStore = transaction.objectStore(SYNC_STATE_STORE);
      syncStore.delete(sessionId);

      transaction.oncomplete = () => {
        console.log(`[MessageCache] Cleared session ${sessionId}`);
        resolve(true);
      };

      transaction.onerror = () => {
        console.error('[MessageCache] Error clearing session:', transaction.error);
        reject(transaction.error);
      };
    });
  }

  /**
   * Get message count for a session
   * @param {string} sessionId - The session ID
   * @returns {Promise<number>} Message count
   */
  async getMessageCount(sessionId) {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([MESSAGES_STORE], 'readonly');
      const store = transaction.objectStore(MESSAGES_STORE);
      const index = store.index('sessionId');
      const request = index.count(sessionId);

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        console.error('[MessageCache] Error counting messages:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Migrate messages from localStorage to IndexedDB
   * @param {string} projectName - The project name
   */
  async migrateFromLocalStorage(projectName) {
    const key = `chat_messages_${projectName}`;
    const saved = localStorage.getItem(key);

    if (!saved) return false;

    try {
      const messages = JSON.parse(saved);
      if (!Array.isArray(messages) || messages.length === 0) return false;

      // Group messages by session if possible
      // For now, just save with a generic session ID
      const sessionId = messages[0]?.sessionId || `legacy_${projectName}`;

      await this.saveMessages(messages, sessionId, projectName);

      console.log(`[MessageCache] Migrated ${messages.length} messages from localStorage for ${projectName}`);

      // Don't remove from localStorage yet - keep as backup
      // localStorage.removeItem(key);

      return true;
    } catch (error) {
      console.error('[MessageCache] Migration error:', error);
      return false;
    }
  }

  /**
   * Check if IndexedDB is available
   */
  static isAvailable() {
    return typeof indexedDB !== 'undefined';
  }

  /**
   * Get database statistics
   */
  async getStats() {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([MESSAGES_STORE, SYNC_STATE_STORE], 'readonly');

      const messagesStore = transaction.objectStore(MESSAGES_STORE);
      const syncStore = transaction.objectStore(SYNC_STATE_STORE);

      const messagesCountReq = messagesStore.count();
      const syncCountReq = syncStore.count();

      let stats = {};

      messagesCountReq.onsuccess = () => {
        stats.messageCount = messagesCountReq.result;
      };

      syncCountReq.onsuccess = () => {
        stats.sessionCount = syncCountReq.result;
      };

      transaction.oncomplete = () => {
        resolve(stats);
      };

      transaction.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  /**
   * Clear all cached data
   */
  async clearAll() {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([MESSAGES_STORE, SYNC_STATE_STORE], 'readwrite');

      transaction.objectStore(MESSAGES_STORE).clear();
      transaction.objectStore(SYNC_STATE_STORE).clear();

      transaction.oncomplete = () => {
        console.log('[MessageCache] All cache cleared');
        resolve(true);
      };

      transaction.onerror = () => {
        reject(transaction.error);
      };
    });
  }
}

// Singleton instance
const messageCache = new MessageCache();

export default messageCache;
export { MessageCache };
