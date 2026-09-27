import { Injectable } from "@nestjs/common";
import { HttpStatus } from "@nestjs/common";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { DatabaseHealthIndicator } from "../database/database-health.indicator";
import { HealthLiveDto, HealthReadyDto } from "./dto/health-response.dto";

@Injectable()
export class HealthService {
  constructor(private readonly database: DatabaseHealthIndicator) {}

  live(requestId: string | null): HealthLiveDto {
    return { status: "ok", service: "dukaanos-api", requestId };
  }

  async ready(requestId: string | null): Promise<HealthReadyDto> {
    try {
      await this.database.ping();
    } catch {
      throw new AppException(
        ErrorCode.DATABASE_ERROR,
        "Database is unavailable.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: "ok", database: "up", requestId };
  }
}
