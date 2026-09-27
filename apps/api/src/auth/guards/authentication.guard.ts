import { CanActivate, ExecutionContext, HttpStatus, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { AppConfigService } from "../../common/config/app-config.service";
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";
import { REQUIRES_TENANT_KEY } from "../../common/decorators/requires-tenant.decorator";
import { ROLES_KEY, RoleRule } from "../../common/decorators/require-roles.decorator";
import { AppException } from "../../common/errors/app.exception";
import { ErrorCode } from "../../common/errors/error-codes";
import { RequestContextService } from "../../context/request-context.service";
import { AuthContextService } from "../auth-context.service";

/**
 * Resolves the bearer session and, when present, the server-issued shop grant.
 * x-tenant-id and body tenantId are ignored.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: RequestContextService,
    private readonly config: AppConfigService,
    private readonly access: AuthContextService,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const request = execution.switchToHttp().getRequest<Request>();
    if (this.isOpenApiPath(request.path)) {
      return true;
    }

    const resolved = await this.access.resolve(request);
    const parent = this.context.current();
    if (parent) {
      parent.userId = resolved.userId;
      parent.tenantId = resolved.tenantId;
      parent.sessionId = resolved.sessionId;
      parent.role = resolved.role;
    } else {
      this.context.enter({
        requestId: null,
        userId: resolved.userId,
        tenantId: resolved.tenantId,
        sessionId: resolved.sessionId,
        deviceId: null,
        role: resolved.role,
      });
    }

    const requiresTenant = this.reflector.getAllAndOverride<boolean>(REQUIRES_TENANT_KEY, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (requiresTenant && !resolved.tenantId) {
      if (resolved.shopError) {
        throw resolved.shopError;
      }
      throw new AppException(
        ErrorCode.TENANT_NOT_SELECTED,
        "Select a shop before continuing.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const roleRule = this.reflector.getAllAndOverride<RoleRule | undefined>(ROLES_KEY, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (roleRule && !roleRule.roles.includes(resolved.role ?? "")) {
      throw new AppException(roleRule.code, roleRule.message, HttpStatus.FORBIDDEN);
    }
    return true;
  }

  private isOpenApiPath(path: string): boolean {
    if (!this.config.swaggerEnabled) {
      return false;
    }
    const docs = `/${this.config.apiPrefix}/docs`;
    return path === docs || path.startsWith(`${docs}/`) || path === `${docs}-json`;
  }
}
