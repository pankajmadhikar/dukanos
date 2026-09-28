import { create } from "zustand";

interface ToastState {
  message: string | null;
  show: (message: string) => void;
  hide: () => void;
}

export const useToast = create<ToastState>((set) => ({
  message: null,
  show: (message) => {
    set({ message });
    window.setTimeout(() => set({ message: null }), 2400);
  },
  hide: () => set({ message: null }),
}));
