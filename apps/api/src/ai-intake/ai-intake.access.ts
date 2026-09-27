import { HttpStatus } from "@nestjs/common";
import { MembershipRole } from "@prisma/client";
import { CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequireRoles } from "../common/decorators/require-roles.decorator";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";

const ROLES: readonly MembershipRole[] = [
  MembershipRole.OWNER,
  MembershipRole.ADMIN,
  MembershipRole.STOCK_KEEPER,
];

export const ManageIntake = () =>
  RequireRoles({
    roles: ROLES,
    code: ErrorCode.AI_INTAKE_ACCESS_DENIED,
    message: "You cannot use product intake.",
  });

export interface IntakeActor {
  tenantId: string;
  userId: string;
  role: string;
}

export function intakeActor(user: CurrentUserPrincipal, tenant: CurrentTenantPrincipal): IntakeActor {
  if (!tenant.role || !ROLES.includes(tenant.role as MembershipRole)) {
    throw new AppException(
      ErrorCode.AI_INTAKE_ACCESS_DENIED,
      "You cannot use product intake.",
      HttpStatus.FORBIDDEN,
    );
  }
  return { tenantId: tenant.tenantId, userId: user.id, role: tenant.role };
}
