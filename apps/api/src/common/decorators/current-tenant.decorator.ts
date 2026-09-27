import { createParamDecorator, HttpStatus } from "@nestjs/common";
import { RequestStore, requestContextStorage } from "../../context/request-store";
import { AppException } from "../errors/app.exception";
import { ErrorCode } from "../errors/error-codes";

export interface CurrentTenantPrincipal {
  tenantId: string;
  role: string | null;
}

/**
 * Shop id comes from server context after membership is verified.
 * This decorator does not read headers or the request body.
 */
export function readCurrentTenant(
  store: RequestStore | undefined,
): CurrentTenantPrincipal {
  if (!store?.tenantId) {
    if (store?.userId) {
      throw new AppException(
        ErrorCode.TENANT_NOT_SELECTED,
        "Select a shop before continuing.",
        HttpStatus.BAD_REQUEST,
      );
    }
    throw new AppException(
      ErrorCode.TENANT_REQUIRED,
      "Shop context is required.",
      HttpStatus.BAD_REQUEST,
    );
  }
  return { tenantId: store.tenantId, role: store.role };
}

export const CurrentTenant = createParamDecorator(
  (): CurrentTenantPrincipal => {
    return readCurrentTenant(requestContextStorage.getStore());
  },
);
