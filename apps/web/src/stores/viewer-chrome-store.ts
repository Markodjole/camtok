import { create } from "zustand";

const STAKE_STORAGE_KEY = "bettok_last_stake_amount";
const MUTE_STORAGE_KEY = "bettok_is_muted";
const VALID_AMOUNTS = [1, 2, 5, 10, 20, 50];

function getStoredStakeAmount(): number {
  if (typeof window === "undefined") return 10;
  try {
    const stored = localStorage.getItem(STAKE_STORAGE_KEY);
    const n = stored ? parseInt(stored, 10) : NaN;
    return VALID_AMOUNTS.includes(n) ? n : 10;
  } catch {
    return 10;
  }
}

function getStoredMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(MUTE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

interface ViewerChromeState {
  /** Which live tile is centered in the vertical snap list (`/live`). */
  liveSnapIndex: number;
  isMuted: boolean;
  lastStakeAmount: number;
  /** Bumped after a successful bet so /bets can refetch the list */
  myBetsRevision: number;
  setLiveSnapIndex: (index: number) => void;
  hydratePreferences: () => void;
  toggleMute: () => void;
  setLastStakeAmount: (amount: number) => void;
  bumpMyBetsRevision: () => void;
}

export const useViewerChromeStore = create<ViewerChromeState>((set) => ({
  liveSnapIndex: 0,
  isMuted: false,
  lastStakeAmount: 10,
  myBetsRevision: 0,
  setLiveSnapIndex: (liveSnapIndex) => set({ liveSnapIndex }),
  hydratePreferences: () => {
    set({
      isMuted: getStoredMuted(),
      lastStakeAmount: getStoredStakeAmount(),
    });
  },
  toggleMute: () =>
    set((s) => {
      const next = !s.isMuted;
      try {
        localStorage.setItem(MUTE_STORAGE_KEY, String(next));
      } catch {
        /* ignore */
      }
      return { isMuted: next };
    }),
  setLastStakeAmount: (amount: number) => {
    if (VALID_AMOUNTS.includes(amount)) {
      try {
        localStorage.setItem(STAKE_STORAGE_KEY, String(amount));
      } catch {
        /* ignore */
      }
      set({ lastStakeAmount: amount });
    }
  },
  bumpMyBetsRevision: () => set((s) => ({ myBetsRevision: s.myBetsRevision + 1 })),
}));
