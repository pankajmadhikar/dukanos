import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestStore {
  requestId: string | null;
  userId: string | null;
  tenantId: string | null;
  sessionId: string | null;
  deviceId: string | null;
  role: string | null;
}

export const requestContextStorage = new AsyncLocalStorage<RequestStore>();
