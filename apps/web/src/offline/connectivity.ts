import { create } from "zustand";

interface OfflineUi {
  browserOnline: boolean;
  apiReachable: boolean;
  waiting: number;
  attention: number;
  catalogUpdatedAt: string | null;
  signInAgain: boolean;
  lastSynced: number;
  setBrowserOnline: (online: boolean) => void;
  setApiReachable: (reachable: boolean) => void;
  setCounts: (waiting: number, attention: number) => void;
  setCatalogUpdatedAt: (value: string | null) => void;
  setSignInAgain: (value: boolean) => void;
  noteSynced: (count: number) => void;
}

export const useOffline = create<OfflineUi>((set) => ({
  browserOnline: typeof navigator === "undefined" ? true : navigator.onLine,
  apiReachable: true,
  waiting: 0,
  attention: 0,
  catalogUpdatedAt: null,
  signInAgain: false,
  lastSynced: 0,
  setBrowserOnline: (browserOnline) => set({ browserOnline }),
  setApiReachable: (apiReachable) => set({ apiReachable }),
  setCounts: (waiting, attention) => set({ waiting, attention }),
  setCatalogUpdatedAt: (catalogUpdatedAt) => set({ catalogUpdatedAt }),
  setSignInAgain: (signInAgain) => set({ signInAgain }),
  noteSynced: (count) => set((state) => ({ lastSynced: state.lastSynced + count, signInAgain: false, apiReachable: true })),
}));

export function posIsOnline(): boolean {
  const state = useOffline.getState();
  return state.browserOnline && state.apiReachable;
}

export function usePosOnline(): boolean {
  const browserOnline = useOffline((state) => state.browserOnline);
  const apiReachable = useOffline((state) => state.apiReachable);
  return browserOnline && apiReachable;
}
