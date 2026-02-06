// ChatInput component extracted from ChatInterface.jsx
// Contains the input form, textarea, file dropdown, command menu, image attachments, and related handlers
import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { useTranslation } from 'react-i18next';
import CommandMenu from '../CommandMenu';
import ImageAttachment from './ImageAttachment.jsx';
import { MicButton } from '../MicButton.jsx';
import { useChatSettings } from '../../contexts/ChatSettingsContext.jsx';

const ChatInput = ({
  // Input state
  input, setInput,
  isLoading,
  isTextareaExpanded, setIsTextareaExpanded,
  // Refs
  textareaRef,
  inputHighlightRef,
  // Handlers from parent
  handleSubmit,
  handleTranscript,
  setCursorPosition,
  // Image state
  attachedImages, setAttachedImages,
  uploadingImages,
  imageErrors,
  handleImageFiles,
  // File autocomplete
  showFileDropdown,
  filteredFiles,
  selectedFileIndex, setSelectedFileIndex,
  selectFile,
  renderInputWithMentions,
  // Slash commands
  showCommandMenu, setShowCommandMenu,
  filteredCommands,
  selectedCommandIndex, setSelectedCommandIndex,
  handleCommandSelect,
  selectCommand,
  commandQuery,
  setCommandQuery,
  setSlashPosition,
  commandQueryTimerRef,
  frequentCommands,
  // Mode
  provider,
  permissionMode, setPermissionMode,
  selectedSession,
  // Focus
  setIsInputFocused,
}) => {
  const { t } = useTranslation('chat');
  const { sendByCtrlEnter } = useChatSettings();

  // Handle clipboard paste for images
  const handlePaste = useCallback(async (e) => {
    const items = Array.from(e.clipboardData.items);

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          handleImageFiles([file]);
        }
      }
    }

    // Fallback for some browsers/platforms
    if (items.length === 0 && e.clipboardData.files.length > 0) {
      const files = Array.from(e.clipboardData.files);
      const imageFiles = files.filter(f => f.type.startsWith('image/'));
      if (imageFiles.length > 0) {
        handleImageFiles(imageFiles);
      }
    }
  }, [handleImageFiles]);

  // Setup dropzone
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']
    },
    maxSize: 5 * 1024 * 1024, // 5MB
    maxFiles: 5,
    onDrop: handleImageFiles,
    noClick: true,
    noKeyboard: true
  });

  const syncInputOverlayScroll = useCallback((target) => {
    if (!inputHighlightRef.current || !target) return;
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const handleTextareaClick = (e) => {
    setCursorPosition(e.target.selectionStart);
  };

  const handleInputChange = (e) => {
    const newValue = e.target.value;
    const cursorPos = e.target.selectionStart;

    setInput(newValue);
    setCursorPosition(cursorPos);

    // Handle height reset when input becomes empty
    if (!newValue.trim()) {
      e.target.style.height = 'auto';
      setIsTextareaExpanded(false);
      setShowCommandMenu(false);
      setSlashPosition(-1);
      setCommandQuery('');
      return;
    }

    // Detect slash command at cursor position
    const textBeforeCursor = newValue.slice(0, cursorPos);

    // Check if we're in a code block
    const backticksBefore = (textBeforeCursor.match(/```/g) || []).length;
    const inCodeBlock = backticksBefore % 2 === 1;

    if (inCodeBlock) {
      setShowCommandMenu(false);
      setSlashPosition(-1);
      setCommandQuery('');
      return;
    }

    // Find the last slash before cursor that could start a command
    const slashPattern = /(^|\s)\/(\S*)$/;
    const match = textBeforeCursor.match(slashPattern);

    if (match) {
      const slashPos = match.index + match[1].length;
      const query = match[2];

      setSlashPosition(slashPos);
      setShowCommandMenu(true);
      setSelectedCommandIndex(-1);

      // Debounce the command query update
      if (commandQueryTimerRef.current) {
        clearTimeout(commandQueryTimerRef.current);
      }

      commandQueryTimerRef.current = setTimeout(() => {
        setCommandQuery(query);
      }, 150);
    } else {
      setShowCommandMenu(false);
      setSlashPosition(-1);
      setCommandQuery('');

      if (commandQueryTimerRef.current) {
        clearTimeout(commandQueryTimerRef.current);
      }
    }
  };

  const handleKeyDown = (e) => {
    // Handle command menu navigation
    if (showCommandMenu && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedCommandIndex(prev =>
          prev < filteredCommands.length - 1 ? prev + 1 : 0
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedCommandIndex(prev =>
          prev > 0 ? prev - 1 : filteredCommands.length - 1
        );
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        if (selectedCommandIndex >= 0) {
          selectCommand(filteredCommands[selectedCommandIndex]);
        } else if (filteredCommands.length > 0) {
          selectCommand(filteredCommands[0]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowCommandMenu(false);
        setSlashPosition(-1);
        setCommandQuery('');
        setSelectedCommandIndex(-1);
        if (commandQueryTimerRef.current) {
          clearTimeout(commandQueryTimerRef.current);
        }
        return;
      }
    }

    // Handle file dropdown navigation
    if (showFileDropdown && filteredFiles.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedFileIndex(prev =>
          prev < filteredFiles.length - 1 ? prev + 1 : 0
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedFileIndex(prev =>
          prev > 0 ? prev - 1 : filteredFiles.length - 1
        );
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        if (selectedFileIndex >= 0) {
          selectFile(filteredFiles[selectedFileIndex]);
        } else if (filteredFiles.length > 0) {
          selectFile(filteredFiles[0]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // setShowFileDropdown is handled by the hook
        return;
      }
    }

    // Handle Tab key for mode switching (only when dropdowns are not showing)
    if (e.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
      e.preventDefault();
      const modes = provider === 'codex'
        ? ['default', 'acceptEdits', 'bypassPermissions']
        : ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
      const currentIndex = modes.indexOf(permissionMode);
      const nextIndex = (currentIndex + 1) % modes.length;
      const newMode = modes[nextIndex];
      setPermissionMode(newMode);

      if (selectedSession?.id) {
        localStorage.setItem(`permissionMode-${selectedSession.id}`, newMode);
      }
      return;
    }

    // Handle Enter key
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e);
      } else if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (!sendByCtrlEnter) {
          e.preventDefault();
          handleSubmit(e);
        }
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} className="relative max-w-4xl mx-auto">
      {/* Drag overlay */}
      {isDragActive && (
        <div className="absolute inset-0 bg-blue-500/20 border-2 border-dashed border-blue-500 rounded-lg flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-lg">
            <svg className="w-8 h-8 text-blue-500 mx-auto mb-2" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <p className="text-sm font-medium">Drop images here</p>
          </div>
        </div>
      )}

      {/* Image attachments preview */}
      {attachedImages.length > 0 && (
        <div className="mb-2 p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
          <div className="flex flex-wrap gap-2">
            {attachedImages.map((file, index) => (
              <ImageAttachment
                key={index}
                file={file}
                onRemove={() => {
                  setAttachedImages(prev => prev.filter((_, i) => i !== index));
                }}
                uploadProgress={uploadingImages.get(file.name)}
                error={imageErrors.get(file.name)}
              />
            ))}
          </div>
        </div>
      )}

      {/* File dropdown */}
      {showFileDropdown && filteredFiles.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg max-h-48 overflow-y-auto z-50 backdrop-blur-sm">
          {filteredFiles.map((file, index) => (
            <div
              key={file.path}
              className={`px-4 py-3 cursor-pointer border-b border-gray-100 dark:border-gray-700 last:border-b-0 touch-manipulation ${
                index === selectedFileIndex
                  ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                  : 'hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                selectFile(file);
              }}
            >
              <div className="font-medium text-sm">{file.name}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                {file.path}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Command Menu */}
      <CommandMenu
        commands={filteredCommands}
        selectedIndex={selectedCommandIndex}
        onSelect={handleCommandSelect}
        onClose={() => {
          setShowCommandMenu(false);
          setSlashPosition(-1);
          setCommandQuery('');
          setSelectedCommandIndex(-1);
        }}
        position={{
          top: textareaRef.current
            ? Math.max(16, textareaRef.current.getBoundingClientRect().top - 316)
            : 0,
          left: textareaRef.current
            ? textareaRef.current.getBoundingClientRect().left
            : 16,
          bottom: textareaRef.current
            ? window.innerHeight - textareaRef.current.getBoundingClientRect().top + 8
            : 90
        }}
        isOpen={showCommandMenu}
        frequentCommands={commandQuery ? [] : frequentCommands}
      />

      <div {...getRootProps()} className={`relative bg-white dark:bg-gray-800 rounded-2xl shadow-lg border border-gray-200 dark:border-gray-600 focus-within:ring-2 focus-within:ring-blue-500 dark:focus-within:ring-blue-500 focus-within:border-blue-500 transition-all duration-200 overflow-hidden ${isTextareaExpanded ? 'chat-input-expanded' : ''}`}>
        <input {...getInputProps()} />
        <div
          ref={inputHighlightRef}
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl"
        >
          <div className="chat-input-placeholder block w-full pl-12 pr-20 sm:pr-40 py-1.5 sm:py-4 text-transparent text-base leading-6 whitespace-pre-wrap break-words">
            {renderInputWithMentions(input)}
          </div>
        </div>
        <div className="relative z-10">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onClick={handleTextareaClick}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onScroll={(e) => syncInputOverlayScroll(e.target)}
          onFocus={() => setIsInputFocused(true)}
          onBlur={() => setIsInputFocused(false)}
          onInput={(e) => {
            e.target.style.height = 'auto';
            e.target.style.height = e.target.scrollHeight + 'px';
            setCursorPosition(e.target.selectionStart);
            syncInputOverlayScroll(e.target);

            const lineHeight = parseInt(window.getComputedStyle(e.target).lineHeight);
            const isExpanded = e.target.scrollHeight > lineHeight * 2;
            setIsTextareaExpanded(isExpanded);
          }}
          placeholder={t('input.placeholder', { provider: provider === 'cursor' ? t('messageTypes.cursor') : provider === 'codex' ? t('messageTypes.codex') : t('messageTypes.claude') })}
          disabled={isLoading}
          className="chat-input-placeholder block w-full pl-12 pr-20 sm:pr-40 py-1.5 sm:py-4 bg-transparent rounded-2xl focus:outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 disabled:opacity-50 resize-none min-h-[50px] sm:min-h-[80px] max-h-[40vh] sm:max-h-[300px] overflow-y-auto text-base leading-6 transition-all duration-200"
          style={{ height: '50px' }}
        />
        {/* Image upload button */}
        <button
          type="button"
          onClick={open}
          className="absolute left-2 top-1/2 transform -translate-y-1/2 p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          title={t('input.attachImages')}
          aria-label={t('input.attachImages')}
        >
          <svg className="w-5 h-5 text-gray-500" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </button>

        {/* Mic button - HIDDEN */}
        <div className="absolute right-16 sm:right-16 top-1/2 transform -translate-y-1/2" style={{ display: 'none' }}>
          <MicButton
            onTranscript={handleTranscript}
            className="w-10 h-10 sm:w-10 sm:h-10"
          />
        </div>

        {/* Send button */}
        <button
          type="submit"
          disabled={!input.trim() || isLoading}
          onMouseDown={(e) => {
            e.preventDefault();
            handleSubmit(e);
          }}
          onTouchStart={(e) => {
            e.preventDefault();
            handleSubmit(e);
          }}
          aria-label={t('input.send')}
          className="absolute right-2 top-1/2 transform -translate-y-1/2 w-12 h-12 sm:w-12 sm:h-12 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed rounded-full flex items-center justify-center transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:ring-offset-gray-800"
        >
          <svg
            className="w-4 h-4 sm:w-5 sm:h-5 text-white transform rotate-90"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
            />
          </svg>
        </button>

        {/* Hint text inside input box at bottom - Desktop only */}
        <div className={`absolute bottom-1 left-12 right-14 sm:right-40 text-xs text-gray-400 dark:text-gray-500 pointer-events-none hidden sm:block transition-opacity duration-200 ${
          input.trim() ? 'opacity-0' : 'opacity-100'
        }`}>
          {sendByCtrlEnter
            ? t('input.hintText.ctrlEnter')
            : t('input.hintText.enter')}
        </div>
        </div>
      </div>
    </form>
  );
};

export default ChatInput;
