import { create } from "zustand";

export interface ShopUser {
  id: string;
  name: string;
  phone: string;
}

export interface SelectedShop {
  id: string;
  name: string;
  role: string;
  shopContext: string;
}

interface SessionState {
  token: string | null;
  user: ShopUser | null;
  shop: SelectedShop | null;
  setLogin: (token: string, user: ShopUser) => void;
  setShop: (shop: SelectedShop) => void;
  clearShop: () => void;
  clear: () => void;
}

const TOKEN_KEY = "dukaan.token";
const USER_KEY = "dukaan.user";
const SHOP_KEY = "dukaan.shop";

function readJson<T>(key: string): T | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const useSession = create<SessionState>((set) => ({
  token: sessionStorage.getItem(TOKEN_KEY),
  user: readJson<ShopUser>(USER_KEY),
  shop: readJson<SelectedShop>(SHOP_KEY),
  setLogin: (token, user) => {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    sessionStorage.removeItem(SHOP_KEY);
    set({ token, user, shop: null });
  },
  setShop: (shop) => {
    sessionStorage.setItem(SHOP_KEY, JSON.stringify(shop));
    set({ shop });
  },
  clearShop: () => {
    sessionStorage.removeItem(SHOP_KEY);
    set({ shop: null });
  },
  clear: () => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(SHOP_KEY);
    set({ token: null, user: null, shop: null });
  },
}));
