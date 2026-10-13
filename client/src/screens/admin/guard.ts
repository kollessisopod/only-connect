import { createContext, useContext, useEffect } from 'react';

/** Lets the pack editor tell the shell about unsaved changes so in-app navigation can be confirmed. */
export interface DirtyGuard {
  dirty: boolean;
  setDirty: (dirty: boolean) => void;
}

export const DirtyContext = createContext<DirtyGuard>({ dirty: false, setDirty: () => undefined });

/** Reports `dirty` to the shell and warns on tab close / reload while there are unsaved changes. */
export function useDirtyGuard(dirty: boolean): void {
  const { setDirty } = useContext(DirtyContext);
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}
