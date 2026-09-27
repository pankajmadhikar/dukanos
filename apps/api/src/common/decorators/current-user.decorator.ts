import { createParamDecorator, HttpStatus } from "@nestjs/common";
import { RequestStore, requestContextStorage } from "../../context/request-store";
import { AppException } from "../errors/app.exception";
import { ErrorCode } from "../errors/error-codes";

export interface CurrentUserPrincipal {
  id: string;
  sessionId: string | null;
}

export function readCurrentUser(
  store: RequestStore | undefined,
): CurrentUserPrincipal {
  if (!store?.userId) {
    throw new AppException(
      ErrorCode.AUTH_REQUIRED,
      "Authentication is required.",
      HttpStatus.UNAUTHORIZED,
    );
  }
  return { id: store.userId, sessionId: store.sessionId };
}

/** Reads the user established from the server session. */
export const CurrentUser = createParamDecorator((): CurrentUserPrincipal => {
  return readCurrentUser(requestContextStorage.getStore());
});
