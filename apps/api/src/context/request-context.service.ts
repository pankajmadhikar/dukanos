import { Injectable } from "@nestjs/common";
import { RequestStore, requestContextStorage } from "./request-store";

/**
 * Request-scoped values live in AsyncLocalStorage.
 * There is no process-wide current user or current shop.
 */
@Injectable()
export class RequestContextService {
  current(): RequestStore | undefined {
    return requestContextStorage.getStore();
  }

  enter(store: RequestStore): void {
    requestContextStorage.enterWith(store);
  }

  run<T>(store: RequestStore, work: () => T): T {
    return requestContextStorage.run(store, work);
  }
}
