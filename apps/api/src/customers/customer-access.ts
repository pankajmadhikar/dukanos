import { HttpStatus } from "@nestjs/common";
import { CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";

export function customerActor(user: CurrentUserPrincipal, tenant: CurrentTenantPrincipal) {
  if (!tenant.role) {
    throw new AppException(
      ErrorCode.TENANT_ACCESS_DENIED,
      "You cannot use customers for this shop.",
      HttpStatus.FORBIDDEN,
    );
  }
  return { tenantId: tenant.tenantId, userId: user.id, role: tenant.role };
}
