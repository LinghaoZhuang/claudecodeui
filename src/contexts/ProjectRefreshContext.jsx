import React, { createContext, useContext, useRef, useCallback } from 'react';

const ProjectRefreshContext = createContext(null);

export function ProjectRefreshProvider({ children }) {
  const refreshFnRef = useRef(null);

  const setRefreshFn = useCallback((fn) => {
    refreshFnRef.current = fn;
  }, []);

  const refreshProjects = useCallback(() => {
    if (refreshFnRef.current) {
      refreshFnRef.current();
    }
  }, []);

  return (
    <ProjectRefreshContext.Provider value={{ refreshProjects, setRefreshFn }}>
      {children}
    </ProjectRefreshContext.Provider>
  );
}

export function useProjectRefresh() {
  const ctx = useContext(ProjectRefreshContext);
  if (!ctx) {
    throw new Error('useProjectRefresh must be used within a ProjectRefreshProvider');
  }
  return ctx;
}
