import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { CurrentTenant, CurrentTenantPrincipal } from "../common/decorators/current-tenant.decorator";
import { CurrentUser, CurrentUserPrincipal } from "../common/decorators/current-user.decorator";
import { RequiresTenant } from "../common/decorators/requires-tenant.decorator";
import { RequestContextService } from "../context/request-context.service";
import { intakeActor, ManageIntake } from "./ai-intake.access";
import { AiIntakeService } from "./ai-intake.service";
import { ConfirmIntakeDto, CreateIntakeDto, UpdateIntakeItemDto, UploadUrlDto } from "./dto/ai-intake.dto";

@ApiTags("ai-intake")
@ApiBearerAuth("session")
@ApiUnauthorizedResponse({ description: "AUTH_REQUIRED" })
@ApiForbiddenResponse({ description: "AI_INTAKE_ACCESS_DENIED" })
@RequiresTenant()
@ManageIntake()
@Controller({ path: "ai/intake", version: "1" })
export class AiIntakeController {
  constructor(
    private readonly intake: AiIntakeService,
    private readonly context: RequestContextService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: "Start a product intake",
    description: "Creates an empty draft for the current shop. The client does not send a shop id.",
  })
  async create(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Body() body: CreateIntakeDto,
  ) {
    const data = await this.intake.create(intakeActor(user, tenant), body);
    return { data, requestId: this.requestId() };
  }

  @Post(":intakeId/upload-url")
  @HttpCode(200)
  @ApiOperation({
    summary: "Request an image upload URL",
    description:
      "Returns a short-lived upload URL for JPEG, PNG, or WEBP. Video processing is not enabled in this phase. Storage credentials are not returned.",
  })
  async uploadUrl(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("intakeId") intakeId: string,
    @Body() body: UploadUrlDto,
  ) {
    const data = await this.intake.uploadUrl(intakeActor(user, tenant), intakeId, body);
    return { data, requestId: this.requestId() };
  }

  @Post(":intakeId/process")
  @HttpCode(200)
  @ApiOperation({
    summary: "Analyze an uploaded image",
    description:
      "Turns the image into draft suggestions. A session already being processed returns a conflict. Analysis does not create products or stock.",
  })
  @ApiConflictResponse({ description: "CONFLICT when processing is already running or already finished." })
  async process(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("intakeId") intakeId: string,
  ) {
    const data = await this.intake.process(intakeActor(user, tenant), intakeId);
    return { data, requestId: this.requestId() };
  }

  @Get(":intakeId")
  @ApiNotFoundResponse({ description: "AI_INTAKE_NOT_FOUND" })
  @ApiOperation({ summary: "Read an intake and its draft suggestions" })
  async get(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("intakeId") intakeId: string,
  ) {
    const data = await this.intake.get(intakeActor(user, tenant), intakeId);
    return { data, requestId: this.requestId() };
  }

  @Patch(":intakeId/items/:itemId")
  @ApiOperation({
    summary: "Edit a draft suggestion",
    description: "Updates the draft only. The catalog and inventory are unchanged until confirmation.",
  })
  async updateItem(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("intakeId") intakeId: string,
    @Param("itemId") itemId: string,
    @Body() body: UpdateIntakeItemDto,
  ) {
    const data = await this.intake.updateItem(intakeActor(user, tenant), intakeId, itemId, body);
    return { data, requestId: this.requestId() };
  }

  @Post(":intakeId/items/:itemId/reject")
  @HttpCode(200)
  @ApiOperation({
    summary: "Reject a draft suggestion",
    description: "A rejected suggestion never creates a product or stock.",
  })
  async reject(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("intakeId") intakeId: string,
    @Param("itemId") itemId: string,
  ) {
    const data = await this.intake.reject(intakeActor(user, tenant), intakeId, itemId);
    return { data, requestId: this.requestId() };
  }

  @Post(":intakeId/confirm")
  @HttpCode(200)
  @ApiOperation({
    summary: "Confirm reviewed suggestions",
    description:
      "Creates products through the catalog and, when requested, stock through opening stock or a purchase. The same Idempotency-Key returns the original result.",
  })
  @ApiHeader({ name: "Idempotency-Key", required: false })
  @ApiConflictResponse({ description: "CONFLICT, IDEMPOTENCY_CONFLICT, SKU_ALREADY_EXISTS, or BARCODE_ALREADY_EXISTS." })
  async confirm(
    @CurrentUser() user: CurrentUserPrincipal,
    @CurrentTenant() tenant: CurrentTenantPrincipal,
    @Param("intakeId") intakeId: string,
    @Body() body: ConfirmIntakeDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    const data = await this.intake.confirm(intakeActor(user, tenant), intakeId, body, idempotencyKey);
    return { data, requestId: this.requestId() };
  }

  private requestId(): string | null {
    return this.context.current()?.requestId ?? null;
  }
}
