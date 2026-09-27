import { HttpStatus } from "@nestjs/common";
import { MembershipRole } from "@prisma/client";
import { CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequireRoles } from "../common/decorators/require-roles.decorator";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";

const MANAGERS: readonly MembershipRole[] = [MembershipRole.OWNER, MembershipRole.ADMIN];

const VIEWERS: readonly MembershipRole[] = [
  MembershipRole.OWNER,
  MembershipRole.ADMIN,
  MembershipRole.STOCK_KEEPER,
];

export const ManageExpenses = () =>
  RequireRoles({
    roles: MANAGERS,
    code: ErrorCode.EXPENSE_ACCESS_DENIED,
    message: "You cannot change expenses.",
  });

export const ViewExpenses = () =>
  RequireRoles({
    roles: VIEWERS,
    code: ErrorCode.EXPENSE_ACCESS_DENIED,
    message: "You cannot view expenses.",
  });

export function canViewExpenses(role: string | null): boolean {
  return role !== null && VIEWERS.includes(role as MembershipRole);
}

export function expenseActor(user: CurrentUserPrincipal, tenant: CurrentTenantPrincipal) {
  if (!tenant.role) {
    throw new AppException(
      ErrorCode.EXPENSE_ACCESS_DENIED,
      "You cannot view expenses.",
      HttpStatus.FORBIDDEN,
    );
  }
  return { tenantId: tenant.tenantId, userId: user.id, role: tenant.role };
}
