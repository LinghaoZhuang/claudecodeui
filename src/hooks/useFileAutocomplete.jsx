// useFileAutocomplete hook extracted from ChatInterface.jsx
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { escapeRegExp } from '../utils/chatUtils.js';
import { api } from '../utils/api';

export function useFileAutocomplete({
  selectedProject,
  input,
  cursorPosition,
  setInput,
  setCursorPosition,
  textareaRef,
}) {
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [fileList, setFileList] = useState([]);
  const [fileMentions, setFileMentions] = useState([]);
  const [filteredFiles, setFilteredFiles] = useState([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);

  // Load file list when project changes
  useEffect(() => {
    if (selectedProject) {
      fetchProjectFiles();
    }
  }, [selectedProject]);

  const fetchProjectFiles = async () => {
    try {
      const response = await api.getFiles(selectedProject.name);
      if (response.ok) {
        const files = await response.json();
        // Flatten the file tree to get all file paths
        const flatFiles = flattenFileTree(files);
        setFileList(flatFiles);
      }
    } catch (error) {
      console.error('Error fetching files:', error);
    }
  };

  const flattenFileTree = (files, basePath = '') => {
    let result = [];
    for (const file of files) {
      const fullPath = basePath ? `${basePath}/${file.name}` : file.name;
      if (file.type === 'directory' && file.children) {
        result = result.concat(flattenFileTree(file.children, fullPath));
      } else if (file.type === 'file') {
        result.push({
          name: file.name,
          path: fullPath,
          relativePath: file.path
        });
      }
    }
    return result;
  };

  // Handle @ symbol detection and file filtering
  useEffect(() => {
    const textBeforeCursor = input.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex !== -1) {
      const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
      // Check if there's a space after the @ symbol (which would end the file reference)
      if (!textAfterAt.includes(' ')) {
        setAtSymbolPosition(lastAtIndex);
        setShowFileDropdown(true);

        // Filter files based on the text after @
        const filtered = fileList.filter(file =>
          file.name.toLowerCase().includes(textAfterAt.toLowerCase()) ||
          file.path.toLowerCase().includes(textAfterAt.toLowerCase())
        ).slice(0, 10); // Limit to 10 results

        setFilteredFiles(filtered);
        setSelectedFileIndex(-1);
      } else {
        setShowFileDropdown(false);
        setAtSymbolPosition(-1);
      }
    } else {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
    }
  }, [input, cursorPosition, fileList]);

  const activeFileMentions = useMemo(() => {
    if (!input || fileMentions.length === 0) return [];
    return fileMentions.filter(path => input.includes(path));
  }, [fileMentions, input]);

  const sortedFileMentions = useMemo(() => {
    if (activeFileMentions.length === 0) return [];
    const unique = Array.from(new Set(activeFileMentions));
    return unique.sort((a, b) => b.length - a.length);
  }, [activeFileMentions]);

  const fileMentionRegex = useMemo(() => {
    if (sortedFileMentions.length === 0) return null;
    const pattern = sortedFileMentions.map(escapeRegExp).join('|');
    return new RegExp(`(${pattern})`, 'g');
  }, [sortedFileMentions]);

  const fileMentionSet = useMemo(() => new Set(sortedFileMentions), [sortedFileMentions]);

  const renderInputWithMentions = useCallback((text) => {
    if (!text) return '';
    if (!fileMentionRegex) return text;
    const parts = text.split(fileMentionRegex);
    return parts.map((part, index) => (
      fileMentionSet.has(part) ? (
        <span
          key={`mention-${index}`}
          className="bg-blue-200/70 -ml-0.5 dark:bg-blue-300/40 px-0.5 rounded-md box-decoration-clone text-transparent"
        >
          {part}
        </span>
      ) : (
        <span key={`text-${index}`}>{part}</span>
      )
    ));
  }, [fileMentionRegex, fileMentionSet]);

  const selectFile = useCallback((file) => {
    const textBeforeAt = input.slice(0, atSymbolPosition);
    const textAfterAtQuery = input.slice(atSymbolPosition);
    const spaceIndex = textAfterAtQuery.indexOf(' ');
    const textAfterQuery = spaceIndex !== -1 ? textAfterAtQuery.slice(spaceIndex) : '';

    const newInput = textBeforeAt + file.path + ' ' + textAfterQuery;
    const newCursorPos = textBeforeAt.length + file.path.length + 1;

    // Immediately ensure focus is maintained
    if (textareaRef.current && !textareaRef.current.matches(':focus')) {
      textareaRef.current.focus();
    }

    // Update input and cursor position
    setInput(newInput);
    setCursorPosition(newCursorPos);
    setFileMentions(prev => (prev.includes(file.path) ? prev : [...prev, file.path]));

    // Hide dropdown
    setShowFileDropdown(false);
    setAtSymbolPosition(-1);

    // Set cursor position synchronously
    if (textareaRef.current) {
      // Use requestAnimationFrame for smoother updates
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
          // Ensure focus is maintained
          if (!textareaRef.current.matches(':focus')) {
            textareaRef.current.focus();
          }
        }
      });
    }
  }, [input, atSymbolPosition, setInput, setCursorPosition, textareaRef]);

  return {
    showFileDropdown,
    setShowFileDropdown,
    filteredFiles,
    selectedFileIndex,
    setSelectedFileIndex,
    renderInputWithMentions,
    selectFile,
  };
}
