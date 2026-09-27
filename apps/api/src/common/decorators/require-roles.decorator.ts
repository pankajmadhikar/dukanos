import { SetMetadata } from "@nestjs/common";
import { ErrorCode } from "../errors/error-codes";

export const ROLES_KEY = "dukaan_roles";

export interface RoleRule {
  roles: readonly string[];
  code: ErrorCode;
  message: string;
}

export const RequireRoles = (rule: RoleRule) => SetMetadata(ROLES_KEY, rule);
