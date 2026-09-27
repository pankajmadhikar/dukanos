import { HttpStatus } from "@nestjs/common";
import { MembershipRole } from "@prisma/client";
import { CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequireRoles } from "../common/decorators/require-roles.decorator";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";

const MANAGERS: readonly MembershipRole[] = [
  MembershipRole.OWNER,
  MembershipRole.ADMIN,
  MembershipRole.STOCK_KEEPER,
];

export const ManagePurchases = () =>
  RequireRoles({
    roles: MANAGERS,
    code: ErrorCode.PURCHASE_ACCESS_DENIED,
    message: "You cannot view or change purchases.",
  });

export function canSeePurchaseCost(role: string | null): boolean {
  return role !== null && MANAGERS.includes(role as MembershipRole);
}

export function purchaseActor(user: CurrentUserPrincipal, tenant: CurrentTenantPrincipal) {
  if (!tenant.role) {
    throw new AppException(
      ErrorCode.PURCHASE_ACCESS_DENIED,
      "You cannot view or change purchases.",
      HttpStatus.FORBIDDEN,
    );
  }
  return { tenantId: tenant.tenantId, userId: user.id, role: tenant.role };
}
