/*
 * ChatInterface.jsx - Chat Component with Session Protection Integration
 * 
 * SESSION PROTECTION INTEGRATION:
 * ===============================
 * 
 * This component integrates with the Session Protection System to prevent project updates
 * from interrupting active conversations:
 * 
 * Key Integration Points:
 * 1. handleSubmit() - Marks session as active when user sends message (including temp ID for new sessions)
 * 2. session-created handler - Replaces temporary session ID with real WebSocket session ID  
 * 3. claude-complete handler - Marks session as inactive when conversation finishes
 * 4. session-aborted handler - Marks session as inactive when conversation is aborted
 * 
 * This ensures uninterrupted chat experience by coordinating with App.jsx to pause sidebar updates.
 */

import React, { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import ClaudeLogo from './ClaudeLogo.jsx';
import CursorLogo from './CursorLogo.jsx';
import CodexLogo from './CodexLogo.jsx';
import { useTasksSettings } from '../contexts/TasksSettingsContext';
import { useChatSettings } from '../contexts/ChatSettingsContext';
import { useSessionProtection } from '../contexts/SessionProtectionContext';
import { useProjectRefresh } from '../contexts/ProjectRefreshContext';
import { useTranslation } from 'react-i18next';

import ClaudeStatus from './ClaudeStatus';
import TokenUsagePie from './TokenUsagePie';
import { api, authenticatedFetch } from '../utils/api';
import messageCache from '../utils/messageCache';
import ThinkingModeSelector, { thinkingModes } from './ThinkingModeSelector.jsx';
import { CLAUDE_MODELS, CURSOR_MODELS, CODEX_MODELS } from '../../shared/modelConstants';

import { decodeHtmlEntities, unescapeWithMathProtection, formatUsageLimitText, safeLocalStorage } from '../utils/chatUtils.js';
import { getClaudeSettings, buildClaudeToolPermissionEntry, formatToolInputForDisplay, getClaudePermissionSuggestion, grantClaudeToolPermission } from '../utils/toolPermissions.js';
import MessageComponent from './chat/MessageBubble.jsx';
import ProviderSelector from './chat/ProviderSelector.jsx';
import ChatInput from './chat/ChatInput.jsx';
import { useSlashCommands } from '../hooks/useSlashCommands.js';
import { useFileAutocomplete } from '../hooks/useFileAutocomplete.jsx';

// ChatInterface: Main chat component with Session Protection System integration
// 
// Session Protection System prevents automatic project updates from interrupting active conversations:
// - onSessionActive: Called when user sends message to mark session as protected
// - onSessionInactive: Called when conversation completes/aborts to re-enable updates
// - onReplaceTemporarySession: Called to replace temporary session ID with real WebSocket session ID
//
// This ensures uninterrupted chat experience by pausing sidebar refreshes during conversations.
function ChatInterface({ selectedProject, selectedSession, ws, sendMessage, latestMessage, onFileOpen, onInputFocusChange, onTaskClick, onShowAllTasks }) {
  const navigate = useNavigate();
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { autoExpandTools, showRawParameters, showThinking, autoScrollToBottom, sendByCtrlEnter, openSettings: onShowSettings } = useChatSettings();
  const { processingSessions, externalMessageUpdate, markSessionAsActive: onSessionActive, markSessionAsInactive: onSessionInactive, markSessionAsProcessing: onSessionProcessing, markSessionAsNotProcessing: onSessionNotProcessing, replaceTemporarySession: onReplaceTemporarySession } = useSessionProtection();
  const { refreshProjects } = useProjectRefresh();
  const { t } = useTranslation('chat');
  const [input, setInput] = useState(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      return safeLocalStorage.getItem(`draft_input_${selectedProject.name}`) || '';
    }
    return '';
  });
  const [chatMessages, setChatMessages] = useState(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      const saved = safeLocalStorage.getItem(`chat_messages_${selectedProject.name}`);
      return saved ? JSON.parse(saved) : [];
    }
    return [];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState(selectedSession?.id || null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [sessionMessages, setSessionMessages] = useState([]);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [messagesOffset, setMessagesOffset] = useState(0);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const MESSAGES_PER_PAGE = 20;
  const [isSystemSessionChange, setIsSystemSessionChange] = useState(false);
  const [permissionMode, setPermissionMode] = useState('default');
  // In-memory queue of tool permission prompts for the current UI view.
  // These are not persisted and do not survive a page refresh; introduced so
  // the UI can present pending approvals while the SDK waits.
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState([]);
  const [attachedImages, setAttachedImages] = useState([]);
  const [uploadingImages, setUploadingImages] = useState(new Map());
  const [imageErrors, setImageErrors] = useState(new Map());
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const inputContainerRef = useRef(null);
  const inputHighlightRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const isLoadingSessionRef = useRef(false); // Track session loading to prevent multiple scrolls
  const isLoadingMoreRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef(null);
  // Streaming throttle buffers
  const streamBufferRef = useRef('');
  const streamTimerRef = useRef(null);
  // Track the session that this view expects when starting a brand‑new chat
  // (prevents background sessions from streaming into a different view).
  const pendingViewSessionRef = useRef(null);
  const [debouncedInput, setDebouncedInput] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [canAbortSession, setCanAbortSession] = useState(false);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const scrollPositionRef = useRef({ height: 0, top: 0 });
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [tokenBudget, setTokenBudget] = useState(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(100);
  const [claudeStatus, setClaudeStatus] = useState(null);
  const [thinkingMode, setThinkingMode] = useState('none');
  const [provider, setProvider] = useState(() => {
    return localStorage.getItem('selected-provider') || 'claude';
  });
  const [cursorModel, setCursorModel] = useState(() => {
    return localStorage.getItem('cursor-model') || CURSOR_MODELS.DEFAULT;
  });
  const [claudeModel, setClaudeModel] = useState(() => {
    return localStorage.getItem('claude-model') || CLAUDE_MODELS.DEFAULT;
  });
  const [codexModel, setCodexModel] = useState(() => {
    return localStorage.getItem('codex-model') || CODEX_MODELS.DEFAULT;
  });
  // Track provider transitions so we only clear approvals when provider truly changes.
  // This does not sync with the backend; it just prevents UI prompts from disappearing.
  const lastProviderRef = useRef(provider);

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamBufferRef.current = '';
  }, []);
  // Load permission mode for the current session
  useEffect(() => {
    if (selectedSession?.id) {
      const savedMode = localStorage.getItem(`permissionMode-${selectedSession.id}`);
      if (savedMode) {
        setPermissionMode(savedMode);
      } else {
        setPermissionMode('default');
      }
    }
  }, [selectedSession?.id]);

  // When selecting a session from Sidebar, auto-switch provider to match session's origin
  useEffect(() => {
    if (selectedSession && selectedSession.__provider && selectedSession.__provider !== provider) {
      setProvider(selectedSession.__provider);
      localStorage.setItem('selected-provider', selectedSession.__provider);
    }
  }, [selectedSession]);

  // Clear pending permission prompts when switching providers; filter when switching sessions.
  // This does not preserve prompts across provider changes; it exists to keep the
  // Claude approval flow intact while preventing prompts from a different provider.
  useEffect(() => {
    if (lastProviderRef.current !== provider) {
      setPendingPermissionRequests([]);
      lastProviderRef.current = provider;
    }
  }, [provider]);

  // When the selected session changes, drop prompts that belong to other sessions.
  // This does not attempt to migrate prompts across sessions; it only filters,
  // introduced so the UI does not show approvals for a session the user is no longer viewing.
  useEffect(() => {
    setPendingPermissionRequests(prev => prev.filter(req => !req.sessionId || req.sessionId === selectedSession?.id));
  }, [selectedSession?.id]);

  // Initialize IndexedDB message cache on mount
  // Also migrate data from localStorage if needed (one-time migration)
  useEffect(() => {
    const initCache = async () => {
      try {
        await messageCache.init();
        console.log('[MessageCache] IndexedDB initialized');

        // Attempt migration from localStorage for current project
        if (selectedProject) {
          const migrated = await messageCache.migrateFromLocalStorage(selectedProject.name);
          if (migrated) {
            console.log(`[MessageCache] Migrated localStorage data for ${selectedProject.name}`);
          }
        }
      } catch (error) {
        console.warn('[MessageCache] Initialization error:', error);
      }
    };
    initCache();
  }, [selectedProject?.name]);

  // Load Cursor default model from config
  useEffect(() => {
    if (provider === 'cursor') {
      authenticatedFetch('/api/cursor/config')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.config?.model?.modelId) {
          // Use the model from config directly
          const modelId = data.config.model.modelId;
          if (!localStorage.getItem('cursor-model')) {
            setCursorModel(modelId);
          }
        }
      })
      .catch(err => console.error('Error loading Cursor config:', err));
    }
  }, [provider]);

  // Ref to store handleSubmit so we can call it from handleCustomCommand
  const handleSubmitRef = useRef(null);

  // Slash commands hook
  const {
    showCommandMenu, setShowCommandMenu,
    slashCommands, setSlashCommands,
    filteredCommands, setFilteredCommands,
    commandQuery, setCommandQuery,
    selectedCommandIndex, setSelectedCommandIndex,
    slashPosition, setSlashPosition,
    commandQueryTimerRef,
    frequentCommands,
    handleCommandSelect,
    selectCommand,
    executeCommand,
  } = useSlashCommands({
    selectedProject,
    input,
    setInput,
    currentSessionId,
    provider,
    cursorModel,
    claudeModel,
    tokenBudget,
    setChatMessages,
    setSessionMessages,
    onFileOpen,
    handleSubmitRef,
  });

  // File autocomplete hook
  const {
    showFileDropdown, setShowFileDropdown,
    filteredFiles,
    selectedFileIndex, setSelectedFileIndex,
    renderInputWithMentions,
    selectFile,
  } = useFileAutocomplete({
    selectedProject,
    input,
    cursorPosition,
    setInput,
    setCursorPosition,
    textareaRef,
  });


  // Memoized diff calculation to prevent recalculating on every render
  const createDiff = useMemo(() => {
    const cache = new Map();
    return (oldStr, newStr) => {
      const key = `${oldStr.length}-${newStr.length}-${oldStr.slice(0, 50)}`;
      if (cache.has(key)) {
        return cache.get(key);
      }
      
      const result = calculateDiff(oldStr, newStr);
      cache.set(key, result);
      if (cache.size > 100) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
      }
      return result;
    };
  }, []);

  // Load session messages from API with pagination
  const loadSessionMessages = useCallback(async (projectName, sessionId, loadMore = false, provider = 'claude') => {
    if (!projectName || !sessionId) return [];

    const isInitialLoad = !loadMore;
    if (isInitialLoad) {
      setIsLoadingSessionMessages(true);
    } else {
      setIsLoadingMoreMessages(true);
    }

    try {
      const currentOffset = loadMore ? messagesOffset : 0;
      const response = await api.sessionMessages(projectName, sessionId, MESSAGES_PER_PAGE, currentOffset, provider);
      if (!response.ok) {
        throw new Error('Failed to load session messages');
      }
      const data = await response.json();

      // Extract token usage if present (Codex includes it in messages response)
      if (isInitialLoad && data.tokenUsage) {
        setTokenBudget(data.tokenUsage);
      }

      // Handle paginated response
      if (data.hasMore !== undefined) {
        setHasMoreMessages(data.hasMore);
        setTotalMessages(data.total);
        setMessagesOffset(currentOffset + (data.messages?.length || 0));
        return data.messages || [];
      } else {
        // Backward compatibility for non-paginated response
        const messages = data.messages || [];
        setHasMoreMessages(false);
        setTotalMessages(messages.length);
        return messages;
      }
    } catch (error) {
      console.error('Error loading session messages:', error);
      // Only reset loading state on error - success case will be handled after chatMessages updates
      if (isInitialLoad) {
        setIsLoadingSessionMessages(false);
      }
      return [];
    } finally {
      if (!isInitialLoad) {
        setIsLoadingMoreMessages(false);
      }
    }
  }, [messagesOffset]);

  // Load Cursor session messages from SQLite via backend
  const loadCursorSessionMessages = useCallback(async (projectPath, sessionId) => {
    if (!projectPath || !sessionId) return [];
    setIsLoadingSessionMessages(true);
    try {
      const url = `/api/cursor/sessions/${encodeURIComponent(sessionId)}?projectPath=${encodeURIComponent(projectPath)}`;
      const res = await authenticatedFetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      const blobs = data?.session?.messages || [];
      const converted = [];
      const toolUseMap = {}; // Map to store tool uses by ID for linking results
      
      // First pass: process all messages maintaining order
      for (let blobIdx = 0; blobIdx < blobs.length; blobIdx++) {
        const blob = blobs[blobIdx];
        const content = blob.content;
        let text = '';
        let role = 'assistant';
        let reasoningText = null; // Move to outer scope
        try {
          // Handle different Cursor message formats
          if (content?.role && content?.content) {
            // Direct format: {"role":"user","content":[{"type":"text","text":"..."}]}
            // Skip system messages
            if (content.role === 'system') {
              continue;
            }
            
            // Handle tool messages
            if (content.role === 'tool') {
              // Tool result format - find the matching tool use message and update it
              if (Array.isArray(content.content)) {
                for (const item of content.content) {
                  if (item?.type === 'tool-result') {
                    // Map ApplyPatch to Edit for consistency
                    let toolName = item.toolName || 'Unknown Tool';
                    if (toolName === 'ApplyPatch') {
                      toolName = 'Edit';
                    }
                    const toolCallId = item.toolCallId || content.id;
                    const result = item.result || '';
                    
                    // Store the tool result to be linked later
                    if (toolUseMap[toolCallId]) {
                      toolUseMap[toolCallId].toolResult = {
                        content: result,
                        isError: false
                      };
                    } else {
                      // No matching tool use found, create a standalone result message
                      converted.push({
                        type: 'assistant',
                        content: '',
                        timestamp: new Date(Date.now() + blobIdx * 1000),
                        blobId: blob.id,
                        sequence: blob.sequence,
                        rowid: blob.rowid,
                        isToolUse: true,
                        toolName: toolName,
                        toolId: toolCallId,
                        toolInput: null,
                        toolResult: {
                          content: result,
                          isError: false
                        }
                      });
                    }
                  }
                }
              }
              continue; // Don't add tool messages as regular messages
            } else {
              // User or assistant messages
              role = content.role === 'user' ? 'user' : 'assistant';
              
              if (Array.isArray(content.content)) {
                // Extract text, reasoning, and tool calls from content array
                const textParts = [];
                
                for (const part of content.content) {
                  if (part?.type === 'text' && part?.text) {
                    textParts.push(decodeHtmlEntities(part.text));
                  } else if (part?.type === 'reasoning' && part?.text) {
                    // Handle reasoning type - will be displayed in a collapsible section
                    reasoningText = decodeHtmlEntities(part.text);
                  } else if (part?.type === 'tool-call') {
                    // First, add any text/reasoning we've collected so far as a message
                    if (textParts.length > 0 || reasoningText) {
                      converted.push({
                        type: role,
                        content: textParts.join('\n'),
                        reasoning: reasoningText,
                        timestamp: new Date(Date.now() + blobIdx * 1000),
                        blobId: blob.id,
                        sequence: blob.sequence,
                        rowid: blob.rowid
                      });
                      textParts.length = 0;
                      reasoningText = null;
                    }
                    
                    // Tool call in assistant message - format like Claude Code
                    // Map ApplyPatch to Edit for consistency with Claude Code
                    let toolName = part.toolName || 'Unknown Tool';
                    if (toolName === 'ApplyPatch') {
                      toolName = 'Edit';
                    }
                    const toolId = part.toolCallId || `tool_${blobIdx}`;
                    
                    // Create a tool use message with Claude Code format
                    // Map Cursor args format to Claude Code format
                    let toolInput = part.args;
                    
                    if (toolName === 'Edit' && part.args) {
                      // ApplyPatch uses 'patch' format, convert to Edit format
                      if (part.args.patch) {
                        // Parse the patch to extract old and new content
                        const patchLines = part.args.patch.split('\n');
                        let oldLines = [];
                        let newLines = [];
                        let inPatch = false;
                        
                        for (const line of patchLines) {
                          if (line.startsWith('@@')) {
                            inPatch = true;
                          } else if (inPatch) {
                            if (line.startsWith('-')) {
                              oldLines.push(line.substring(1));
                            } else if (line.startsWith('+')) {
                              newLines.push(line.substring(1));
                            } else if (line.startsWith(' ')) {
                              // Context line - add to both
                              oldLines.push(line.substring(1));
                              newLines.push(line.substring(1));
                            }
                          }
                        }
                        
                        const filePath = part.args.file_path;
                        const absolutePath = filePath && !filePath.startsWith('/') 
                          ? `${projectPath}/${filePath}` 
                          : filePath;
                        toolInput = {
                          file_path: absolutePath,
                          old_string: oldLines.join('\n') || part.args.patch,
                          new_string: newLines.join('\n') || part.args.patch
                        };
                      } else {
                        // Direct edit format
                        toolInput = part.args;
                      }
                    } else if (toolName === 'Read' && part.args) {
                      // Map 'path' to 'file_path'
                      // Convert relative path to absolute if needed
                      const filePath = part.args.path || part.args.file_path;
                      const absolutePath = filePath && !filePath.startsWith('/') 
                        ? `${projectPath}/${filePath}` 
                        : filePath;
                      toolInput = {
                        file_path: absolutePath
                      };
                    } else if (toolName === 'Write' && part.args) {
                      // Map fields for Write tool
                      const filePath = part.args.path || part.args.file_path;
                      const absolutePath = filePath && !filePath.startsWith('/') 
                        ? `${projectPath}/${filePath}` 
                        : filePath;
                      toolInput = {
                        file_path: absolutePath,
                        content: part.args.contents || part.args.content
                      };
                    }
                    
                    const toolMessage = {
                      type: 'assistant',
                      content: '',
                      timestamp: new Date(Date.now() + blobIdx * 1000),
                      blobId: blob.id,
                      sequence: blob.sequence,
                      rowid: blob.rowid,
                      isToolUse: true,
                      toolName: toolName,
                      toolId: toolId,
                      toolInput: toolInput ? JSON.stringify(toolInput) : null,
                      toolResult: null // Will be filled when we get the tool result
                    };
                    converted.push(toolMessage);
                    toolUseMap[toolId] = toolMessage; // Store for linking results
                  } else if (part?.type === 'tool_use') {
                    // Old format support
                    if (textParts.length > 0 || reasoningText) {
                      converted.push({
                        type: role,
                        content: textParts.join('\n'),
                        reasoning: reasoningText,
                        timestamp: new Date(Date.now() + blobIdx * 1000),
                        blobId: blob.id,
                        sequence: blob.sequence,
                        rowid: blob.rowid
                      });
                      textParts.length = 0;
                      reasoningText = null;
                    }
                    
                    const toolName = part.name || 'Unknown Tool';
                    const toolId = part.id || `tool_${blobIdx}`;
                    
                    const toolMessage = {
                      type: 'assistant',
                      content: '',
                      timestamp: new Date(Date.now() + blobIdx * 1000),
                      blobId: blob.id,
                      sequence: blob.sequence,
                      rowid: blob.rowid,
                      isToolUse: true,
                      toolName: toolName,
                      toolId: toolId,
                      toolInput: part.input ? JSON.stringify(part.input) : null,
                      toolResult: null
                    };
                    converted.push(toolMessage);
                    toolUseMap[toolId] = toolMessage;
                  } else if (typeof part === 'string') {
                    textParts.push(part);
                  }
                }
                
                // Add any remaining text/reasoning
                if (textParts.length > 0) {
                  text = textParts.join('\n');
                  if (reasoningText && !text) {
                    // Just reasoning, no text
                    converted.push({
                      type: role,
                      content: '',
                      reasoning: reasoningText,
                      timestamp: new Date(Date.now() + blobIdx * 1000),
                      blobId: blob.id,
                      sequence: blob.sequence,
                      rowid: blob.rowid
                    });
                    text = ''; // Clear to avoid duplicate
                  }
                } else {
                  text = '';
                }
              } else if (typeof content.content === 'string') {
                text = content.content;
              }
            }
          } else if (content?.message?.role && content?.message?.content) {
            // Nested message format
            if (content.message.role === 'system') {
              continue;
            }
            role = content.message.role === 'user' ? 'user' : 'assistant';
            if (Array.isArray(content.message.content)) {
              text = content.message.content
                .map(p => (typeof p === 'string' ? p : (p?.text || '')))
                .filter(Boolean)
                .join('\n');
            } else if (typeof content.message.content === 'string') {
              text = content.message.content;
            }
          }
        } catch (e) {
          console.log('Error parsing blob content:', e);
        }
        if (text && text.trim()) {
          const message = {
            type: role,
            content: text,
            timestamp: new Date(Date.now() + blobIdx * 1000),
            blobId: blob.id,
            sequence: blob.sequence,
            rowid: blob.rowid
          };
          
          // Add reasoning if we have it
          if (reasoningText) {
            message.reasoning = reasoningText;
          }
          
          converted.push(message);
        }
      }
      
      // Sort messages by sequence/rowid to maintain chronological order
      converted.sort((a, b) => {
        // First sort by sequence if available (clean 1,2,3... numbering)
        if (a.sequence !== undefined && b.sequence !== undefined) {
          return a.sequence - b.sequence;
        }
        // Then try rowid (original SQLite row IDs)
        if (a.rowid !== undefined && b.rowid !== undefined) {
          return a.rowid - b.rowid;
        }
        // Fallback to timestamp
        return new Date(a.timestamp) - new Date(b.timestamp);
      });
      
      return converted;
    } catch (e) {
      console.error('Error loading Cursor session messages:', e);
      setIsLoadingSessionMessages(false);
      return [];
    }
    // Note: Don't reset loading state here - it will be reset after setChatMessages in the caller
  }, []);

  // Actual diff calculation function
  const calculateDiff = (oldStr, newStr) => {
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    
    // Simple diff algorithm - find common lines and differences
    const diffLines = [];
    let oldIndex = 0;
    let newIndex = 0;
    
    while (oldIndex < oldLines.length || newIndex < newLines.length) {
      const oldLine = oldLines[oldIndex];
      const newLine = newLines[newIndex];
      
      if (oldIndex >= oldLines.length) {
        // Only new lines remaining
        diffLines.push({ type: 'added', content: newLine, lineNum: newIndex + 1 });
        newIndex++;
      } else if (newIndex >= newLines.length) {
        // Only old lines remaining
        diffLines.push({ type: 'removed', content: oldLine, lineNum: oldIndex + 1 });
        oldIndex++;
      } else if (oldLine === newLine) {
        // Lines are the same - skip in diff view (or show as context)
        oldIndex++;
        newIndex++;
      } else {
        // Lines are different
        diffLines.push({ type: 'removed', content: oldLine, lineNum: oldIndex + 1 });
        diffLines.push({ type: 'added', content: newLine, lineNum: newIndex + 1 });
        oldIndex++;
        newIndex++;
      }
    }
    
    return diffLines;
  };

  // Generate a stable unique ID for a message
  const generateMessageId = (msg, index, timestamp) => {
    // Cursor messages have rowid
    if (msg.rowid) return `cursor-${msg.rowid}`;
    if (msg.blobId) return `cursor-blob-${msg.blobId}`;
    // Use timestamp + type + toolCallId combination for Claude/Codex
    const ts = timestamp || msg.timestamp || Date.now();
    const type = msg.type || msg.message?.role || 'unknown';
    const toolId = msg.toolCallId || msg.toolId || '';
    return `msg-${ts}-${type}-${toolId}-${index}`;
  };

  const convertSessionMessages = (rawMessages) => {
    const converted = [];
    const toolResults = new Map(); // Map tool_use_id to tool result
    
    // First pass: collect all tool results
    for (const msg of rawMessages) {
      if (msg.message?.role === 'user' && Array.isArray(msg.message?.content)) {
        for (const part of msg.message.content) {
          if (part.type === 'tool_result') {
            toolResults.set(part.tool_use_id, {
              content: part.content,
              isError: part.is_error,
              timestamp: new Date(msg.timestamp || Date.now()),
              // Extract structured tool result data (e.g., for Grep, Glob)
              toolUseResult: msg.toolUseResult || null
            });
          }
        }
      }
    }
    
    // Second pass: process messages and attach tool results to tool uses
    for (const msg of rawMessages) {
      // Handle user messages
      if (msg.message?.role === 'user' && msg.message?.content) {
        let content = '';
        let messageType = 'user';
        
        if (Array.isArray(msg.message.content)) {
          // Handle array content, but skip tool results (they're attached to tool uses)
          const textParts = [];
          
          for (const part of msg.message.content) {
            if (part.type === 'text') {
              textParts.push(decodeHtmlEntities(part.text));
            }
            // Skip tool_result parts - they're handled in the first pass
          }
          
          content = textParts.join('\n');
        } else if (typeof msg.message.content === 'string') {
          content = decodeHtmlEntities(msg.message.content);
        } else {
          content = decodeHtmlEntities(String(msg.message.content));
        }
        
        // Skip command messages, system messages, and empty content
        const shouldSkip = !content ||
                          content.startsWith('<command-name>') ||
                          content.startsWith('<command-message>') ||
                          content.startsWith('<command-args>') ||
                          content.startsWith('<local-command-stdout>') ||
                          content.startsWith('<system-reminder>') ||
                          content.startsWith('Caveat:') ||
                          content.startsWith('This session is being continued from a previous') ||
                          content.startsWith('[Request interrupted');

        if (!shouldSkip) {
          // Unescape with math formula protection
          content = unescapeWithMathProtection(content);
          const timestamp = msg.timestamp || new Date().toISOString();
          converted.push({
            id: generateMessageId(msg, converted.length, timestamp),
            type: messageType,
            content: content,
            timestamp: timestamp
          });
        }
      }

      // Handle thinking messages (Codex reasoning)
      else if (msg.type === 'thinking' && msg.message?.content) {
        const timestamp = msg.timestamp || new Date().toISOString();
        converted.push({
          id: generateMessageId(msg, converted.length, timestamp),
          type: 'assistant',
          content: unescapeWithMathProtection(msg.message.content),
          timestamp: timestamp,
          isThinking: true
        });
      }

      // Handle tool_use messages (Codex function calls)
      else if (msg.type === 'tool_use' && msg.toolName) {
        const timestamp = msg.timestamp || new Date().toISOString();
        converted.push({
          id: generateMessageId(msg, converted.length, timestamp),
          type: 'assistant',
          content: '',
          timestamp: timestamp,
          isToolUse: true,
          toolName: msg.toolName,
          toolInput: msg.toolInput || '',
          toolCallId: msg.toolCallId
        });
      }

      // Handle tool_result messages (Codex function outputs)
      else if (msg.type === 'tool_result') {
        // Find the matching tool_use by callId, or the last tool_use without a result
        for (let i = converted.length - 1; i >= 0; i--) {
          if (converted[i].isToolUse && !converted[i].toolResult) {
            if (!msg.toolCallId || converted[i].toolCallId === msg.toolCallId) {
              converted[i].toolResult = {
                content: msg.output || '',
                isError: false
              };
              break;
            }
          }
        }
      }

      // Handle assistant messages
      else if (msg.message?.role === 'assistant' && msg.message?.content) {
        if (Array.isArray(msg.message.content)) {
          for (const part of msg.message.content) {
            if (part.type === 'text') {
              // Unescape with math formula protection
              let text = part.text;
              if (typeof text === 'string') {
                text = unescapeWithMathProtection(text);
              }
              const timestamp = msg.timestamp || new Date().toISOString();
              converted.push({
                id: generateMessageId(msg, converted.length, timestamp),
                type: 'assistant',
                content: text,
                timestamp: timestamp
              });
            } else if (part.type === 'tool_use') {
              // Get the corresponding tool result
              const toolResult = toolResults.get(part.id);
              const timestamp = msg.timestamp || new Date().toISOString();

              converted.push({
                id: `tool-${part.id || converted.length}-${timestamp}`,
                type: 'assistant',
                content: '',
                timestamp: timestamp,
                isToolUse: true,
                toolName: part.name,
                toolInput: JSON.stringify(part.input),
                toolResult: toolResult ? {
                  content: typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content),
                  isError: toolResult.isError,
                  toolUseResult: toolResult.toolUseResult
                } : null,
                toolError: toolResult?.isError || false,
                toolResultTimestamp: toolResult?.timestamp || new Date()
              });
            }
          }
        } else if (typeof msg.message.content === 'string') {
          // Unescape with math formula protection
          let text = msg.message.content;
          text = unescapeWithMathProtection(text);
          const timestamp = msg.timestamp || new Date().toISOString();
          converted.push({
            id: generateMessageId(msg, converted.length, timestamp),
            type: 'assistant',
            content: text,
            timestamp: timestamp
          });
        }
      }
    }

    return converted;
  };

  // Memoize expensive convertSessionMessages operation
  const convertedMessages = useMemo(() => {
    return convertSessionMessages(sessionMessages);
  }, [sessionMessages]);

  // Note: Token budgets are not saved to JSONL files, only sent via WebSocket
  // So we don't try to extract them from loaded sessionMessages

  // Define scroll functions early to avoid hoisting issues in useEffect dependencies
  const scrollToBottom = useCallback(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      // Don't reset isUserScrolledUp here - let the scroll handler manage it
      // This prevents fighting with user's scroll position during streaming
    }
  }, []);

  // Check if user is near the bottom of the scroll container
  const isNearBottom = useCallback(() => {
    if (!scrollContainerRef.current) return false;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    // Consider "near bottom" if within 50px of the bottom
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const loadOlderMessages = useCallback(async (container) => {
    if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
    if (!hasMoreMessages || !selectedSession || !selectedProject) return false;

    const sessionProvider = selectedSession.__provider || 'claude';
    if (sessionProvider === 'cursor') return false;

    isLoadingMoreRef.current = true;
    const previousScrollHeight = container.scrollHeight;
    const previousScrollTop = container.scrollTop;

    try {
      const moreMessages = await loadSessionMessages(
        selectedProject.name,
        selectedSession.id,
        true,
        sessionProvider
      );

      if (moreMessages.length > 0) {
        pendingScrollRestoreRef.current = {
          height: previousScrollHeight,
          top: previousScrollTop
        };
        // Prepend new messages to the existing ones
        setSessionMessages(prev => [...moreMessages, ...prev]);
        // Also update chatMessages directly
        const convertedMore = convertSessionMessages(moreMessages);
        setChatMessages(prev => [...convertedMore, ...prev]);
      }
      return true;
    } finally {
      isLoadingMoreRef.current = false;
    }
  }, [hasMoreMessages, isLoadingMoreMessages, selectedSession, selectedProject, loadSessionMessages]);

  // Handle scroll events to detect when user manually scrolls up and load more messages
  const handleScroll = useCallback(async () => {
    if (scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const nearBottom = isNearBottom();
      setIsUserScrolledUp(!nearBottom);

      // Check if we should load more messages (scrolled near top)
      const scrolledNearTop = container.scrollTop < 100;
      if (!scrolledNearTop) {
        topLoadLockRef.current = false;
      } else if (!topLoadLockRef.current) {
        const didLoad = await loadOlderMessages(container);
        if (didLoad) {
          topLoadLockRef.current = true;
          // Auto-unlock after a short delay to allow subsequent loads
          setTimeout(() => {
            topLoadLockRef.current = false;
          }, 500);
        }
      }
    }
  }, [isNearBottom, loadOlderMessages]);

  // Auto-load more messages if container is not scrollable but has more messages
  useEffect(() => {
    if (!hasMoreMessages || isLoadingMoreMessages || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    const isScrollable = container.scrollHeight > container.clientHeight;

    // If container is not scrollable and we have more messages, load them automatically
    if (!isScrollable && hasMoreMessages) {
      // Small delay to avoid rapid consecutive loads
      const timer = setTimeout(() => {
        loadOlderMessages(container);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [hasMoreMessages, isLoadingMoreMessages, chatMessages.length, loadOlderMessages]);

  // Restore scroll position after paginated messages render
  useLayoutEffect(() => {
    if (!pendingScrollRestoreRef.current || !scrollContainerRef.current) return;

    const { height, top } = pendingScrollRestoreRef.current;
    const container = scrollContainerRef.current;
    const newScrollHeight = container.scrollHeight;
    const scrollDiff = newScrollHeight - height;

    container.scrollTop = top + Math.max(scrollDiff, 0);
    pendingScrollRestoreRef.current = null;
  }, [chatMessages.length]);

  useEffect(() => {
    // Race condition prevention: Track if this effect has been superseded
    // When session changes rapidly, old requests should be ignored
    let cancelled = false;

    // Load session messages when session changes
    // NEW: Cache-first loading strategy for instant display
    const loadMessages = async () => {
      if (selectedSession && selectedProject) {
        const provider = localStorage.getItem('selected-provider') || 'claude';

        // Mark that we're loading a session to prevent multiple scroll triggers
        isLoadingSessionRef.current = true;

        // Only reset state if the session ID actually changed (not initial load)
        const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSession.id;

        if (sessionChanged) {
          if (!isSystemSessionChange) {
            // Clear any streaming leftovers from the previous session
            resetStreamingState();
            pendingViewSessionRef.current = null;
            setChatMessages([]);
            setSessionMessages([]);
            setClaudeStatus(null);
            setCanAbortSession(false);
          }
          // Reset pagination state when switching sessions
          setMessagesOffset(0);
          setHasMoreMessages(false);
          setTotalMessages(0);
          // Reset token budget when switching sessions
          // It will update when user sends a message and receives new budget from WebSocket
          setTokenBudget(null);
          // Reset loading state when switching sessions (unless the new session is processing)
          // The restore effect will set it back to true if needed
          setIsLoading(false);

          // Check if the session is currently processing on the backend
          if (ws && sendMessage) {
            sendMessage({
              type: 'check-session-status',
              sessionId: selectedSession.id,
              provider
            });
          }
        } else if (currentSessionId === null) {
          // Initial load - reset pagination but not token budget
          setMessagesOffset(0);
          setHasMoreMessages(false);
          setTotalMessages(0);

          // Check if the session is currently processing on the backend
          if (ws && sendMessage) {
            sendMessage({
              type: 'check-session-status',
              sessionId: selectedSession.id,
              provider
            });
          }
        }

        if (provider === 'cursor') {
          // For Cursor, set the session ID for resuming
          setCurrentSessionId(selectedSession.id);
          sessionStorage.setItem('cursorSessionId', selectedSession.id);

          // Only load messages from SQLite if this is NOT a system-initiated session change
          // For system-initiated changes, preserve existing messages
          if (!isSystemSessionChange) {
            // Load historical messages for Cursor session from SQLite
            const projectPath = selectedProject.fullPath || selectedProject.path;
            const converted = await loadCursorSessionMessages(projectPath, selectedSession.id);
            // Race condition check: ignore stale response if session changed during fetch
            if (cancelled) return;
            setSessionMessages([]);
            setChatMessages(converted);
            // Reset loading state after chatMessages is set
            setIsLoadingSessionMessages(false);
          } else {
            // Reset the flag after handling system session change
            setIsSystemSessionChange(false);
          }
        } else if (provider === 'codex') {
          // For Codex, load messages normally (no caching for now)
          setCurrentSessionId(selectedSession.id);

          if (!isSystemSessionChange) {
            const messages = await loadSessionMessages(selectedProject.name, selectedSession.id, false, 'codex');
            if (cancelled) return;
            setSessionMessages(messages);
            const converted = convertSessionMessages(messages);
            setChatMessages(converted);
            setIsLoadingSessionMessages(false);
            setTimeout(() => scrollToBottom(), 100);
          } else {
            setIsSystemSessionChange(false);
          }
        } else {
          // For Claude: use cache-first loading strategy
          setCurrentSessionId(selectedSession.id);

          // Only load messages from API if this is a user-initiated session change
          // For system-initiated changes, preserve existing messages and rely on WebSocket
          if (!isSystemSessionChange) {
            // STEP 1: Try to load from IndexedDB cache (instant display)
            let cachedMessages = [];
            let lastSyncTimestamp = 0;

            try {
              // Initialize cache if needed
              await messageCache.init();

              // Load cached messages
              const cachedRecords = await messageCache.getMessages(selectedSession.id);
              if (cachedRecords.length > 0) {
                // Convert cached rawData back to messages
                cachedMessages = cachedRecords.map(r => r.rawData);
                const converted = convertSessionMessages(cachedMessages);

                // Race condition check
                if (cancelled) return;

                // Instant display from cache
                setSessionMessages(cachedMessages);
                setChatMessages(converted);
                setIsLoadingSessionMessages(false);

                // Scroll to bottom after cache display - use requestAnimationFrame for proper timing
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    scrollToBottom();
                  });
                });

                console.log(`[MessageCache] Loaded ${cachedMessages.length} messages from cache for session ${selectedSession.id}`);
              }

              // Get last sync timestamp
              const syncState = await messageCache.getSyncState(selectedSession.id);
              if (syncState) {
                lastSyncTimestamp = syncState.lastSyncTimestamp;
              }
            } catch (cacheError) {
              console.warn('[MessageCache] Error loading from cache:', cacheError);
              // Continue with API fallback
            }

            // STEP 2: Sync new messages from server in background
            try {
              const syncResponse = await api.syncMessages(selectedProject.name, selectedSession.id, lastSyncTimestamp);

              if (cancelled) return;

              if (syncResponse.ok) {
                const syncData = await syncResponse.json();
                const newMessages = syncData.messages || [];

                if (newMessages.length > 0) {
                  console.log(`[MessageCache] Syncing ${newMessages.length} new messages from server`);

                  // Save new messages to cache
                  await messageCache.saveMessages(newMessages, selectedSession.id, selectedProject.name);

                  // Update sync state
                  await messageCache.updateSyncState(
                    selectedSession.id,
                    syncData.serverTimestamp,
                    syncData.total
                  );

                  // Convert and append new messages
                  const newConverted = convertSessionMessages(newMessages);

                  if (cachedMessages.length > 0) {
                    // Append to existing cached messages
                    setSessionMessages(prev => [...prev, ...newMessages]);
                    setChatMessages(prev => [...prev, ...newConverted]);
                  } else {
                    // No cache, set all messages
                    setSessionMessages(newMessages);
                    setChatMessages(newConverted);
                  }

                  // Update pagination state
                  setTotalMessages(syncData.total);
                  setHasMoreMessages(false); // sync returns all new messages

                  // Scroll to bottom after appending new messages
                  setTimeout(() => scrollToBottom(), 100);

                } else if (cachedMessages.length === 0) {
                  // No cache and no new messages - try full load as fallback
                  const messages = await loadSessionMessages(selectedProject.name, selectedSession.id, false, selectedSession.__provider || 'claude');
                  if (cancelled) return;

                  setSessionMessages(messages);
                  const converted = convertSessionMessages(messages);
                  setChatMessages(converted);

                  // Save to cache for next time
                  if (messages.length > 0) {
                    await messageCache.saveMessages(messages, selectedSession.id, selectedProject.name);
                    await messageCache.updateSyncState(selectedSession.id, Date.now(), messages.length);
                  }

                  // Scroll to bottom for fresh load
                  setTimeout(() => scrollToBottom(), 100);
                }
                // else: cachedMessages already displayed and scrolled, no need to scroll again

                setIsLoadingSessionMessages(false);
              } else {
                // Sync failed - fall back to traditional loading if no cache
                if (cachedMessages.length === 0) {
                  const messages = await loadSessionMessages(selectedProject.name, selectedSession.id, false, selectedSession.__provider || 'claude');
                  if (cancelled) return;
                  setSessionMessages(messages);
                  const converted = convertSessionMessages(messages);
                  setChatMessages(converted);
                  // Scroll to bottom for fresh load
                  setTimeout(() => scrollToBottom(), 100);
                }
                setIsLoadingSessionMessages(false);
              }
            } catch (syncError) {
              console.warn('[MessageCache] Sync error:', syncError);
              // If we have cached messages, keep showing them
              // If not, fall back to traditional loading
              if (cachedMessages.length === 0) {
                const messages = await loadSessionMessages(selectedProject.name, selectedSession.id, false, selectedSession.__provider || 'claude');
                if (cancelled) return;
                setSessionMessages(messages);
                const converted = convertSessionMessages(messages);
                setChatMessages(converted);
                // Scroll to bottom for fresh load
                setTimeout(() => scrollToBottom(), 100);
              }
              setIsLoadingSessionMessages(false);
            }
          } else {
            // Reset the flag after handling system session change
            setIsSystemSessionChange(false);
          }
        }
      } else {
        // New session view (no selected session) - always reset UI state
        if (!isSystemSessionChange) {
          resetStreamingState();
          pendingViewSessionRef.current = null;
          setChatMessages([]);
          setSessionMessages([]);
          setClaudeStatus(null);
          setCanAbortSession(false);
          setIsLoading(false);
        }
        setCurrentSessionId(null);
        sessionStorage.removeItem('cursorSessionId');
        setMessagesOffset(0);
        setHasMoreMessages(false);
        setTotalMessages(0);
        setTokenBudget(null);
      }

      // Mark loading as complete after messages are set
      // Use setTimeout to ensure state updates and DOM rendering are complete
      setTimeout(() => {
        isLoadingSessionRef.current = false;
      }, 250);
    };

    loadMessages();

    // Cleanup: mark as cancelled so stale async responses are ignored
    return () => {
      cancelled = true;
    };
  }, [selectedSession, selectedProject, loadCursorSessionMessages, scrollToBottom, isSystemSessionChange, resetStreamingState]);

  // External Message Update Handler: Incrementally append new messages when external CLI modifies current session
  // This triggers when App.jsx detects a JSONL file change for the currently-viewed session
  // Only appends new messages instead of reloading the entire list - no DOM disruption
  // NEW: Also saves to IndexedDB cache for offline access
  useEffect(() => {
    if (externalMessageUpdate > 0 && selectedSession && selectedProject) {
      const appendNewMessages = async () => {
        try {
          const provider = localStorage.getItem('selected-provider') || 'claude';

          if (provider === 'cursor') {
            // Cursor still needs full reload (SQLite-based)
            const projectPath = selectedProject.fullPath || selectedProject.path;
            const converted = await loadCursorSessionMessages(projectPath, selectedSession.id);
            setSessionMessages([]);
            setChatMessages(converted);
          } else if (provider === 'codex') {
            // Codex uses count-based incremental update
            const currentCount = sessionMessages.length;
            const response = await api.newSessionMessages(selectedProject.name, selectedSession.id, currentCount);

            if (response.ok) {
              const data = await response.json();
              const newRawMessages = data.messages || [];

              if (newRawMessages.length > 0) {
                const newConverted = convertSessionMessages(newRawMessages);
                setSessionMessages(prev => [...prev, ...newRawMessages]);
                setChatMessages(prev => [...prev, ...newConverted]);

                if (isNearBottom()) {
                  requestAnimationFrame(() => {
                    scrollContainerRef.current?.scrollTo({
                      top: scrollContainerRef.current.scrollHeight,
                      behavior: 'smooth'
                    });
                  });
                }
              }
            }
          } else {
            // Claude: Use timestamp-based sync API with caching
            // Get the last sync timestamp from cache
            let lastSyncTimestamp = 0;
            try {
              const syncState = await messageCache.getSyncState(selectedSession.id);
              if (syncState) {
                lastSyncTimestamp = syncState.lastSyncTimestamp;
              }
            } catch (cacheError) {
              console.warn('[MessageCache] Error getting sync state:', cacheError);
            }

            // Fetch new messages since last sync
            const response = await api.syncMessages(selectedProject.name, selectedSession.id, lastSyncTimestamp);

            if (response.ok) {
              const data = await response.json();
              const newRawMessages = data.messages || [];

              if (newRawMessages.length > 0) {
                // Convert only the new messages and append directly to chatMessages
                const newConverted = convertSessionMessages(newRawMessages);

                // Update sessionMessages for consistency
                setSessionMessages(prev => [...prev, ...newRawMessages]);

                // Directly append to chatMessages - this is the key to avoiding re-render of existing messages
                setChatMessages(prev => [...prev, ...newConverted]);

                // Save new messages to cache
                try {
                  await messageCache.saveMessages(newRawMessages, selectedSession.id, selectedProject.name);
                  await messageCache.updateSyncState(selectedSession.id, data.serverTimestamp, data.total);
                  console.log(`[MessageCache] Cached ${newRawMessages.length} new messages from external update`);
                } catch (cacheError) {
                  console.warn('[MessageCache] Error saving to cache:', cacheError);
                }

                // Smart scroll: only auto-scroll if user is near bottom
                if (isNearBottom()) {
                  requestAnimationFrame(() => {
                    scrollContainerRef.current?.scrollTo({
                      top: scrollContainerRef.current.scrollHeight,
                      behavior: 'smooth'
                    });
                  });
                }
              }
              // If no new messages, nothing to do - user's view is unchanged
            }
          }
        } catch (error) {
          console.error('Error appending messages from external update:', error);
        }
      };

      appendNewMessages();
    }
  }, [externalMessageUpdate, selectedSession, selectedProject, loadCursorSessionMessages, sessionMessages.length, isNearBottom]);

  // When the user navigates to a specific session, clear any pending "new session" marker.
  useEffect(() => {
    if (selectedSession?.id) {
      pendingViewSessionRef.current = null;
    }
  }, [selectedSession?.id]);

  // NOTE: chatMessages is now set directly in:
  // 1. Session loading (above) - for initial load
  // 2. External message update handler - for incremental updates
  // 3. WebSocket message handlers - for real-time streaming
  // No longer relying on sessionMessages -> convertedMessages -> chatMessages chain for updates

  // Notify parent when input focus changes
  useEffect(() => {
    if (onInputFocusChange) {
      onInputFocusChange(isInputFocused);
    }
  }, [isInputFocused, onInputFocusChange]);

  // Persist input draft to localStorage
  useEffect(() => {
    if (selectedProject && input !== '') {
      safeLocalStorage.setItem(`draft_input_${selectedProject.name}`, input);
    } else if (selectedProject && input === '') {
      safeLocalStorage.removeItem(`draft_input_${selectedProject.name}`);
    }
  }, [input, selectedProject]);

  // Persist chat messages to localStorage
  useEffect(() => {
    if (selectedProject && chatMessages.length > 0) {
      safeLocalStorage.setItem(`chat_messages_${selectedProject.name}`, JSON.stringify(chatMessages));
    }
  }, [chatMessages, selectedProject]);

  // Load saved state when project changes (but don't interfere with session loading)
  useEffect(() => {
    if (selectedProject) {
      // Always load saved input draft for the project
      const savedInput = safeLocalStorage.getItem(`draft_input_${selectedProject.name}`) || '';
      if (savedInput !== input) {
        setInput(savedInput);
      }
    }
  }, [selectedProject?.name]);

  // Track processing state: notify parent when isLoading becomes true
  // Note: onSessionNotProcessing is called directly in completion message handlers
  useEffect(() => {
    if (currentSessionId && isLoading && onSessionProcessing) {
      onSessionProcessing(currentSessionId);
    }
  }, [isLoading, currentSessionId, onSessionProcessing]);

  // Restore processing state when switching to a processing session
  useEffect(() => {
    if (currentSessionId && processingSessions) {
      const shouldBeProcessing = processingSessions.has(currentSessionId);
      if (shouldBeProcessing && !isLoading) {
        setIsLoading(true);
        setCanAbortSession(true); // Assume processing sessions can be aborted
      }
    }
  }, [currentSessionId, processingSessions]);

  useEffect(() => {
    // Handle WebSocket messages
    if (latestMessage) {
      const messageData = latestMessage.data?.message || latestMessage.data;

      // Filter messages by session ID to prevent cross-session interference
      // Skip filtering for global messages that apply to all sessions
      const globalMessageTypes = ['projects_updated', 'taskmaster-project-updated', 'session-created', 'task-complete-notification'];
      const isGlobalMessage = globalMessageTypes.includes(latestMessage.type);
      const lifecycleMessageTypes = new Set([
        'claude-complete',
        'codex-complete',
        'cursor-result',
        'session-aborted',
        'claude-error',
        'cursor-error',
        'codex-error'
      ]);

      const isClaudeSystemInit = latestMessage.type === 'claude-response' &&
        messageData &&
        messageData.type === 'system' &&
        messageData.subtype === 'init';
      const isCursorSystemInit = latestMessage.type === 'cursor-system' &&
        latestMessage.data &&
        latestMessage.data.type === 'system' &&
        latestMessage.data.subtype === 'init';

      const systemInitSessionId = isClaudeSystemInit
        ? messageData?.session_id
        : isCursorSystemInit
          ? latestMessage.data?.session_id
          : null;

      const activeViewSessionId = selectedSession?.id || currentSessionId || pendingViewSessionRef.current?.sessionId || null;
      const isSystemInitForView = systemInitSessionId && (!activeViewSessionId || systemInitSessionId === activeViewSessionId);
      const shouldBypassSessionFilter = isGlobalMessage || isSystemInitForView;
      const isUnscopedError = !latestMessage.sessionId &&
        pendingViewSessionRef.current &&
        !pendingViewSessionRef.current.sessionId &&
        (latestMessage.type === 'claude-error' || latestMessage.type === 'cursor-error' || latestMessage.type === 'codex-error');

      const handleBackgroundLifecycle = (sessionId) => {
        if (!sessionId) return;
        if (onSessionInactive) {
          onSessionInactive(sessionId);
        }
        if (onSessionNotProcessing) {
          onSessionNotProcessing(sessionId);
        }
      };

      if (!shouldBypassSessionFilter) {
        if (!activeViewSessionId) {
          // No session in view; ignore session-scoped traffic.
          if (latestMessage.sessionId && lifecycleMessageTypes.has(latestMessage.type)) {
            handleBackgroundLifecycle(latestMessage.sessionId);
          }
          if (!isUnscopedError) {
            return;
          }
        }
        if (!latestMessage.sessionId && !isUnscopedError) {
          // Drop unscoped messages to prevent cross-session bleed.
          return;
        }
        if (latestMessage.sessionId !== activeViewSessionId) {
          if (latestMessage.sessionId && lifecycleMessageTypes.has(latestMessage.type)) {
            handleBackgroundLifecycle(latestMessage.sessionId);
          }
          // Message is for a different session, ignore it
          console.log('??-?,? Skipping message for different session:', latestMessage.sessionId, 'current:', activeViewSessionId);
          return;
        }
      }

      switch (latestMessage.type) {
        case 'session-created':
          // New session created by Claude CLI - we receive the real session ID here
          // Store it temporarily until conversation completes (prevents premature session association)
          if (latestMessage.sessionId && !currentSessionId) {
            sessionStorage.setItem('pendingSessionId', latestMessage.sessionId);
            if (pendingViewSessionRef.current && !pendingViewSessionRef.current.sessionId) {
              pendingViewSessionRef.current.sessionId = latestMessage.sessionId;
            }
            
            // Mark as system change to prevent clearing messages when session ID updates
            setIsSystemSessionChange(true);
            
            // Session Protection: Replace temporary "new-session-*" identifier with real session ID
            // This maintains protection continuity - no gap between temp ID and real ID
            // The temporary session is removed and real session is marked as active
            if (onReplaceTemporarySession) {
              onReplaceTemporarySession(latestMessage.sessionId);
            }

            // Attach the real session ID to any pending permission requests so they
            // do not disappear during the "new-session -> real-session" transition.
            // This does not create or auto-approve requests; it only keeps UI state aligned.
            setPendingPermissionRequests(prev => prev.map(req => (
              req.sessionId ? req : { ...req, sessionId: latestMessage.sessionId }
            )));
          }
          break;

        case 'token-budget':
          // Use token budget from WebSocket for active sessions
          if (latestMessage.data) {
            setTokenBudget(latestMessage.data);
          }
          break;

        case 'claude-response':
          
          // Handle Cursor streaming format (content_block_delta / content_block_stop)
          if (messageData && typeof messageData === 'object' && messageData.type) {
            if (messageData.type === 'content_block_delta' && messageData.delta?.text) {
              // Decode HTML entities and buffer deltas
              const decodedText = decodeHtmlEntities(messageData.delta.text);
              streamBufferRef.current += decodedText;
              if (!streamTimerRef.current) {
                streamTimerRef.current = setTimeout(() => {
                  const chunk = streamBufferRef.current;
                  streamBufferRef.current = '';
                  streamTimerRef.current = null;
                  if (!chunk) return;
                  setChatMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last && last.type === 'assistant' && !last.isToolUse && last.isStreaming) {
                      last.content = (last.content || '') + chunk;
                    } else {
                      updated.push({ type: 'assistant', content: chunk, timestamp: new Date(), isStreaming: true });
                    }
                    return updated;
                  });
                }, 100);
              }
              return;
            }
            if (messageData.type === 'content_block_stop') {
              // Flush any buffered text and mark streaming message complete
              if (streamTimerRef.current) {
                clearTimeout(streamTimerRef.current);
                streamTimerRef.current = null;
              }
              const chunk = streamBufferRef.current;
              streamBufferRef.current = '';
              if (chunk) {
                setChatMessages(prev => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last && last.type === 'assistant' && !last.isToolUse && last.isStreaming) {
                    last.content = (last.content || '') + chunk;
                  } else {
                    updated.push({ type: 'assistant', content: chunk, timestamp: new Date(), isStreaming: true });
                  }
                  return updated;
                });
              }
              setChatMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.type === 'assistant' && last.isStreaming) {
                  last.isStreaming = false;
                }
                return updated;
              });
              return;
            }
          }

          // Handle Claude CLI session duplication bug workaround:
          // When resuming a session, Claude CLI creates a new session instead of resuming.
          // We detect this by checking for system/init messages with session_id that differs
          // from our current session. When found, we need to switch the user to the new session.
          // This works exactly like new session detection - preserve messages during navigation.
          if (latestMessage.data.type === 'system' && 
              latestMessage.data.subtype === 'init' && 
              latestMessage.data.session_id && 
              currentSessionId && 
              latestMessage.data.session_id !== currentSessionId &&
              isSystemInitForView) {
            
            console.log('🔄 Claude CLI session duplication detected:', {
              originalSession: currentSessionId,
              newSession: latestMessage.data.session_id
            });
            
            // Mark this as a system-initiated session change to preserve messages
            // This works exactly like new session init - messages stay visible during navigation
            setIsSystemSessionChange(true);
            
            // Switch to the new session using React Router navigation
            // This triggers the session loading logic in App.jsx without a page reload
            navigate(`/session/${latestMessage.data.session_id}`);
            return; // Don't process the message further, let the navigation handle it
          }
          
          // Handle system/init for new sessions (when currentSessionId is null)
          if (latestMessage.data.type === 'system' && 
              latestMessage.data.subtype === 'init' && 
              latestMessage.data.session_id && 
              !currentSessionId &&
              isSystemInitForView) {
            
            console.log('🔄 New session init detected:', {
              newSession: latestMessage.data.session_id
            });
            
            // Mark this as a system-initiated session change to preserve messages
            setIsSystemSessionChange(true);
            
            // Switch to the new session
            navigate(`/session/${latestMessage.data.session_id}`);
            return; // Don't process the message further, let the navigation handle it
          }
          
          // For system/init messages that match current session, just ignore them
          if (latestMessage.data.type === 'system' && 
              latestMessage.data.subtype === 'init' && 
              latestMessage.data.session_id && 
              currentSessionId && 
              latestMessage.data.session_id === currentSessionId &&
              isSystemInitForView) {
            console.log('🔄 System init message for current session, ignoring');
            return; // Don't process the message further
          }
          
          // Handle different types of content in the response
          if (Array.isArray(messageData.content)) {
            for (const part of messageData.content) {
              if (part.type === 'tool_use') {
                // Add tool use message
                const toolInput = part.input ? JSON.stringify(part.input, null, 2) : '';
                setChatMessages(prev => [...prev, {
                  type: 'assistant',
                  content: '',
                  timestamp: new Date(),
                  isToolUse: true,
                  toolName: part.name,
                  toolInput: toolInput,
                  toolId: part.id,
                  toolResult: null // Will be updated when result comes in
                }]);
              } else if (part.type === 'text' && part.text?.trim()) {
                // Decode HTML entities and normalize usage limit message to local time
                let content = decodeHtmlEntities(part.text);
                content = formatUsageLimitText(content);

                // Add regular text message
                setChatMessages(prev => [...prev, {
                  type: 'assistant',
                  content: content,
                  timestamp: new Date()
                }]);
              }
            }
          } else if (typeof messageData.content === 'string' && messageData.content.trim()) {
            // Decode HTML entities and normalize usage limit message to local time
            let content = decodeHtmlEntities(messageData.content);
            content = formatUsageLimitText(content);

            // Add regular text message
            setChatMessages(prev => [...prev, {
              type: 'assistant',
              content: content,
              timestamp: new Date()
            }]);
          }
          
          // Handle tool results from user messages (these come separately)
          if (messageData.role === 'user' && Array.isArray(messageData.content)) {
            for (const part of messageData.content) {
              if (part.type === 'tool_result') {
                // Find the corresponding tool use and update it with the result
                setChatMessages(prev => prev.map(msg => {
                  if (msg.isToolUse && msg.toolId === part.tool_use_id) {
                    return {
                      ...msg,
                      toolResult: {
                        content: part.content,
                        isError: part.is_error,
                        timestamp: new Date()
                      }
                    };
                  }
                  return msg;
                }));
              }
            }
          }
          break;
          
        case 'claude-output':
          {
            const cleaned = String(latestMessage.data || '');
            if (cleaned.trim()) {
              streamBufferRef.current += (streamBufferRef.current ? `\n${cleaned}` : cleaned);
              if (!streamTimerRef.current) {
                streamTimerRef.current = setTimeout(() => {
                  const chunk = streamBufferRef.current;
                  streamBufferRef.current = '';
                  streamTimerRef.current = null;
                  if (!chunk) return;
                  setChatMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last && last.type === 'assistant' && !last.isToolUse && last.isStreaming) {
                      last.content = last.content ? `${last.content}\n${chunk}` : chunk;
                    } else {
                      updated.push({ type: 'assistant', content: chunk, timestamp: new Date(), isStreaming: true });
                    }
                    return updated;
                  });
                }, 100);
              }
            }
          }
          break;
        case 'claude-interactive-prompt':
          // Handle interactive prompts from CLI
          setChatMessages(prev => [...prev, {
            type: 'assistant',
            content: latestMessage.data,
            timestamp: new Date(),
            isInteractivePrompt: true
          }]);
          break;

        case 'claude-permission-request': {
          // Receive a tool approval request from the backend and surface it in the UI.
          // This does not approve anything automatically; it only queues a prompt,
          // introduced so the user can decide before the SDK continues.
          if (provider !== 'claude' || !latestMessage.requestId) {
            break;
          }

          setPendingPermissionRequests(prev => {
            if (prev.some(req => req.requestId === latestMessage.requestId)) {
              return prev;
            }
            return [
              ...prev,
              {
                requestId: latestMessage.requestId,
                toolName: latestMessage.toolName || 'UnknownTool',
                input: latestMessage.input,
                context: latestMessage.context,
                sessionId: latestMessage.sessionId || null,
                receivedAt: new Date()
              }
            ];
          });

          // Keep the session in a "waiting" state while approval is pending.
          // This does not resume the run; it only updates the UI status so the
          // user knows Claude is blocked on a decision.
          setIsLoading(true);
          setCanAbortSession(true);
          setClaudeStatus({
            text: 'Waiting for permission',
            tokens: 0,
            can_interrupt: true
          });
          break;
        }

        case 'claude-permission-cancelled': {
          // Backend cancelled the approval (timeout or SDK cancel); remove the banner.
          // We currently do not show a user-facing warning here; this is intentional
          // to avoid noisy alerts when the SDK cancels in the background.
          if (!latestMessage.requestId) {
            break;
          }
          setPendingPermissionRequests(prev => prev.filter(req => req.requestId !== latestMessage.requestId));
          break;
        }

        case 'claude-error':
          setChatMessages(prev => [...prev, {
            type: 'error',
            content: `Error: ${latestMessage.error}`,
            timestamp: new Date()
          }]);
          break;
          
        case 'cursor-system':
          // Handle Cursor system/init messages similar to Claude
          try {
            const cdata = latestMessage.data;
            if (cdata && cdata.type === 'system' && cdata.subtype === 'init' && cdata.session_id) {
              if (!isSystemInitForView) {
                return;
              }
              // If we already have a session and this differs, switch (duplication/redirect)
              if (currentSessionId && cdata.session_id !== currentSessionId) {
                console.log('🔄 Cursor session switch detected:', { originalSession: currentSessionId, newSession: cdata.session_id });
                setIsSystemSessionChange(true);
                navigate(`/session/${cdata.session_id}`);
                return;
              }
              // If we don't yet have a session, adopt this one
              if (!currentSessionId) {
                console.log('🔄 Cursor new session init detected:', { newSession: cdata.session_id });
                setIsSystemSessionChange(true);
                navigate(`/session/${cdata.session_id}`);
                return;
              }
            }
            // For other cursor-system messages, avoid dumping raw objects to chat
          } catch (e) {
            console.warn('Error handling cursor-system message:', e);
          }
          break;
          
        case 'cursor-user':
          // Handle Cursor user messages (usually echoes)
          // Don't add user messages as they're already shown from input
          break;
          
        case 'cursor-tool-use':
          // Handle Cursor tool use messages
          setChatMessages(prev => [...prev, {
            type: 'assistant',
            content: `Using tool: ${latestMessage.tool} ${latestMessage.input ? `with ${latestMessage.input}` : ''}`,
            timestamp: new Date(),
            isToolUse: true,
            toolName: latestMessage.tool,
            toolInput: latestMessage.input
          }]);
          break;
        
        case 'cursor-error':
          // Show Cursor errors as error messages in chat
          setChatMessages(prev => [...prev, {
            type: 'error',
            content: `Cursor error: ${latestMessage.error || 'Unknown error'}`,
            timestamp: new Date()
          }]);
          break;
          
        case 'cursor-result':
          // Get session ID from message or fall back to current session
          const cursorCompletedSessionId = latestMessage.sessionId || currentSessionId;

          // Only update UI state if this is the current session
          if (cursorCompletedSessionId === currentSessionId) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
          }

          // Always mark the completed session as inactive and not processing
          if (cursorCompletedSessionId) {
            if (onSessionInactive) {
              onSessionInactive(cursorCompletedSessionId);
            }
            if (onSessionNotProcessing) {
              onSessionNotProcessing(cursorCompletedSessionId);
            }
          }

          // Only process result for current session
          if (cursorCompletedSessionId === currentSessionId) {
            try {
              const r = latestMessage.data || {};
              const textResult = typeof r.result === 'string' ? r.result : '';
              // Flush buffered deltas before finalizing
              if (streamTimerRef.current) {
                clearTimeout(streamTimerRef.current);
                streamTimerRef.current = null;
              }
              const pendingChunk = streamBufferRef.current;
              streamBufferRef.current = '';

              setChatMessages(prev => {
                const updated = [...prev];
                // Try to consolidate into the last streaming assistant message
                const last = updated[updated.length - 1];
                if (last && last.type === 'assistant' && !last.isToolUse && last.isStreaming) {
                  // Replace streaming content with the final content so deltas don't remain
                  const finalContent = textResult && textResult.trim() ? textResult : (last.content || '') + (pendingChunk || '');
                  last.content = finalContent;
                  last.isStreaming = false;
                } else if (textResult && textResult.trim()) {
                  updated.push({ type: r.is_error ? 'error' : 'assistant', content: textResult, timestamp: new Date(), isStreaming: false });
                }
                return updated;
              });
            } catch (e) {
              console.warn('Error handling cursor-result message:', e);
            }
          }

          // Store session ID for future use and trigger refresh (for new sessions)
          const pendingCursorSessionId = sessionStorage.getItem('pendingSessionId');
          if (cursorCompletedSessionId && !currentSessionId && cursorCompletedSessionId === pendingCursorSessionId) {
            setCurrentSessionId(cursorCompletedSessionId);
            sessionStorage.removeItem('pendingSessionId');

            // Trigger a project refresh to update the sidebar with the new session
            setTimeout(() => refreshProjects(), 500);
          }
          break;

        case 'cursor-output':
          // Handle Cursor raw terminal output; strip ANSI and ignore empty control-only payloads
          try {
            const raw = String(latestMessage.data ?? '');
            const cleaned = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
            if (cleaned) {
              streamBufferRef.current += (streamBufferRef.current ? `\n${cleaned}` : cleaned);
              if (!streamTimerRef.current) {
                streamTimerRef.current = setTimeout(() => {
                  const chunk = streamBufferRef.current;
                  streamBufferRef.current = '';
                  streamTimerRef.current = null;
                  if (!chunk) return;
                  setChatMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last && last.type === 'assistant' && !last.isToolUse && last.isStreaming) {
                      last.content = last.content ? `${last.content}\n${chunk}` : chunk;
                    } else {
                      updated.push({ type: 'assistant', content: chunk, timestamp: new Date(), isStreaming: true });
                    }
                    return updated;
                  });
                }, 100);
              }
            }
          } catch (e) {
            console.warn('Error handling cursor-output message:', e);
          }
          break;
          
        case 'claude-complete':
          // Get session ID from message or fall back to current session
          const completedSessionId = latestMessage.sessionId || currentSessionId || sessionStorage.getItem('pendingSessionId');

          // Update UI state if this is the current session OR if we don't have a session ID yet (new session)
          if (completedSessionId === currentSessionId || !currentSessionId) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
          }

          // Always mark the completed session as inactive and not processing
          if (completedSessionId) {
            if (onSessionInactive) {
              onSessionInactive(completedSessionId);
            }
            if (onSessionNotProcessing) {
              onSessionNotProcessing(completedSessionId);
            }
          }

          // If we have a pending session ID and the conversation completed successfully, use it
          const pendingSessionId = sessionStorage.getItem('pendingSessionId');
          if (pendingSessionId && !currentSessionId && latestMessage.exitCode === 0) {
                setCurrentSessionId(pendingSessionId);
            sessionStorage.removeItem('pendingSessionId');

            // No need to manually refresh - projects_updated WebSocket message will handle it
            console.log('✅ New session complete, ID set to:', pendingSessionId);
          }

          // Save current chatMessages to IndexedDB cache for offline access
          // This happens after conversation completes so we capture the full history
          if (selectedProject && completedSessionId && latestMessage.exitCode === 0) {
            (async () => {
              try {
                // Get the current session messages from sessionMessages state (raw format)
                // These are the messages as received from the server
                if (sessionMessages.length > 0) {
                  await messageCache.saveMessages(sessionMessages, completedSessionId, selectedProject.name);
                  await messageCache.updateSyncState(completedSessionId, Date.now(), sessionMessages.length);
                  console.log(`[MessageCache] Saved ${sessionMessages.length} messages to cache on session complete`);
                }
              } catch (cacheError) {
                console.warn('[MessageCache] Error saving on session complete:', cacheError);
              }
            })();

            // Also clear the legacy localStorage cache
            safeLocalStorage.removeItem(`chat_messages_${selectedProject.name}`);
          }
          // Conversation finished; clear any stale permission prompts.
          // This does not remove saved permissions; it only resets transient UI state.
          setPendingPermissionRequests([]);
          break;

        case 'task-complete-notification':
          // Notification from Stop hook via API
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const n = new Notification('Claude 任务完成', {
              body: latestMessage.message || 'Claude Code 任务已完成',
              tag: 'claude-complete-' + Date.now(),
            });
            n.onclick = () => { window.focus(); n.close(); };
          }
          break;

        case 'codex-response':
          // Handle Codex SDK responses
          const codexData = latestMessage.data;
          if (codexData) {
            // Handle item events
            if (codexData.type === 'item') {
              switch (codexData.itemType) {
                case 'agent_message':
                  if (codexData.message?.content?.trim()) {
                    const content = decodeHtmlEntities(codexData.message.content);
                    setChatMessages(prev => [...prev, {
                      type: 'assistant',
                      content: content,
                      timestamp: new Date()
                    }]);
                  }
                  break;

                case 'reasoning':
                  if (codexData.message?.content?.trim()) {
                    const content = decodeHtmlEntities(codexData.message.content);
                    setChatMessages(prev => [...prev, {
                      type: 'assistant',
                      content: content,
                      timestamp: new Date(),
                      isThinking: true
                    }]);
                  }
                  break;

                case 'command_execution':
                  if (codexData.command) {
                    setChatMessages(prev => [...prev, {
                      type: 'assistant',
                      content: '',
                      timestamp: new Date(),
                      isToolUse: true,
                      toolName: 'Bash',
                      toolInput: codexData.command,
                      toolResult: codexData.output || null,
                      exitCode: codexData.exitCode
                    }]);
                  }
                  break;

                case 'file_change':
                  if (codexData.changes?.length > 0) {
                    const changesList = codexData.changes.map(c => `${c.kind}: ${c.path}`).join('\n');
                    setChatMessages(prev => [...prev, {
                      type: 'assistant',
                      content: '',
                      timestamp: new Date(),
                      isToolUse: true,
                      toolName: 'FileChanges',
                      toolInput: changesList,
                      toolResult: `Status: ${codexData.status}`
                    }]);
                  }
                  break;

                case 'mcp_tool_call':
                  setChatMessages(prev => [...prev, {
                    type: 'assistant',
                    content: '',
                    timestamp: new Date(),
                    isToolUse: true,
                    toolName: `${codexData.server}:${codexData.tool}`,
                    toolInput: JSON.stringify(codexData.arguments, null, 2),
                    toolResult: codexData.result ? JSON.stringify(codexData.result, null, 2) : (codexData.error?.message || null)
                  }]);
                  break;

                case 'error':
                  if (codexData.message?.content) {
                    setChatMessages(prev => [...prev, {
                      type: 'error',
                      content: codexData.message.content,
                      timestamp: new Date()
                    }]);
                  }
                  break;

                default:
                  console.log('[Codex] Unhandled item type:', codexData.itemType, codexData);
              }
            }

            // Handle turn complete
            if (codexData.type === 'turn_complete') {
              // Turn completed, message stream done
              setIsLoading(false);
            }

            // Handle turn failed
            if (codexData.type === 'turn_failed') {
              setIsLoading(false);
              setChatMessages(prev => [...prev, {
                type: 'error',
                content: codexData.error?.message || 'Turn failed',
                timestamp: new Date()
              }]);
            }
          }
          break;

        case 'codex-complete':
          // Handle Codex session completion
          const codexCompletedSessionId = latestMessage.sessionId || currentSessionId || sessionStorage.getItem('pendingSessionId');

          if (codexCompletedSessionId === currentSessionId || !currentSessionId) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
          }

          if (codexCompletedSessionId) {
            if (onSessionInactive) {
              onSessionInactive(codexCompletedSessionId);
            }
            if (onSessionNotProcessing) {
              onSessionNotProcessing(codexCompletedSessionId);
            }
          }

          const codexPendingSessionId = sessionStorage.getItem('pendingSessionId');
          const codexActualSessionId = latestMessage.actualSessionId || codexPendingSessionId;
          if (codexPendingSessionId && !currentSessionId) {
            setCurrentSessionId(codexActualSessionId);
            setIsSystemSessionChange(true);
            navigate(`/session/${codexActualSessionId}`);
            sessionStorage.removeItem('pendingSessionId');
            console.log('Codex session complete, ID set to:', codexPendingSessionId);
          }

          if (selectedProject) {
            safeLocalStorage.removeItem(`chat_messages_${selectedProject.name}`);
          }
          break;

        case 'codex-error':
          // Handle Codex errors
          setIsLoading(false);
          setCanAbortSession(false);
          setChatMessages(prev => [...prev, {
            type: 'error',
            content: latestMessage.error || 'An error occurred with Codex',
            timestamp: new Date()
          }]);
          break;

        case 'session-aborted': {
          // Get session ID from message or fall back to current session
          const abortedSessionId = latestMessage.sessionId || currentSessionId;

          // Only update UI state if this is the current session
          if (abortedSessionId === currentSessionId) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
          }

          // Always mark the aborted session as inactive and not processing
          if (abortedSessionId) {
            if (onSessionInactive) {
              onSessionInactive(abortedSessionId);
            }
            if (onSessionNotProcessing) {
              onSessionNotProcessing(abortedSessionId);
            }
          }

          // Abort ends the run; clear permission prompts to avoid dangling UI state.
          // This does not change allowlists; it only clears the current banner.
          setPendingPermissionRequests([]);

          setChatMessages(prev => [...prev, {
            type: 'assistant',
            content: 'Session interrupted by user.',
            timestamp: new Date()
          }]);
          break;
        }

        case 'session-status': {
          const statusSessionId = latestMessage.sessionId;
          const isCurrentSession = statusSessionId === currentSessionId ||
                                   (selectedSession && statusSessionId === selectedSession.id);
          if (isCurrentSession && latestMessage.isProcessing) {
            // Session is currently processing, restore UI state
            setIsLoading(true);
            setCanAbortSession(true);
            if (onSessionProcessing) {
              onSessionProcessing(statusSessionId);
            }
          }
          break;
        }

        case 'claude-status':
          // Handle Claude working status messages
          const statusData = latestMessage.data;
          if (statusData) {
            // Parse the status message to extract relevant information
            let statusInfo = {
              text: 'Working...',
              tokens: 0,
              can_interrupt: true
            };
            
            // Check for different status message formats
            if (statusData.message) {
              statusInfo.text = statusData.message;
            } else if (statusData.status) {
              statusInfo.text = statusData.status;
            } else if (typeof statusData === 'string') {
              statusInfo.text = statusData;
            }
            
            // Extract token count
            if (statusData.tokens) {
              statusInfo.tokens = statusData.tokens;
            } else if (statusData.token_count) {
              statusInfo.tokens = statusData.token_count;
            }
            
            // Check if can interrupt
            if (statusData.can_interrupt !== undefined) {
              statusInfo.can_interrupt = statusData.can_interrupt;
            }
            
            setClaudeStatus(statusInfo);
            setIsLoading(true);
            setCanAbortSession(statusInfo.can_interrupt);
          }
          break;
  
      }
    }
  }, [latestMessage]);

  // Debounced input handling
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedInput(input);
    }, 150); // 150ms debounce
    
    return () => clearTimeout(timer);
  }, [input]);

  // Show only recent messages for better performance
  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) {
      return chatMessages;
    }
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  // Capture scroll position before render when auto-scroll is disabled
  useEffect(() => {
    if (!autoScrollToBottom && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      scrollPositionRef.current = {
        height: container.scrollHeight,
        top: container.scrollTop
      };
    }
  });

  // NOTE: Removed the chatMessages.length-dependent auto-scroll useEffect
  // This was causing unwanted scrolling whenever messages were added/updated
  // Now scrolling is only triggered explicitly:
  // 1. User clicks the "scroll to bottom" button
  // 2. User sends a message
  // 3. Session switch (initial load)
  // 4. External message update when user is near bottom

  // Scroll to bottom when messages first load after session switch
  useEffect(() => {
    if (scrollContainerRef.current && chatMessages.length > 0 && !isLoadingSessionRef.current) {
      // Only scroll if we're not in the middle of loading a session
      // This prevents the "double scroll" effect during session switching
      // Reset scroll state when switching sessions
      setIsUserScrolledUp(false);
      setTimeout(() => {
        scrollToBottom();
        // After scrolling, the scroll event handler will naturally set isUserScrolledUp based on position
      }, 200); // Delay to ensure full rendering
    }
  }, [selectedSession?.id, selectedProject?.name]); // Only trigger when session/project changes

  // Add scroll event listener to detect user scrolling
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', handleScroll);
      return () => scrollContainer.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  // Initial textarea setup - set to 2 rows height
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';

      // Check if initially expanded
      const lineHeight = parseInt(window.getComputedStyle(textareaRef.current).lineHeight);
      const isExpanded = textareaRef.current.scrollHeight > lineHeight * 2;
      setIsTextareaExpanded(isExpanded);
    }
  }, []); // Only run once on mount

  // Reset textarea height when input is cleared programmatically
  useEffect(() => {
    if (textareaRef.current && !input.trim()) {
      textareaRef.current.style.height = 'auto';
      setIsTextareaExpanded(false);
    }
  }, [input]);

  // Load token usage when session changes for Claude sessions only
  // (Codex token usage is included in messages response, Cursor doesn't support it)
  useEffect(() => {
    if (!selectedProject || !selectedSession?.id || selectedSession.id.startsWith('new-session-')) {
      setTokenBudget(null);
      return;
    }

    const sessionProvider = selectedSession.__provider || 'claude';

    // Skip for Codex (included in messages) and Cursor (not supported)
    if (sessionProvider !== 'claude') {
      return;
    }

    // Fetch token usage for Claude sessions
    const fetchInitialTokenUsage = async () => {
      try {
        const url = `/api/projects/${selectedProject.name}/sessions/${selectedSession.id}/token-usage`;
        const response = await authenticatedFetch(url);
        if (response.ok) {
          const data = await response.json();
          setTokenBudget(data);
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };

    fetchInitialTokenUsage();
  }, [selectedSession?.id, selectedSession?.__provider, selectedProject?.path]);

  const handleTranscript = useCallback((text) => {
    if (text.trim()) {
      setInput(prevInput => {
        const newInput = prevInput.trim() ? `${prevInput} ${text}` : text;

        // Update textarea height after setting new content
        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';

            // Check if expanded after transcript
            const lineHeight = parseInt(window.getComputedStyle(textareaRef.current).lineHeight);
            const isExpanded = textareaRef.current.scrollHeight > lineHeight * 2;
            setIsTextareaExpanded(isExpanded);
          }
        }, 0);

        return newInput;
      });
    }
  }, []);

  // Load earlier messages by increasing the visible message count
  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount(prevCount => prevCount + 100);
  }, []);

  // Handle image files from drag & drop or file picker
  const handleImageFiles = useCallback((files) => {
    const validFiles = files.filter(file => {
      try {
        // Validate file object and properties
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (!file.type || !file.type.startsWith('image/')) {
          return false;
        }

        if (!file.size || file.size > 5 * 1024 * 1024) {
          // Safely get file name with fallback
          const fileName = file.name || 'Unknown file';
          setImageErrors(prev => {
            const newMap = new Map(prev);
            newMap.set(fileName, 'File too large (max 5MB)');
            return newMap;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedImages(prev => [...prev, ...validFiles].slice(0, 5)); // Max 5 images
    }
  }, []);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!input.trim() || isLoading || !selectedProject) return;

    // Request notification permission on first user interaction
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    // Apply thinking mode prefix if selected
    let messageContent = input;
    const selectedThinkingMode = thinkingModes.find(mode => mode.id === thinkingMode);
    if (selectedThinkingMode && selectedThinkingMode.prefix) {
      messageContent = `${selectedThinkingMode.prefix}: ${input}`;
    }

    // Upload images first if any
    let uploadedImages = [];
    if (attachedImages.length > 0) {
      const formData = new FormData();
      attachedImages.forEach(file => {
        formData.append('images', file);
      });
      
      try {
        const response = await authenticatedFetch(`/api/projects/${selectedProject.name}/upload-images`, {
          method: 'POST',
          headers: {}, // Let browser set Content-Type for FormData
          body: formData
        });
        
        if (!response.ok) {
          throw new Error('Failed to upload images');
        }
        
        const result = await response.json();
        uploadedImages = result.images;
      } catch (error) {
        console.error('Image upload failed:', error);
        setChatMessages(prev => [...prev, {
          type: 'error',
          content: `Failed to upload images: ${error.message}`,
          timestamp: new Date()
        }]);
        return;
      }
    }

    const userMessage = {
      type: 'user',
      content: input,
      images: uploadedImages,
      timestamp: new Date()
    };

    setChatMessages(prev => [...prev, userMessage]);
    setIsLoading(true);
    setCanAbortSession(true);
    // Set a default status when starting
    setClaudeStatus({
      text: 'Processing',
      tokens: 0,
      can_interrupt: true
    });
    
    // Always scroll to bottom when user sends a message and reset scroll state
    setIsUserScrolledUp(false); // Reset scroll state so auto-scroll works for Claude's response
    setTimeout(() => scrollToBottom(), 100); // Longer delay to ensure message is rendered

    // Determine effective session id for replies to avoid race on state updates
    const effectiveSessionId = currentSessionId || selectedSession?.id || sessionStorage.getItem('cursorSessionId');

    // Session Protection: Mark session as active to prevent automatic project updates during conversation
    // Use existing session if available; otherwise a temporary placeholder until backend provides real ID
    const sessionToActivate = effectiveSessionId || `new-session-${Date.now()}`;
    if (!effectiveSessionId && !selectedSession?.id) {
      // We are starting a brand-new session in this view. Track it so we only
      // accept streaming updates for this run.
      pendingViewSessionRef.current = { sessionId: null, startedAt: Date.now() };
    }
    if (onSessionActive) {
      onSessionActive(sessionToActivate);
    }

    // Get tools settings from localStorage based on provider
    const getToolsSettings = () => {
      try {
        const settingsKey = provider === 'cursor' ? 'cursor-tools-settings' : provider === 'codex' ? 'codex-settings' : 'claude-settings';
        const savedSettings = safeLocalStorage.getItem(settingsKey);
        if (savedSettings) {
          return JSON.parse(savedSettings);
        }
      } catch (error) {
        console.error('Error loading tools settings:', error);
      }
      return {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false
      };
    };

    const toolsSettings = getToolsSettings();

    // Send command based on provider
    if (provider === 'cursor') {
      // Send Cursor command (always use cursor-command; include resume/sessionId when replying)
      sendMessage({
        type: 'cursor-command',
        command: messageContent,
        sessionId: effectiveSessionId,
        options: {
          // Prefer fullPath (actual cwd for project), fallback to path
          cwd: selectedProject.fullPath || selectedProject.path,
          projectPath: selectedProject.fullPath || selectedProject.path,
          sessionId: effectiveSessionId,
          resume: !!effectiveSessionId,
          model: cursorModel,
          skipPermissions: toolsSettings?.skipPermissions || false,
          toolsSettings: toolsSettings
        }
      });
    } else if (provider === 'codex') {
      // Send Codex command
      sendMessage({
        type: 'codex-command',
        command: messageContent,
        sessionId: effectiveSessionId,
        options: {
          cwd: selectedProject.fullPath || selectedProject.path,
          projectPath: selectedProject.fullPath || selectedProject.path,
          sessionId: effectiveSessionId,
          resume: !!effectiveSessionId,
          model: codexModel,
          permissionMode: permissionMode === 'plan' ? 'default' : permissionMode
        }
      });
    } else {
      // Send Claude command (existing code)
      sendMessage({
        type: 'claude-command',
        command: messageContent,
        options: {
          projectPath: selectedProject.path,
          cwd: selectedProject.fullPath,
          sessionId: currentSessionId,
          resume: !!currentSessionId,
          toolsSettings: toolsSettings,
          permissionMode: permissionMode,
          model: claudeModel,
          images: uploadedImages // Pass images to backend
        }
      });
    }

    setInput('');
    setAttachedImages([]);
    setUploadingImages(new Map());
    setImageErrors(new Map());
    setIsTextareaExpanded(false);
    setThinkingMode('none'); // Reset thinking mode after sending

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // Clear the saved draft since message was sent
    if (selectedProject) {
      safeLocalStorage.removeItem(`draft_input_${selectedProject.name}`);
    }
  }, [input, isLoading, selectedProject, attachedImages, currentSessionId, selectedSession, provider, permissionMode, onSessionActive, cursorModel, claudeModel, codexModel, sendMessage, setInput, setAttachedImages, setUploadingImages, setImageErrors, setIsTextareaExpanded, textareaRef, setChatMessages, setIsLoading, setCanAbortSession, setClaudeStatus, setIsUserScrolledUp, scrollToBottom, thinkingMode]);

  const handleGrantToolPermission = useCallback((suggestion) => {
    if (!suggestion || provider !== 'claude') {
      return { success: false };
    }
    return grantClaudeToolPermission(suggestion.entry);
  }, [provider]);

  // Send a UI decision back to the server (single or batched request IDs).
  // This does not validate tool inputs or permissions; the backend enforces rules.
  // It exists so "Allow & remember" can resolve multiple queued prompts at once.
  const handlePermissionDecision = useCallback((requestIds, decision) => {
    const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
    const validIds = ids.filter(Boolean);
    if (validIds.length === 0) {
      return;
    }

    validIds.forEach((requestId) => {
      sendMessage({
        type: 'claude-permission-response',
        requestId,
        allow: Boolean(decision?.allow),
        updatedInput: decision?.updatedInput,
        message: decision?.message,
        rememberEntry: decision?.rememberEntry
      });
    });

    setPendingPermissionRequests(prev => {
      const next = prev.filter(req => !validIds.includes(req.requestId));
      if (next.length === 0) {
        setClaudeStatus(null);
      }
      return next;
    });
  }, [sendMessage]);

  // Store handleSubmit in ref so handleCustomCommand can access it
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);


// ! Unused
  const handleNewSession = () => {
    setChatMessages([]);
    setInput('');
    setIsLoading(false);
    setCanAbortSession(false);
  };
  
  const handleAbortSession = () => {
    if (currentSessionId && canAbortSession) {
      sendMessage({
        type: 'abort-session',
        sessionId: currentSessionId,
        provider: provider
      });
    }
  };

  const handleModeSwitch = () => {
    // Codex doesn't support plan mode
    const modes = provider === 'codex'
      ? ['default', 'acceptEdits', 'bypassPermissions']
      : ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    const newMode = modes[nextIndex];
    setPermissionMode(newMode);

    // Save mode for this session
    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, newMode);
    }
  };

  // Don't render if no project is selected
  if (!selectedProject) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-gray-500 dark:text-gray-400">
          <p>Select a project to start chatting with Claude</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <style>
        {`
          details[open] .details-chevron {
            transform: rotate(180deg);
          }
        `}
      </style>
      <div className="h-full flex flex-col">
        {/* Messages Area - Scrollable Middle Section */}
      <div 
        ref={scrollContainerRef}
        onWheel={handleScroll}
        onTouchMove={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden px-0 py-3 sm:p-4 space-y-3 sm:space-y-4 relative"
      >
        {isLoadingSessionMessages && chatMessages.length === 0 ? (
          <div className="text-center text-gray-500 dark:text-gray-400 mt-8">
            <div className="flex items-center justify-center space-x-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-400"></div>
              <p>{t('session.loading.sessionMessages')}</p>
            </div>
          </div>
        ) : chatMessages.length === 0 ? (
          <ProviderSelector
            provider={provider}
            setProvider={setProvider}
            claudeModel={claudeModel}
            setClaudeModel={setClaudeModel}
            cursorModel={cursorModel}
            setCursorModel={setCursorModel}
            codexModel={codexModel}
            setCodexModel={setCodexModel}
            textareaRef={textareaRef}
            tasksEnabled={tasksEnabled}
            isTaskMasterInstalled={isTaskMasterInstalled}
            setInput={setInput}
            onShowAllTasks={onShowAllTasks}
            selectedSession={selectedSession}
            currentSessionId={currentSessionId}
          />
        ) : (
          <>
            {/* Loading indicator for older messages */}
            {isLoadingMoreMessages && (
              <div className="text-center text-gray-500 dark:text-gray-400 py-3">
                <div className="flex items-center justify-center space-x-2">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-400"></div>
                  <p className="text-sm">{t('session.loading.olderMessages')}</p>
                </div>
              </div>
            )}
            
            {/* Indicator showing there are more messages to load */}
            {hasMoreMessages && !isLoadingMoreMessages && (
              <div className="text-center text-gray-500 dark:text-gray-400 text-sm py-2 border-b border-gray-200 dark:border-gray-700">
                {totalMessages > 0 && (
                  <span>
                    {t('session.messages.showingOf', { shown: sessionMessages.length, total: totalMessages })} •
                    <button
                      className="ml-1 text-blue-600 hover:text-blue-700 underline"
                      onClick={() => loadOlderMessages(scrollContainerRef.current)}
                    >
                      {t('session.messages.loadMore')}
                    </button>
                  </span>
                )}
              </div>
            )}
            
            {/* Legacy message count indicator (for non-paginated view) */}
            {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
              <div className="text-center text-gray-500 dark:text-gray-400 text-sm py-2 border-b border-gray-200 dark:border-gray-700">
                {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })} •
                <button
                  className="ml-1 text-blue-600 hover:text-blue-700 underline"
                  onClick={loadEarlierMessages}
                >
                  {t('session.messages.loadEarlier')}
                </button>
              </div>
            )}
            
            {visibleMessages.map((message, index) => {
              const prevMessage = index > 0 ? visibleMessages[index - 1] : null;

              return (
                <MessageComponent
                  key={message.id || `fallback-${index}`}
                  message={message}
                  index={index}
                  prevMessage={prevMessage}
                  createDiff={createDiff}
                  onFileOpen={onFileOpen}
                  onGrantToolPermission={handleGrantToolPermission}
                  selectedProject={selectedProject}
                  provider={provider}
                />
              );
            })}
          </>
        )}
        
        {isLoading && (
          <div className="chat-message assistant">
            <div className="w-full">
              <div className="flex items-center space-x-3 mb-2">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm flex-shrink-0 p-1 bg-transparent">
                  {(localStorage.getItem('selected-provider') || 'claude') === 'cursor' ? (
                    <CursorLogo className="w-full h-full" />
                  ) : (localStorage.getItem('selected-provider') || 'claude') === 'codex' ? (
                    <CodexLogo className="w-full h-full" />
                  ) : (
                    <ClaudeLogo className="w-full h-full" />
                  )}
                </div>
                <div className="text-sm font-medium text-gray-900 dark:text-white">{(localStorage.getItem('selected-provider') || 'claude') === 'cursor' ? 'Cursor' : (localStorage.getItem('selected-provider') || 'claude') === 'codex' ? 'Codex' : 'Claude'}</div>
                {/* Abort button removed - functionality not yet implemented at backend */}
              </div>
              <div className="w-full text-sm text-gray-500 dark:text-gray-400 pl-3 sm:pl-0">
                <div className="flex items-center space-x-1">
                  <div className="animate-pulse">●</div>
                  <div className="animate-pulse" style={{ animationDelay: '0.2s' }}>●</div>
                  <div className="animate-pulse" style={{ animationDelay: '0.4s' }}>●</div>
                  <span className="ml-2">Thinking...</span>
                </div>
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>


      {/* Input Area - Fixed Bottom */}
      <div className={`p-2 sm:p-4 md:p-4 flex-shrink-0 ${
        isInputFocused ? 'pb-2 sm:pb-4 md:pb-6' : 'pb-2 sm:pb-4 md:pb-6'
      }`}>
    
        <div className="flex-1">
              <ClaudeStatus
                status={claudeStatus}
                isLoading={isLoading}
                onAbort={handleAbortSession}
                provider={provider}
                showThinking={showThinking}
              />
              </div>
        {/* Permission Mode Selector with scroll to bottom button - Above input, clickable for mobile */}
        <div ref={inputContainerRef} className="max-w-4xl mx-auto mb-3">
          {pendingPermissionRequests.length > 0 && (
            // Permission banner for tool approvals. This renders the input, allows
            // "allow once" or "allow & remember", and supports batching similar requests.
            // It does not persist permissions by itself; persistence is handled by
            // the existing localStorage-based settings helpers, introduced to surface
            // approvals before tool execution resumes.
            <div className="mb-3 space-y-2">
              {pendingPermissionRequests.map((request) => {
                const rawInput = formatToolInputForDisplay(request.input);
                const permissionEntry = buildClaudeToolPermissionEntry(request.toolName, rawInput);
                const settings = getClaudeSettings();
                const alreadyAllowed = permissionEntry
                  ? settings.allowedTools.includes(permissionEntry)
                  : false;
                const rememberLabel = alreadyAllowed ? 'Allow (saved)' : 'Allow & remember';
                // Group pending prompts that resolve to the same allow rule so
                // a single "Allow & remember" can clear them in one click.
                // This does not attempt fuzzy matching; it only batches identical rules.
                const matchingRequestIds = permissionEntry
                  ? pendingPermissionRequests
                    .filter(item => buildClaudeToolPermissionEntry(item.toolName, formatToolInputForDisplay(item.input)) === permissionEntry)
                    .map(item => item.requestId)
                  : [request.requestId];

                return (
                  <div
                    key={request.requestId}
                    className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                          Permission required
                        </div>
                        <div className="text-xs text-amber-800 dark:text-amber-200">
                          Tool: <span className="font-mono">{request.toolName}</span>
                        </div>
                      </div>
                      {permissionEntry && (
                        <div className="text-xs text-amber-700 dark:text-amber-300">
                          Allow rule: <span className="font-mono">{permissionEntry}</span>
                        </div>
                      )}
                    </div>

                    {rawInput && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-amber-800 dark:text-amber-200 hover:text-amber-900 dark:hover:text-amber-100">
                          View tool input
                        </summary>
                        <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-white/80 dark:bg-gray-900/60 border border-amber-200/60 dark:border-amber-800/60 p-2 text-xs text-amber-900 dark:text-amber-100 whitespace-pre-wrap">
                          {rawInput}
                        </pre>
                      </details>
                    )}

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => handlePermissionDecision(request.requestId, { allow: true })}
                        className="inline-flex items-center gap-2 rounded-md bg-amber-600 text-white text-xs font-medium px-3 py-1.5 hover:bg-amber-700 transition-colors"
                      >
                        Allow once
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (permissionEntry && !alreadyAllowed) {
                            handleGrantToolPermission({ entry: permissionEntry, toolName: request.toolName });
                          }
                          handlePermissionDecision(matchingRequestIds, { allow: true, rememberEntry: permissionEntry });
                        }}
                        className={`inline-flex items-center gap-2 rounded-md text-xs font-medium px-3 py-1.5 border transition-colors ${
                          permissionEntry
                            ? 'border-amber-300 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/30'
                            : 'border-gray-300 text-gray-400 cursor-not-allowed'
                        }`}
                        disabled={!permissionEntry}
                      >
                        {rememberLabel}
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePermissionDecision(request.requestId, { allow: false, message: 'User denied tool use' })}
                        className="inline-flex items-center gap-2 rounded-md text-xs font-medium px-3 py-1.5 border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-200 dark:hover:bg-red-900/30 transition-colors"
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={handleModeSwitch}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-all duration-200 ${
                permissionMode === 'default' 
                  ? 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600'
                  : permissionMode === 'acceptEdits'
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border-green-300 dark:border-green-600 hover:bg-green-100 dark:hover:bg-green-900/30'
                  : permissionMode === 'bypassPermissions'
                  ? 'bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300 border-orange-300 dark:border-orange-600 hover:bg-orange-100 dark:hover:bg-orange-900/30'
                  : 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-600 hover:bg-blue-100 dark:hover:bg-blue-900/30'
              }`}
              title={t('input.clickToChangeMode')}
            >
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${
                  permissionMode === 'default' 
                    ? 'bg-gray-500'
                    : permissionMode === 'acceptEdits'
                    ? 'bg-green-500'
                    : permissionMode === 'bypassPermissions'
                    ? 'bg-orange-500'
                    : 'bg-blue-500'
                }`} />
                <span>
                  {permissionMode === 'default' && t('codex.modes.default')}
                  {permissionMode === 'acceptEdits' && t('codex.modes.acceptEdits')}
                  {permissionMode === 'bypassPermissions' && t('codex.modes.bypassPermissions')}
                  {permissionMode === 'plan' && t('codex.modes.plan')}
                </span>
              </div>
            </button>
            
              {/* Thinking Mode Selector */}
              {
                provider === 'claude' && (

                  <ThinkingModeSelector
                    selectedMode={thinkingMode}
                    onModeChange={setThinkingMode}
                    className=""
                  />
                )}
            {/* Token usage pie chart - positioned next to mode indicator */}
            <TokenUsagePie
              used={tokenBudget?.used || 0}
              total={tokenBudget?.total || parseInt(import.meta.env.VITE_CONTEXT_WINDOW) || 160000}
            />

            {/* Slash commands button */}
            <button
              type="button"
              onClick={() => {
                const isOpening = !showCommandMenu;
                setShowCommandMenu(isOpening);
                setCommandQuery('');
                setSelectedCommandIndex(-1);

                // When opening, ensure all commands are shown
                if (isOpening) {
                  setFilteredCommands(slashCommands);
                }

                if (textareaRef.current) {
                  textareaRef.current.focus();
                }
              }}
              className="relative w-8 h-8 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-full flex items-center justify-center transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:ring-offset-gray-800"
              title={t('input.showAllCommands')}
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"
                />
              </svg>
              {/* Command count badge */}
              {slashCommands.length > 0 && (
                <span
                  className="absolute -top-1 -right-1 bg-blue-600 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center"
                  style={{ fontSize: '10px' }}
                >
                  {slashCommands.length}
                </span>
              )}
            </button>

            {/* Clear input button - positioned to the right of token pie, only shows when there's input */}
            {input.trim() && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setInput('');
                  if (textareaRef.current) {
                    textareaRef.current.style.height = 'auto';
                    textareaRef.current.focus();
                  }
                  setIsTextareaExpanded(false);
                }}
                className="w-8 h-8 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-full flex items-center justify-center transition-all duration-200 group shadow-sm"
                title="Clear input"
              >
                <svg
                  className="w-4 h-4 text-gray-600 dark:text-gray-300 group-hover:text-gray-800 dark:group-hover:text-gray-100 transition-colors"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}

            {/* Scroll to bottom button - positioned next to mode indicator */}
            {isUserScrolledUp && chatMessages.length > 0 && (
              <button
                onClick={scrollToBottom}
                className="w-8 h-8 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg flex items-center justify-center transition-all duration-200 hover:scale-105 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:ring-offset-gray-800"
                title="Scroll to bottom"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              </button>
            )}
          </div>
        </div>
        
        <ChatInput
          input={input} setInput={setInput}
          isLoading={isLoading}
          isTextareaExpanded={isTextareaExpanded} setIsTextareaExpanded={setIsTextareaExpanded}
          textareaRef={textareaRef} inputHighlightRef={inputHighlightRef}
          handleSubmit={handleSubmit} handleTranscript={handleTranscript}
          setCursorPosition={setCursorPosition}
          attachedImages={attachedImages} setAttachedImages={setAttachedImages}
          uploadingImages={uploadingImages} imageErrors={imageErrors}
          handleImageFiles={handleImageFiles}
          showFileDropdown={showFileDropdown} filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex} setSelectedFileIndex={setSelectedFileIndex}
          selectFile={selectFile} renderInputWithMentions={renderInputWithMentions}
          showCommandMenu={showCommandMenu} setShowCommandMenu={setShowCommandMenu}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex} setSelectedCommandIndex={setSelectedCommandIndex}
          handleCommandSelect={handleCommandSelect} selectCommand={selectCommand}
          commandQuery={commandQuery} setCommandQuery={setCommandQuery}
          setSlashPosition={setSlashPosition} commandQueryTimerRef={commandQueryTimerRef}
          frequentCommands={frequentCommands}
          provider={provider} permissionMode={permissionMode} setPermissionMode={setPermissionMode}
          selectedSession={selectedSession}
          setIsInputFocused={setIsInputFocused}
        />
      </div>
    </div>
    </>
  );
}

export default React.memo(ChatInterface);
