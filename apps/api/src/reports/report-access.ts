import { HttpStatus } from "@nestjs/common";
import { MembershipRole } from "@prisma/client";
import { CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequireRoles } from "../common/decorators/require-roles.decorator";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";

const CLOSERS: readonly MembershipRole[] = [MembershipRole.OWNER, MembershipRole.ADMIN];

export const CloseTheDay = () =>
  RequireRoles({
    roles: CLOSERS,
    code: ErrorCode.DAILY_CLOSING_ACCESS_DENIED,
    message: "You cannot close the day.",
  });

export function reportActor(user: CurrentUserPrincipal, tenant: CurrentTenantPrincipal) {
  if (!tenant.role) {
    throw new AppException(
      ErrorCode.TENANT_ACCESS_DENIED,
      "You cannot view reports for this shop.",
      HttpStatus.FORBIDDEN,
    );
  }
  return { tenantId: tenant.tenantId, userId: user.id, role: tenant.role as MembershipRole };
}
