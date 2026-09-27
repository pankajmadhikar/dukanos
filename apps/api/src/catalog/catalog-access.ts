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

export const ManageCatalog = () =>
  RequireRoles({
    roles: MANAGERS,
    code: ErrorCode.CATALOG_ACCESS_DENIED,
    message: "You cannot change the catalog.",
  });

export function canSeeCost(role: string | null): boolean {
  return role !== null && MANAGERS.includes(role as MembershipRole);
}

export function catalogActor(user: CurrentUserPrincipal, tenant: CurrentTenantPrincipal) {
  if (!tenant.role) {
    throw new AppException(
      ErrorCode.CATALOG_ACCESS_DENIED,
      "You cannot change the catalog.",
      HttpStatus.FORBIDDEN,
    );
  }
  return { tenantId: tenant.tenantId, userId: user.id, role: tenant.role };
}

export function activeFilter(value: string | undefined): boolean | null {
  if (value === undefined || value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "all") {
    return null;
  }
  throw new AppException(
    ErrorCode.VALIDATION_ERROR,
    "isActive must be true, false, or all.",
    HttpStatus.BAD_REQUEST,
  );
}

export function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      `${label} is invalid.`,
      HttpStatus.BAD_REQUEST,
    );
  }
}
