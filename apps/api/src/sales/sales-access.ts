import { HttpStatus } from "@nestjs/common";
import { MembershipRole } from "@prisma/client";
import { CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";

const PROFIT_ROLES: readonly MembershipRole[] = [MembershipRole.OWNER, MembershipRole.ADMIN];

export function canSeeSaleProfit(role: string | null): boolean {
  return role !== null && PROFIT_ROLES.includes(role as MembershipRole);
}

export function saleActor(user: CurrentUserPrincipal, tenant: CurrentTenantPrincipal) {
  if (!tenant.role) {
    throw new AppException(
      ErrorCode.TENANT_ACCESS_DENIED,
      "You cannot use sales for this shop.",
      HttpStatus.FORBIDDEN,
    );
  }
  return { tenantId: tenant.tenantId, userId: user.id, role: tenant.role };
}
