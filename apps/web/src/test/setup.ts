import "@testing-library/jest-dom/vitest";

const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init?.signal) {
      const rest = { ...init };
      delete rest.signal;
      super(input, rest);
      return;
    }
    super(input, init);
  }
};

if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:preview";
}
if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = () => undefined;
}
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { useOffline } from "../offline/connectivity";
import { useSession } from "../stores/session";
import { useCart } from "../stores/cart";

afterEach(() => {
  cleanup();
  useSession.getState().clear();
  useCart.getState().clear();
  useOffline.setState({
    browserOnline: true,
    apiReachable: true,
    waiting: 0,
    attention: 0,
    catalogUpdatedAt: null,
    signInAgain: false,
    lastSynced: 0,
  });
});
