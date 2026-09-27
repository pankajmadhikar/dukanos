import { SetMetadata } from "@nestjs/common";

export const REQUIRES_TENANT_KEY = "dukaan_requires_tenant";

export const RequiresTenant = () => SetMetadata(REQUIRES_TENANT_KEY, true);
