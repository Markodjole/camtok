import { create } from "zustand";

const STAKE_STORAGE_KEY = "bettok_last_stake_amount";
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

interface FeedState {
  currentIndex: number;
  isMuted: boolean;
  lastStakeAmount: number;
  setCurrentIndex: (index: number) => void;
  toggleMute: () => void;
  setLastStakeAmount: (amount: number) => void;
}

export const useFeedStore = create<FeedState>((set) => ({
  currentIndex: 0,
  isMuted: true,
  lastStakeAmount: 10,
  setCurrentIndex: (currentIndex) => set({ currentIndex }),
  toggleMute: () => set((s) => ({ isMuted: !s.isMuted })),
  setLastStakeAmount: (amount: number) => {
    if (VALID_AMOUNTS.includes(amount)) {
      try {
        localStorage.setItem(STAKE_STORAGE_KEY, String(amount));
      } catch {}
      set({ lastStakeAmount: amount });
    }
  },
}));
