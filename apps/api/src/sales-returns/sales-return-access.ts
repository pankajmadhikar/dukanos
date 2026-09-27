import { HttpStatus } from "@nestjs/common";
import { MembershipRole } from "@prisma/client";
import { CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequireRoles } from "../common/decorators/require-roles.decorator";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";

const RETURN_ROLES: readonly MembershipRole[] = [
  MembershipRole.OWNER,
  MembershipRole.ADMIN,
  MembershipRole.STOCK_KEEPER,
];

export const ManageSaleReturns = () =>
  RequireRoles({
    roles: RETURN_ROLES,
    code: ErrorCode.RETURN_NOT_ALLOWED,
    message: "You cannot record or view a sales return.",
  });

export function saleReturnActor(user: CurrentUserPrincipal, tenant: CurrentTenantPrincipal) {
  if (!tenant.role || !RETURN_ROLES.includes(tenant.role as MembershipRole)) {
    throw new AppException(
      ErrorCode.RETURN_NOT_ALLOWED,
      "You cannot record or view a sales return.",
      HttpStatus.FORBIDDEN,
    );
  }
  return { tenantId: tenant.tenantId, userId: user.id, role: tenant.role };
}
