/**
 * localStorage quota management utilities.
 *
 * Provides safe writes with automatic cleanup on QuotaExceededError,
 * a tiered cleanup strategy, and storage usage introspection.
 */

/** Priority order for cleanup (lowest priority cleared first). */
const CLEANUP_PREFIXES = [
  'chat_messages_',
  'draft_input_',
  'cached-projects-',
];

/**
 * Remove localStorage entries by prefix, oldest first.
 * Returns the number of entries removed.
 */
function removeByPrefix(prefix, keep = 0) {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) keys.push(k);
  }
  // Sort alphabetically (works for timestamped / incrementing keys)
  keys.sort();

  const toRemove = keep > 0 ? keys.slice(0, Math.max(0, keys.length - keep)) : keys;
  toRemove.forEach((k) => localStorage.removeItem(k));
  return toRemove.length;
}

/**
 * Progressively free localStorage space.
 *
 * Strategy:
 *  1. chat_messages_*  — keep 3 most recent
 *  2. draft_input_*    — remove all
 *  3. cached-projects- — remove all
 */
export function cleanupStorage() {
  let freed = 0;
  // 1. chat messages — keep 3 most recent
  freed += removeByPrefix('chat_messages_', 3);
  if (freed > 0) return freed;

  // 2. drafts — remove all
  freed += removeByPrefix('draft_input_', 0);
  if (freed > 0) return freed;

  // 3. cached projects — remove all
  freed += removeByPrefix('cached-projects-', 0);
  return freed;
}

/**
 * Safely write to localStorage.
 * On QuotaExceededError runs cleanupStorage() then retries once.
 *
 * @param {string} key
 * @param {string} value  — must already be serialised (JSON.stringify etc.)
 * @returns {boolean} true if the write succeeded
 */
export function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    if (error.name === 'QuotaExceededError' || error.code === 22) {
      console.warn('[localStorage] Quota exceeded, running cleanup...');
      cleanupStorage();
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (retryError) {
        console.error('[localStorage] Still over quota after cleanup:', retryError);
        return false;
      }
    }
    console.error('[localStorage] setItem error:', error);
    return false;
  }
}

/**
 * Approximate localStorage usage.
 *
 * @returns {{ used: number, percentage: number }}
 *   `used` in bytes (approximate), `percentage` 0-100 based on 5 MB default limit.
 */
export function getStorageUsage() {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) {
      // Each char is roughly 2 bytes in JS (UTF-16)
      total += (key.length + (localStorage.getItem(key) || '').length) * 2;
    }
  }
  const LIMIT = 5 * 1024 * 1024; // 5 MB typical browser default
  return {
    used: total,
    percentage: Math.round((total / LIMIT) * 100),
  };
}
