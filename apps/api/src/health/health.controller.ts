import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "../common/decorators/public.decorator";
import { RequestContextService } from "../context/request-context.service";
import { HealthLiveDto, HealthReadyDto } from "./dto/health-response.dto";
import { HealthService } from "./health.service";

@ApiTags("health")
@Public()
@Controller({ path: "health", version: "1" })
export class HealthController {
  constructor(
    private readonly health: HealthService,
    private readonly context: RequestContextService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Process liveness" })
  @ApiOkResponse({ type: HealthLiveDto })
  live(): HealthLiveDto {
    return this.health.live(this.requestId());
  }

  @Get("live")
  @ApiOperation({ summary: "Process liveness" })
  @ApiOkResponse({ type: HealthLiveDto })
  liveProbe(): HealthLiveDto {
    return this.health.live(this.requestId());
  }

  @Get("ready")
  @ApiOperation({ summary: "PostgreSQL readiness" })
  @ApiOkResponse({ type: HealthReadyDto })
  ready(): Promise<HealthReadyDto> {
    return this.health.ready(this.requestId());
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
