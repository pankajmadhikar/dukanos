import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { AppConfigService } from "../common/config/app-config.service";
import { AppLogger } from "../common/logging/app-logger.service";

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

/**
 * One Prisma client for the process. It connects as dukaan_app.
 * Shop queries still go through TenantTransactionService so the tenant
 * GUC is transaction-local. Do not add a second client.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(
    config: AppConfigService,
    private readonly logger: AppLogger,
  ) {
    const datasourceUrl =
      config.nodeEnv === "test"
        ? withConnectionLimit(config.databaseUrl, testPoolSize())
        : config.databaseUrl;
    this.client = new PrismaClient({
      datasourceUrl,
      errorFormat: "minimal",
    });
    this.expectedRole = config.databaseAppRole;
  }

  private readonly expectedRole: string;

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    const rows = await this.client.$queryRaw<RoleRow[]>`
      SELECT rolname, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
    `;
    const role = rows[0];
    if (!role) {
      throw new Error("Refusing to start: could not read the database role.");
    }
    if (role.rolsuper || role.rolbypassrls) {
      throw new Error(
        `Refusing to start: database role ${role.rolname} bypasses row-level security.`,
      );
    }
    if (role.rolname !== this.expectedRole) {
      throw new Error(
        `Refusing to start: connected as ${role.rolname}, expected ${this.expectedRole}.`,
      );
    }
    this.logger.write({
      level: "info",
      message: `database connected as ${role.rolname}`,
      module: "database",
      operation: "connect",
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

function testPoolSize(): number {
  const raw = process.env.PRISMA_CONNECTION_LIMIT ?? "1";
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 1 || size > 10) {
    return 1;
  }
  return size;
}

function withConnectionLimit(databaseUrl: string, limit: number): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("connection_limit", String(limit));
  return url.toString();
}
