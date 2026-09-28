import { create } from "zustand";

export interface CartLine {
  productId: string;
  name: string;
  quantity: string;
  listPrice: string | null;
  stock: string | null;
}

interface CartState {
  lines: CartLine[];
  customerId: string | null;
  customerName: string | null;
  add: (line: Omit<CartLine, "quantity"> & { quantity?: string }) => void;
  setQuantity: (productId: string, quantity: string) => void;
  remove: (productId: string) => void;
  setCustomer: (customer: { id: string; name: string } | null) => void;
  clear: () => void;
}

export const useCart = create<CartState>((set) => ({
  lines: [],
  customerId: null,
  customerName: null,
  add: (line) =>
    set((state) => {
      const existing = state.lines.find((item) => item.productId === line.productId);
      if (existing) {
        return {
          lines: state.lines.map((item) =>
            item.productId === line.productId
              ? { ...item, quantity: addQty(item.quantity, line.quantity ?? "1") }
              : item,
          ),
        };
      }
      return {
        lines: [...state.lines, { ...line, quantity: line.quantity ?? "1" }],
      };
    }),
  setQuantity: (productId, quantity) =>
    set((state) => ({
      lines: state.lines.map((item) => (item.productId === productId ? { ...item, quantity } : item)),
    })),
  remove: (productId) => set((state) => ({ lines: state.lines.filter((item) => item.productId !== productId) })),
  setCustomer: (customer) =>
    set({
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? null,
    }),
  clear: () => set({ lines: [], customerId: null, customerName: null }),
}));

function addQty(current: string, extra: string): string {
  const left = Number.parseInt(current, 10);
  const right = Number.parseInt(extra, 10);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return current;
  }
  return String(left + right);
}
