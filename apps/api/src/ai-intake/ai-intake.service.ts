import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { AiIntakeStatus, AiItemStatus, AiSourceType, Prisma } from "@prisma/client";
import { AuditRecorder } from "../audit/audit-recorder";
import { formatMoney, formatStock, parseMoney, parseStock } from "../catalog/decimal";
import { ProductService } from "../catalog/product.service";
import { normalizeBarcode, normalizeName, normalizeSku } from "../catalog/text";
import { AppLogger } from "../common/logging/app-logger.service";
import { AppException } from "../common/errors/app.exception";
import { ErrorCode } from "../common/errors/error-codes";
import { ShopDb } from "../database/prisma.types";
import { TenantTransactionService } from "../database/tenant-transaction.service";
import { InventoryService } from "../inventory/inventory.service";
import { digest, normalizeKey } from "../payments/settlement-support";
import { PurchaseService } from "../purchases/purchase.service";
import { IntakeActor } from "./ai-intake.access";
import { AiIntakeRateLimiter } from "./ai-intake-rate-limiter";
import { AiIntakeQueue, IntakeJob } from "./ai-intake.queue";
import {
  AI_CLIENT_FAILURE,
  AI_PRODUCT_INTAKE_PROVIDER,
  AiAnalysisError,
  AiDetectedItem,
  AiProductIntakeProvider,
  AiProviderFailureCode,
} from "./ai-product-intake.provider";
import { validateProviderPayload } from "./ai-output";
import { ConfirmIntakeDto, CreateIntakeDto, UpdateIntakeItemDto, UploadUrlDto } from "./dto/ai-intake.dto";
import { displayStatus, idleJob, IntakeJobState, isStale, readJob } from "./intake-job";
import { matchCandidate, ProductMatch } from "./intake-match";
import { assertStoredObject, assertTenantObjectKey, assertUpload, intakeObjectKey, PENDING_MEDIA } from "./intake-media";
import { intakeSettings, retryDelayMs } from "./intake-settings";
import { OBJECT_STORAGE, ObjectStorage, PresignedDownload, PresignedUpload } from "./object-storage";

const COUNTABLE_ACTIONS = ["ai_intake.processed", "ai_intake.processing_failed"] as const;

interface UploadMeta {
  fileName: string;
  contentType: string;
  size: number;
  objectKey: string;
  verified: boolean;
  deletedAt: string | null;
}

interface ClaimedIntake {
  generation: number;
  attempts: number;
  upload: UploadMeta;
}

interface EditedFields {
  barcode?: string | null;
  sku?: string | null;
  unit?: string | null;
  brand?: string | null;
  category?: string | null;
}

interface Suggestion {
  matchType: string;
  needsReview: boolean;
  possibleProductId: string | null;
  suggestedSku: string | null;
  suggestedUnit: string | null;
  edited?: EditedFields;
}

interface ItemRow {
  id: string;
  position: number;
  detectedName: string | null;
  suggestedCategoryName: string | null;
  suggestedBrandName: string | null;
  suggestedBarcode: string | null;
  suggestedQuantity: Prisma.Decimal | null;
  suggestedPurchasePrice: Prisma.Decimal | null;
  suggestedSellingPrice: Prisma.Decimal | null;
  confidence: Prisma.Decimal | null;
  editedName: string | null;
  editedQuantity: Prisma.Decimal | null;
  editedPurchasePrice: Prisma.Decimal | null;
  editedSellingPrice: Prisma.Decimal | null;
  status: AiItemStatus;
  matchedProductId: string | null;
  rawSuggestion: Prisma.JsonValue;
}

export interface IntakeItemView {
  id: string;
  position: number;
  status: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  barcode: string | null;
  sku: string | null;
  unit: string | null;
  quantity: string | null;
  purchasePrice: string | null;
  sellingPrice: string | null;
  confidence: string | null;
  matchType: string;
  reviewStatus: string;
  needsReview: boolean;
  matchedProduct: { id: string; name: string } | null;
  possibleProduct: { id: string; name: string } | null;
}

export interface IntakeSessionView {
  id: string;
  status: string;
  sourceType: string;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
  processingAttempts: number;
  canRetry: boolean;
  media: UploadMeta | null;
  items: IntakeItemView[];
}

export interface ConfirmResult {
  intakeId: string;
  status: string;
  mode: string;
  items: Array<{ itemId: string; productId: string; created: boolean }>;
  purchaseId: string | null;
  purchaseNumber: string | null;
}

interface DraftLine {
  row: ItemRow;
  name: string;
  barcode: string | null;
  sku: string | null;
  unit: string | null;
  brand: string | null;
  category: string | null;
  quantity: Prisma.Decimal | null;
  purchasePrice: Prisma.Decimal | null;
  sellingPrice: Prisma.Decimal | null;
  matchedProductId: string | null;
}

/**
 * Intake lifecycle only. Product and stock writes go through catalog,
 * opening stock, and purchase services inside the confirmation transaction.
 */
@Injectable()
export class AiIntakeService {
  constructor(
    private readonly transactions: TenantTransactionService,
    private readonly products: ProductService,
    private readonly inventory: InventoryService,
    private readonly purchases: PurchaseService,
    private readonly audit: AuditRecorder,
    private readonly logger: AppLogger,
    @Inject(AI_PRODUCT_INTAKE_PROVIDER) private readonly provider: AiProductIntakeProvider,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly queue: AiIntakeQueue,
    private readonly limiter: AiIntakeRateLimiter,
  ) {}

  async create(actor: IntakeActor, input: CreateIntakeDto): Promise<{ id: string; status: string; createdAt: string }> {
    if (input.sourceType !== undefined && input.sourceType !== "IMAGE") {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Video processing is not enabled in this phase.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const created = await this.transactions.run(actor, async (tx) => {
      const session = await tx.aiIntakeSession.create({
        data: {
          tenantId: actor.tenantId,
          createdBy: actor.userId,
          sourceType: AiSourceType.IMAGE,
          mediaReference: PENDING_MEDIA,
          status: AiIntakeStatus.UPLOADED,
        },
        select: { id: true, status: true, createdAt: true },
      });
      await this.audit.write(tx, {
        action: "ai_intake.created",
        entityType: "ai_intake_session",
        entityId: session.id,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
      });
      return session;
    });
    this.logger.write({
      level: "info",
      message: "ai_intake_created",
      module: "ai-intake",
      operation: created.id,
    });
    return {
      id: created.id,
      status: created.status,
      createdAt: created.createdAt.toISOString(),
    };
  }

  async uploadUrl(actor: IntakeActor, intakeId: string, input: UploadUrlDto): Promise<PresignedUpload & { objectKey: string }> {
    assertUuid(intakeId);
    const settings = intakeSettings();
    const checked = assertUpload(input.fileName, input.contentType, input.size, settings.maxBytes);
    const objectKey = intakeObjectKey(actor.tenantId, intakeId, checked.extension);
    await this.transactions.run(actor, async (tx) => {
      const session = await this.lockSession(tx, actor.tenantId, intakeId);
      if (session.status !== AiIntakeStatus.UPLOADED && session.status !== AiIntakeStatus.FAILED) {
        throw new AppException(
          ErrorCode.CONFLICT,
          "This intake cannot accept an upload.",
          HttpStatus.CONFLICT,
        );
      }
      await tx.aiIntakeItem.deleteMany({ where: { tenantId: actor.tenantId, sessionId: intakeId } });
      const upload: UploadMeta = {
        fileName: input.fileName,
        contentType: checked.contentType,
        size: input.size,
        objectKey,
        verified: false,
        deletedAt: null,
      };
      await tx.aiIntakeSession.update({
        where: { id: intakeId },
        data: {
          mediaReference: objectKey,
          sourceType: AiSourceType.IMAGE,
          status: AiIntakeStatus.UPLOADED,
          failureReason: null,
          completedAt: null,
          rawOutput: sessionDocument(upload, idleJob()),
        },
      });
    });
    const signed = await this.storage.createUploadUrl({
      objectKey,
      contentType: checked.contentType,
      size: input.size,
      expiresInSeconds: settings.uploadUrlTtlSeconds,
    });
    return { ...signed, objectKey };
  }

  async process(actor: IntakeActor, intakeId: string, ip?: string): Promise<IntakeSessionView> {
    return this.queueIntake(actor, intakeId, ip, false);
  }

  async retry(actor: IntakeActor, intakeId: string, ip?: string): Promise<IntakeSessionView> {
    return this.queueIntake(actor, intakeId, ip, true);
  }

  async mediaUrl(actor: IntakeActor, intakeId: string): Promise<PresignedDownload> {
    assertUuid(intakeId);
    const upload = await this.transactions.run(actor, async (tx) => {
      const session = await this.lockSession(tx, actor.tenantId, intakeId);
      const stored = readUpload(session.rawOutput);
      if (!stored || stored.deletedAt || session.mediaReference === PENDING_MEDIA) {
        throw new AppException(
          ErrorCode.AI_INTAKE_MEDIA_NOT_FOUND,
          "The image is no longer available.",
          HttpStatus.NOT_FOUND,
        );
      }
      assertTenantObjectKey(actor.tenantId, intakeId, stored.objectKey);
      return stored;
    });
    const head = await this.storage.headObject(upload.objectKey);
    if (!head) {
      throw new AppException(
        ErrorCode.AI_INTAKE_MEDIA_NOT_FOUND,
        "The image is no longer available.",
        HttpStatus.NOT_FOUND,
      );
    }
    return this.storage.createDownloadUrl({
      objectKey: upload.objectKey,
      expiresInSeconds: intakeSettings().downloadUrlTtlSeconds,
    });
  }

  async get(actor: IntakeActor, intakeId: string): Promise<IntakeSessionView> {
    assertUuid(intakeId);
    await this.cleanupExpiredMedia(actor, intakeId);
    return this.transactions.run(actor, async (tx) => {
      const session = await this.lockSession(tx, actor.tenantId, intakeId);
      await this.markStale(tx, actor, session);
      return this.loadView(tx, actor.tenantId, intakeId);
    });
  }

  /**
   * Shop-scoped media cleanup. Row security hides other shops, so this does
   * not scan the whole database. Active review and in-flight jobs are kept.
   */
  async cleanupExpiredMedia(actor: IntakeActor, exceptId?: string): Promise<number> {
    const cutoff = new Date(Date.now() - intakeSettings().mediaRetentionDays * 24 * 60 * 60 * 1000);
    const candidates = await this.transactions.run(actor, async (tx) => {
      const rows = await tx.aiIntakeSession.findMany({
        where: {
          tenantId: actor.tenantId,
          status: { in: [AiIntakeStatus.UPLOADED, AiIntakeStatus.FAILED, AiIntakeStatus.CONFIRMED] },
          createdAt: { lt: cutoff },
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        select: { id: true, rawOutput: true, mediaReference: true },
        take: 20,
      });
      return rows.flatMap((row) => {
        const upload = readUpload(row.rawOutput);
        const job = readJob(row.rawOutput);
        if (!upload || upload.deletedAt || row.mediaReference === PENDING_MEDIA) {
          return [];
        }
        if (job.state === "QUEUED" || job.state === "PROCESSING") {
          return [];
        }
        return [{ id: row.id, objectKey: upload.objectKey }];
      });
    });
    let removed = 0;
    for (const row of candidates) {
      await this.storage.deleteObject(row.objectKey);
      await this.transactions.run(actor, async (tx) => {
        const session = await this.lockSession(tx, actor.tenantId, row.id);
        const upload = readUpload(session.rawOutput);
        const job = readJob(session.rawOutput);
        if (!upload || upload.objectKey !== row.objectKey || upload.deletedAt) {
          return;
        }
        if (job.state === "QUEUED" || job.state === "PROCESSING") {
          return;
        }
        await tx.aiIntakeSession.update({
          where: { id: row.id },
          data: { rawOutput: sessionDocument({ ...upload, deletedAt: new Date().toISOString() }, job) },
        });
        await this.audit.write(tx, {
          action: "ai_intake.media_deleted",
          entityType: "ai_intake_session",
          entityId: row.id,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
        });
      });
      removed += 1;
    }
    return removed;
  }

  /** Worker entry. A wrong shop cannot see the intake and leaves it unchanged. */
  async runJob(job: IntakeJob): Promise<void> {
    const actor: IntakeActor = { tenantId: job.tenantId, userId: job.userId, role: job.role };
    let claimed: ClaimedIntake | null;
    try {
      claimed = await this.claimProcessing(actor, job.intakeId);
    } catch (error) {
      if (!(error instanceof AppException) || error.code !== ErrorCode.AI_INTAKE_NOT_FOUND) {
        this.logEvent("warn", "ai_intake_processing_failed", {
          intakeId: job.intakeId,
          errorCode: "AI_PROVIDER_UNKNOWN",
          attempt: 0,
        });
      }
      return;
    }
    if (!claimed) {
      return;
    }
    const settings = intakeSettings();
    const started = Date.now();
    this.logEvent("info", "ai_intake_processing_started", {
      intakeId: job.intakeId,
      provider: this.provider.name,
      model: this.provider.model,
      mediaType: claimed.upload.contentType,
      fileSize: claimed.upload.size,
      attempt: claimed.attempts,
    });
    try {
      await this.assertMedia(actor, job.intakeId, claimed.upload);
      const download = await this.storage.createDownloadUrl({
        objectKey: claimed.upload.objectKey,
        expiresInSeconds: settings.downloadUrlTtlSeconds,
      });
      const analysis = await withTimeout(
        this.provider.analyze({
          mediaType: claimed.upload.contentType,
          mimeType: claimed.upload.contentType,
          objectKey: claimed.upload.objectKey,
          fileName: claimed.upload.fileName,
          downloadUrl: download.url,
        }),
        settings.providerTimeoutMs,
      );
      const items = validateProviderPayload({ items: analysis.items });
      const saved = await this.finishJob(actor, job.intakeId, claimed.generation, items, settings.confidenceThreshold);
      if (!saved) {
        return;
      }
      this.logEvent(
        "info",
        "ai_intake_processing_completed",
        {
          intakeId: job.intakeId,
          provider: this.provider.name,
          model: this.provider.model,
          mediaType: claimed.upload.contentType,
          fileSize: claimed.upload.size,
          attempt: claimed.attempts,
          itemCount: items.length,
          inputTokens: analysis.usage?.inputTokens ?? null,
          outputTokens: analysis.usage?.outputTokens ?? null,
        },
        Date.now() - started,
      );
    } catch (error) {
      const failure = classifyFailure(error);
      this.logEvent(
        "warn",
        "ai_intake_processing_failed",
        { intakeId: job.intakeId, errorCode: failure.code, attempt: claimed.attempts },
        Date.now() - started,
      );
      if (failure.retryable && claimed.attempts <= settings.maxRetries) {
        const requeued = await this.requeueJob(actor, job.intakeId, claimed.generation, failure.code);
        if (requeued) {
          this.queue.enqueue(job, retryDelayMs(claimed.attempts));
          return;
        }
      }
      await this.failJob(actor, job.intakeId, claimed.generation, failure);
    }
  }

  async updateItem(
    actor: IntakeActor,
    intakeId: string,
    itemId: string,
    input: UpdateIntakeItemDto,
  ): Promise<IntakeItemView> {
    assertUuid(intakeId);
    assertUuid(itemId);
    return this.transactions.run(actor, async (tx) => {
      const session = await this.lockSession(tx, actor.tenantId, intakeId);
      this.requireReview(session.status);
      const row = await this.requireItem(tx, actor.tenantId, intakeId, itemId);
      if (row.status !== AiItemStatus.PENDING) {
        throw new AppException(ErrorCode.CONFLICT, "This suggestion can no longer be edited.", HttpStatus.CONFLICT);
      }
      const suggestion = readSuggestion(row.rawSuggestion);
      const edited: EditedFields = { ...(suggestion.edited ?? {}) };
      const data: Prisma.AiIntakeItemUncheckedUpdateInput = {};
      if (input.name !== undefined) {
        data.editedName = requireDraftName(input.name);
      }
      if (input.quantity !== undefined) {
        data.editedQuantity = parseStock(input.quantity);
      }
      if (input.purchasePrice !== undefined) {
        data.editedPurchasePrice = parseMoney(input.purchasePrice);
      }
      if (input.sellingPrice !== undefined) {
        data.editedSellingPrice = parseMoney(input.sellingPrice);
      }
      if (input.barcode !== undefined) {
        edited.barcode = optionalCode(input.barcode, normalizeBarcode, 64, "Barcode is too long.");
      }
      if (input.sku !== undefined) {
        edited.sku = optionalCode(input.sku, normalizeSku, 64, "SKU is too long.");
      }
      if (input.unit !== undefined) {
        edited.unit = optionalLabel(input.unit, 80, "Unit name is too long.");
      }
      if (input.brand !== undefined) {
        edited.brand = optionalLabel(input.brand, 120, "Brand name is too long.");
      }
      if (input.category !== undefined) {
        edited.category = optionalLabel(input.category, 120, "Category name is too long.");
      }

      const name = (typeof data.editedName === "string" ? data.editedName : null) ?? row.editedName ?? row.detectedName ?? "";
      const barcode = textChoice(edited, "barcode", row.suggestedBarcode);
      const sku = textChoice(edited, "sku", suggestion.suggestedSku);
      let match: ProductMatch;
      if (input.matchedProductId) {
        const chosen = await tx.product.findFirst({
          where: { id: input.matchedProductId, tenantId: actor.tenantId, isActive: true },
          select: { id: true },
        });
        if (!chosen) {
          throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, "Product was not found.", HttpStatus.NOT_FOUND);
        }
        match = {
          matchType: "SHOPKEEPER_MATCH",
          matchedProductId: chosen.id,
          possibleProductId: null,
          needsReview: false,
        };
      } else {
        match = await matchCandidate(
          tx,
          actor.tenantId,
          { name, barcode, sku, confidence: confidenceNumber(row.confidence) },
          intakeSettings().confidenceThreshold,
        );
      }
      data.matchedProductId = match.matchedProductId;
      data.rawSuggestion = suggestionJson(suggestion, edited, match);
      await tx.aiIntakeItem.update({ where: { id: itemId }, data });
      await this.audit.write(tx, {
        action: "ai_intake.item_updated",
        entityType: "ai_intake_item",
        entityId: itemId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: { sessionId: intakeId },
      });
      const view = await this.loadView(tx, actor.tenantId, intakeId);
      const item = view.items.find((candidate) => candidate.id === itemId);
      if (!item) {
        throw new AppException(ErrorCode.AI_INTAKE_ITEM_NOT_FOUND, "Suggestion was not found.", HttpStatus.NOT_FOUND);
      }
      return item;
    });
  }

  async reject(actor: IntakeActor, intakeId: string, itemId: string): Promise<IntakeItemView> {
    assertUuid(intakeId);
    assertUuid(itemId);
    return this.transactions.run(actor, async (tx) => {
      const session = await this.lockSession(tx, actor.tenantId, intakeId);
      this.requireReview(session.status);
      const row = await this.requireItem(tx, actor.tenantId, intakeId, itemId);
      if (row.status === AiItemStatus.REJECTED) {
        throw new AppException(ErrorCode.CONFLICT, "This suggestion is already rejected.", HttpStatus.CONFLICT);
      }
      if (row.status !== AiItemStatus.PENDING) {
        throw new AppException(ErrorCode.CONFLICT, "This suggestion can no longer be rejected.", HttpStatus.CONFLICT);
      }
      await tx.aiIntakeItem.update({
        where: { id: itemId },
        data: { status: AiItemStatus.REJECTED },
      });
      await this.audit.write(tx, {
        action: "ai_intake.item_rejected",
        entityType: "ai_intake_item",
        entityId: itemId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: { sessionId: intakeId },
      });
      const view = await this.loadView(tx, actor.tenantId, intakeId);
      const item = view.items.find((candidate) => candidate.id === itemId);
      if (!item) {
        throw new AppException(ErrorCode.AI_INTAKE_ITEM_NOT_FOUND, "Suggestion was not found.", HttpStatus.NOT_FOUND);
      }
      return item;
    });
  }

  async confirm(actor: IntakeActor, intakeId: string, input: ConfirmIntakeDto, idempotencyKey?: string): Promise<ConfirmResult> {
    assertUuid(intakeId);
    const key = normalizeKey(idempotencyKey);
    const hash = digest([
      "AI_INTAKE_CONFIRM",
      intakeId,
      input.mode,
      [...(input.itemIds ?? [])].sort().join(","),
      input.supplierId ?? "",
    ]);
    const result = await this.transactions.run(actor, async (tx) => {
      const session = await this.lockSession(tx, actor.tenantId, intakeId);
      if (key) {
        const replay = await this.claim(tx, actor.tenantId, key, hash);
        if (replay) {
          return replay;
        }
      }
      if (session.status === AiIntakeStatus.CONFIRMED) {
        throw new AppException(ErrorCode.CONFLICT, "This intake is already confirmed.", HttpStatus.CONFLICT);
      }
      if (session.status !== AiIntakeStatus.DRAFT_READY) {
        throw new AppException(
          ErrorCode.CONFLICT,
          "Process the image before confirming.",
          HttpStatus.CONFLICT,
        );
      }
      const rows = await this.itemRows(tx, actor.tenantId, intakeId);
      const selected = selectRows(rows, input.itemIds);
      const lines = selected.map((row) => this.draftLine(row));
      const confirmed: ConfirmResult["items"] = [];
      const stock: Array<{ productId: string; quantity: Prisma.Decimal; unitCost: Prisma.Decimal }> = [];

      for (const line of lines) {
        const product = await this.confirmLine(tx, actor, line);
        confirmed.push(product);
        if (input.mode === "CREATE_PRODUCT_AND_STOCK" && line.quantity && line.quantity.gt(0)) {
          if (!line.purchasePrice) {
            throw new AppException(
              ErrorCode.VALIDATION_ERROR,
              "Enter a purchase price before adding stock.",
              HttpStatus.BAD_REQUEST,
            );
          }
          stock.push({
            productId: product.productId,
            quantity: line.quantity,
            unitCost: line.purchasePrice,
          });
        }
      }

      let purchaseId: string | null = null;
      let purchaseNumber: string | null = null;
      if (stock.length > 0 && input.supplierId) {
        const posted = await this.purchases.createWithin(tx, actor, {
          supplierId: input.supplierId,
          items: stock.map((line) => ({
            productId: line.productId,
            quantity: formatStock(line.quantity) ?? "0.000",
            unitCost: formatMoney(line.unitCost) ?? "0.00",
          })),
        });
        purchaseId = posted.id;
        purchaseNumber = posted.billNumber;
      } else if (stock.length > 0) {
        for (const line of stock) {
          await this.inventory.openingWithin(tx, actor, {
            productId: line.productId,
            quantity: line.quantity,
            unitCost: line.unitCost,
          });
        }
      }

      await tx.aiIntakeItem.updateMany({
        where: { tenantId: actor.tenantId, id: { in: selected.map((row) => row.id) } },
        data: { status: AiItemStatus.ACCEPTED },
      });
      const pending = await tx.aiIntakeItem.count({
        where: { tenantId: actor.tenantId, sessionId: intakeId, status: AiItemStatus.PENDING },
      });
      const status = pending === 0 ? AiIntakeStatus.CONFIRMED : AiIntakeStatus.DRAFT_READY;
      await tx.aiIntakeSession.update({
        where: { id: intakeId },
        data: {
          status,
          completedAt: status === AiIntakeStatus.CONFIRMED ? new Date() : session.completedAt,
          confirmedPurchaseId: purchaseId ?? session.confirmedPurchaseId,
        },
      });
      await this.audit.write(tx, {
        action: "ai_intake.confirmed",
        entityType: "ai_intake_session",
        entityId: intakeId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: {
          mode: input.mode,
          itemCount: confirmed.length,
          purchaseId,
        },
      });
      const body: ConfirmResult = {
        intakeId,
        status,
        mode: input.mode,
        items: confirmed,
        purchaseId,
        purchaseNumber,
      };
      if (key) {
        await tx.idempotencyKey.update({
          where: { tenantId_key: { tenantId: actor.tenantId, key } },
          data: { responseStatus: 200, responseBody: body as unknown as Prisma.InputJsonObject },
        });
      }
      return body;
    });
    this.logger.write({
      level: "info",
      message: "ai_intake_confirmed",
      module: "ai-intake",
      operation: intakeId,
    });
    return result;
  }

  private async confirmLine(
    tx: ShopDb,
    actor: IntakeActor,
    line: DraftLine,
  ): Promise<{ itemId: string; productId: string; created: boolean }> {
    if (line.matchedProductId) {
      const existing = await tx.product.findFirst({
        where: { id: line.matchedProductId, tenantId: actor.tenantId },
        select: { id: true, isActive: true },
      });
      if (!existing) {
        throw new AppException(ErrorCode.PRODUCT_NOT_FOUND, "Product was not found.", HttpStatus.NOT_FOUND);
      }
      if (!existing.isActive) {
        throw new AppException(ErrorCode.PRODUCT_INACTIVE, "Inactive products cannot be confirmed.", HttpStatus.CONFLICT);
      }
      return { itemId: line.row.id, productId: existing.id, created: false };
    }

    if (line.barcode) {
      const taken = await tx.productBarcode.findFirst({
        where: { tenantId: actor.tenantId, barcode: line.barcode },
        select: { id: true },
      });
      if (taken) {
        throw new AppException(
          ErrorCode.BARCODE_ALREADY_EXISTS,
          "This barcode is already used in the shop.",
          HttpStatus.CONFLICT,
        );
      }
    }
    if (line.sku) {
      const taken = await tx.product.findFirst({
        where: { tenantId: actor.tenantId, sku: line.sku },
        select: { id: true },
      });
      if (taken) {
        throw new AppException(
          ErrorCode.SKU_ALREADY_EXISTS,
          "This SKU is already used in the shop.",
          HttpStatus.CONFLICT,
        );
      }
    }

    const unitId = await this.resolveUnit(tx, actor.tenantId, line.unit);
    const created = (await this.products.createWithin(tx, actor, {
      name: line.name,
      unitId,
      sku: line.sku,
      barcode: line.barcode ?? undefined,
      categoryId: await this.resolveNamed(tx, actor.tenantId, "category", line.category),
      brandId: await this.resolveNamed(tx, actor.tenantId, "brand", line.brand),
      defaultPurchasePrice: line.purchasePrice ? formatMoney(line.purchasePrice) ?? undefined : undefined,
      defaultSellingPrice: line.sellingPrice ? formatMoney(line.sellingPrice) ?? undefined : undefined,
    })) as { id: string };
    return { itemId: line.row.id, productId: created.id, created: true };
  }

  private draftLine(row: ItemRow): DraftLine {
    const suggestion = readSuggestion(row.rawSuggestion);
    const edited = suggestion.edited;
    const name = requireDraftName(row.editedName ?? row.detectedName ?? "");
    return {
      row,
      name,
      barcode: textChoice(edited, "barcode", row.suggestedBarcode),
      sku: textChoice(edited, "sku", suggestion.suggestedSku),
      unit: textChoice(edited, "unit", suggestion.suggestedUnit),
      brand: textChoice(edited, "brand", row.suggestedBrandName),
      category: textChoice(edited, "category", row.suggestedCategoryName),
      quantity: row.editedQuantity ?? row.suggestedQuantity,
      purchasePrice: row.editedPurchasePrice ?? row.suggestedPurchasePrice,
      sellingPrice: row.editedSellingPrice ?? row.suggestedSellingPrice,
      matchedProductId: row.matchedProductId,
    };
  }

  private async resolveUnit(tx: ShopDb, tenantId: string, unit: string | null): Promise<string> {
    if (!unit) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, "Choose a unit.", HttpStatus.BAD_REQUEST);
    }
    const found = await tx.unit.findFirst({
      where: {
        tenantId,
        isActive: true,
        OR: [
          { name: { equals: unit, mode: "insensitive" } },
          { shortCode: { equals: unit, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });
    if (!found) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        "Choose a unit that exists in this shop.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return found.id;
  }

  private async resolveNamed(
    tx: ShopDb,
    tenantId: string,
    kind: "brand" | "category",
    name: string | null,
  ): Promise<string | null> {
    if (!name) {
      return null;
    }
    if (kind === "brand") {
      const brand = await tx.brand.findFirst({
        where: { tenantId, isActive: true, name: { equals: name, mode: "insensitive" } },
        select: { id: true },
      });
      return brand?.id ?? null;
    }
    const category = await tx.category.findFirst({
      where: { tenantId, isActive: true, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    return category?.id ?? null;
  }

  private async queueIntake(
    actor: IntakeActor,
    intakeId: string,
    ip: string | undefined,
    retryOnly: boolean,
  ): Promise<IntakeSessionView> {
    assertUuid(intakeId);
    const settings = intakeSettings();
    this.limiter.assertAllowed({ tenantId: actor.tenantId, userId: actor.userId, ip }, settings.maxPerMinute);
    await this.cleanupExpiredMedia(actor, intakeId);
    const prepared = await this.transactions.run(actor, async (tx) => {
      const session = await this.lockSession(tx, actor.tenantId, intakeId);
      await this.markStale(tx, actor, session);
      const current = await this.lockSession(tx, actor.tenantId, intakeId);
      this.assertQueueable(current.status, readJob(current.rawOutput), retryOnly, settings.maxRetries);
      const upload = readUpload(current.rawOutput);
      if (!upload || current.mediaReference === PENDING_MEDIA) {
        throw new AppException(ErrorCode.CONFLICT, "Upload an image before processing.", HttpStatus.CONFLICT);
      }
      if (upload.deletedAt) {
        throw new AppException(
          ErrorCode.AI_INTAKE_MEDIA_NOT_FOUND,
          "The image is no longer available.",
          HttpStatus.NOT_FOUND,
        );
      }
      return { upload, wasFailed: current.status === AiIntakeStatus.FAILED, verified: upload.verified };
    });
    await this.assertMedia(actor, intakeId, prepared.upload);
    const view = await this.transactions.run(actor, async (tx) => {
      const session = await this.lockSession(tx, actor.tenantId, intakeId);
      const job = readJob(session.rawOutput);
      if (
        session.status === AiIntakeStatus.PROCESSING ||
        (session.status === AiIntakeStatus.UPLOADED && job.state === "QUEUED")
      ) {
        throw new AppException(ErrorCode.CONFLICT, "This intake is already being processed.", HttpStatus.CONFLICT);
      }
      this.assertQueueable(session.status, job, retryOnly, settings.maxRetries);
      const upload = readUpload(session.rawOutput);
      if (!upload || upload.objectKey !== prepared.upload.objectKey || upload.deletedAt) {
        throw new AppException(ErrorCode.AI_INTAKE_UPLOAD_NOT_VERIFIED, "Upload the image before processing.", HttpStatus.CONFLICT);
      }
      await this.assertDailyCap(tx, actor, settings.maxDailyProcesses);
      const next: IntakeJobState = {
        state: "QUEUED",
        generation: job.generation + 1,
        attempts: job.attempts,
        queuedAt: new Date().toISOString(),
        processingStartedAt: null,
        errorCode: null,
        retryable: false,
      };
      const verified: UploadMeta = { ...upload, verified: true };
      await tx.aiIntakeItem.deleteMany({ where: { tenantId: actor.tenantId, sessionId: intakeId } });
      await tx.aiIntakeSession.update({
        where: { id: intakeId },
        data: {
          status: AiIntakeStatus.UPLOADED,
          mediaReference: verified.objectKey,
          failureReason: null,
          completedAt: null,
          rawOutput: sessionDocument(verified, next),
        },
      });
      if (!prepared.verified) {
        await this.audit.write(tx, {
          action: "ai_intake.media_uploaded",
          entityType: "ai_intake_session",
          entityId: intakeId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
        });
      }
      if (prepared.wasFailed) {
        await this.audit.write(tx, {
          action: "ai_intake.processing_retried",
          entityType: "ai_intake_session",
          entityId: intakeId,
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          metadata: { attempt: job.attempts },
        });
      }
      return this.loadView(tx, actor.tenantId, intakeId);
    });
    this.queue.enqueue({ tenantId: actor.tenantId, userId: actor.userId, role: actor.role, intakeId });
    return view;
  }

  private assertQueueable(status: AiIntakeStatus, job: IntakeJobState, retryOnly: boolean, maxRetries: number): void {
    if (status === AiIntakeStatus.PROCESSING || (status === AiIntakeStatus.UPLOADED && job.state === "QUEUED")) {
      throw new AppException(ErrorCode.CONFLICT, "This intake is already being processed.", HttpStatus.CONFLICT);
    }
    if (retryOnly && status !== AiIntakeStatus.FAILED) {
      throw new AppException(ErrorCode.AI_INTAKE_NOT_RETRYABLE, "This intake cannot be retried.", HttpStatus.CONFLICT);
    }
    if (!retryOnly && status !== AiIntakeStatus.UPLOADED && status !== AiIntakeStatus.FAILED) {
      throw new AppException(ErrorCode.CONFLICT, "This intake has already been processed.", HttpStatus.CONFLICT);
    }
    if (status === AiIntakeStatus.FAILED) {
      if (!job.retryable) {
        throw new AppException(ErrorCode.AI_INTAKE_NOT_RETRYABLE, "This intake cannot be retried.", HttpStatus.CONFLICT);
      }
      if (job.attempts > maxRetries) {
        throw new AppException(
          ErrorCode.AI_INTAKE_RETRY_LIMIT,
          "This intake has been retried too many times.",
          HttpStatus.CONFLICT,
        );
      }
    }
  }

  private async claimProcessing(actor: IntakeActor, intakeId: string): Promise<ClaimedIntake | null> {
    return this.transactions.run(actor, async (tx) => {
      const session = await this.lockSession(tx, actor.tenantId, intakeId);
      const job = readJob(session.rawOutput);
      const upload = readUpload(session.rawOutput);
      if (session.status !== AiIntakeStatus.UPLOADED || job.state !== "QUEUED" || !upload || upload.deletedAt) {
        return null;
      }
      const next: IntakeJobState = {
        state: "PROCESSING",
        generation: job.generation,
        attempts: job.attempts + 1,
        queuedAt: job.queuedAt,
        processingStartedAt: new Date().toISOString(),
        errorCode: null,
        retryable: false,
      };
      await tx.aiIntakeSession.update({
        where: { id: intakeId },
        data: {
          status: AiIntakeStatus.PROCESSING,
          failureReason: null,
          completedAt: null,
          rawOutput: sessionDocument(upload, next),
        },
      });
      return { generation: job.generation, attempts: next.attempts, upload };
    });
  }

  private async finishJob(
    actor: IntakeActor,
    intakeId: string,
    generation: number,
    items: AiDetectedItem[],
    threshold: number,
  ): Promise<boolean> {
    return this.transactions.run(actor, async (tx) => {
      const session = await this.lockSession(tx, actor.tenantId, intakeId);
      const job = readJob(session.rawOutput);
      if (session.status !== AiIntakeStatus.PROCESSING || job.generation !== generation) {
        return false;
      }
      await tx.aiIntakeItem.deleteMany({ where: { tenantId: actor.tenantId, sessionId: intakeId } });
      await this.insertDrafts(tx, actor, intakeId, items, threshold);
      const upload = readUpload(session.rawOutput);
      await tx.aiIntakeSession.update({
        where: { id: intakeId },
        data: {
          status: AiIntakeStatus.DRAFT_READY,
          failureReason: null,
          completedAt: new Date(),
          rawOutput: sessionDocument(upload, { ...job, state: "IDLE", errorCode: null, retryable: false }, { itemCount: items.length }),
        },
      });
      await this.audit.write(tx, {
        action: "ai_intake.processed",
        entityType: "ai_intake_session",
        entityId: intakeId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: { status: "DRAFT_READY", itemCount: items.length },
      });
      return true;
    });
  }

  private async requeueJob(
    actor: IntakeActor,
    intakeId: string,
    generation: number,
    errorCode: string,
  ): Promise<boolean> {
    return this.transactions.run(actor, async (tx) => {
      const session = await this.lockSession(tx, actor.tenantId, intakeId);
      const job = readJob(session.rawOutput);
      if (session.status !== AiIntakeStatus.PROCESSING || job.generation !== generation) {
        return false;
      }
      const upload = readUpload(session.rawOutput);
      await tx.aiIntakeSession.update({
        where: { id: intakeId },
        data: {
          status: AiIntakeStatus.UPLOADED,
          failureReason: null,
          completedAt: null,
          rawOutput: sessionDocument(upload, {
            ...job,
            state: "QUEUED",
            queuedAt: new Date().toISOString(),
            processingStartedAt: null,
            errorCode,
            retryable: true,
          }),
        },
      });
      await this.audit.write(tx, {
        action: "ai_intake.processing_retried",
        entityType: "ai_intake_session",
        entityId: intakeId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: { attempt: job.attempts, errorCode },
      });
      return true;
    });
  }

  private async failJob(
    actor: IntakeActor,
    intakeId: string,
    generation: number,
    failure: { code: string; retryable: boolean },
  ): Promise<void> {
    await this.transactions.run(actor, async (tx) => {
      const session = await this.lockSession(tx, actor.tenantId, intakeId);
      const job = readJob(session.rawOutput);
      if (session.status !== AiIntakeStatus.PROCESSING || job.generation !== generation) {
        return;
      }
      await tx.aiIntakeItem.deleteMany({ where: { tenantId: actor.tenantId, sessionId: intakeId } });
      const upload = readUpload(session.rawOutput);
      await tx.aiIntakeSession.update({
        where: { id: intakeId },
        data: {
          status: AiIntakeStatus.FAILED,
          failureReason: AI_CLIENT_FAILURE,
          completedAt: new Date(),
          rawOutput: sessionDocument(upload, { ...job, state: "IDLE", errorCode: failure.code, retryable: failure.retryable }),
        },
      });
      await this.audit.write(tx, {
        action: "ai_intake.processing_failed",
        entityType: "ai_intake_session",
        entityId: intakeId,
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        metadata: { errorCode: failure.code },
      });
    });
  }

  private async markStale(
    tx: ShopDb,
    actor: IntakeActor,
    session: { id: string; status: AiIntakeStatus; rawOutput: Prisma.JsonValue | null },
  ): Promise<void> {
    const job = readJob(session.rawOutput);
    const settings = intakeSettings();
    const processing = session.status === AiIntakeStatus.PROCESSING && isStale(job, settings.processingTimeoutMinutes);
    const queued =
      session.status === AiIntakeStatus.UPLOADED && job.state === "QUEUED" && isStale(job, settings.processingTimeoutMinutes);
    if (!processing && !queued) {
      return;
    }
    const upload = readUpload(session.rawOutput);
    await tx.aiIntakeSession.update({
      where: { id: session.id },
      data: {
        status: AiIntakeStatus.FAILED,
        failureReason: AI_CLIENT_FAILURE,
        completedAt: new Date(),
        rawOutput: sessionDocument(upload, {
          ...job,
          state: "IDLE",
          errorCode: "AI_PROVIDER_TIMEOUT",
          retryable: job.attempts <= settings.maxRetries,
        }),
      },
    });
    await this.audit.write(tx, {
      action: "ai_intake.processing_failed",
      entityType: "ai_intake_session",
      entityId: session.id,
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      metadata: { stale: true },
    });
  }

  private async assertMedia(actor: IntakeActor, intakeId: string, upload: UploadMeta): Promise<void> {
    const settings = intakeSettings();
    const head = await this.storage.headObject(upload.objectKey);
    const header = head ? await this.storage.readHeader(upload.objectKey, 32) : null;
    assertStoredObject({
      tenantId: actor.tenantId,
      intakeId,
      objectKey: upload.objectKey,
      declaredType: upload.contentType,
      declaredSize: upload.size,
      head,
      header,
      maxBytes: settings.maxBytes,
    });
  }

  private async assertDailyCap(tx: ShopDb, actor: IntakeActor, max: number): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const where = {
      action: { in: [...COUNTABLE_ACTIONS] },
      occurredAt: { gte: since },
    };
    const [shop, user] = await Promise.all([
      tx.auditLog.count({ where: { tenantId: actor.tenantId, ...where } }),
      tx.auditLog.count({ where: { tenantId: actor.tenantId, actorUserId: actor.userId, ...where } }),
    ]);
    if (shop >= max || user >= max) {
      throw new AppException(
        ErrorCode.AI_INTAKE_RATE_LIMITED,
        "Too many intake requests. Try again shortly.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private logEvent(
    level: "info" | "warn",
    event: string,
    fields: Record<string, string | number | null>,
    durationMs?: number,
  ): void {
    this.logger.write({
      level,
      message: JSON.stringify({ event, ...fields }),
      module: "ai-intake",
      operation: typeof fields.intakeId === "string" ? fields.intakeId : event,
      durationMs,
    });
  }

  private async insertDrafts(
    tx: ShopDb,
    actor: IntakeActor,
    sessionId: string,
    items: AiDetectedItem[],
    threshold: number,
  ): Promise<void> {
    if (items.length > 50) {
      throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
    }
    let position = 0;
    for (const item of items) {
      const name = normalizeName(item.name ?? "");
      if (name.length > 200) {
        throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
      }
      const confidence = confidenceDecimal(item.confidence);
      const barcode = item.barcode ? normalizeBarcode(item.barcode) : null;
      if (barcode && barcode.length > 64) {
        throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
      }
      const sku = item.sku ? normalizeSku(item.sku) : null;
      if (sku && sku.length > 64) {
        throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
      }
      const match =
        name.length > 0
          ? await matchCandidate(tx, actor.tenantId, { name, barcode, sku, confidence: item.confidence }, threshold)
          : {
              matchType: "NEW_PRODUCT" as const,
              matchedProductId: null,
              possibleProductId: null,
              needsReview: true,
            };
      await tx.aiIntakeItem.create({
        data: {
          tenantId: actor.tenantId,
          sessionId,
          position,
          detectedName: name.length > 0 ? name : null,
          detectedNameEn: bounded(item.nameEn ?? undefined, 200),
          detectedNameHi: bounded(item.nameHi ?? undefined, 200),
          detectedNameMr: bounded(item.nameMr ?? undefined, 200),
          suggestedBrandName: bounded(item.brand ?? undefined, 120),
          suggestedCategoryName: bounded(item.category ?? undefined, 120),
          suggestedBarcode: barcode,
          suggestedQuantity: optionalProviderStock(item.quantity ?? undefined),
          suggestedPurchasePrice: optionalProviderMoney(item.purchasePrice ?? undefined),
          suggestedSellingPrice: optionalProviderMoney(item.sellingPrice ?? undefined),
          confidence,
          status: AiItemStatus.PENDING,
          matchedProductId: match.matchedProductId,
          rawSuggestion: {
            matchType: match.matchType,
            needsReview: match.needsReview,
            possibleProductId: match.possibleProductId,
            suggestedSku: sku,
            suggestedUnit: item.unit ? normalizeName(item.unit).slice(0, 80) : null,
            ...(item.evidence ? { evidence: evidenceJson(item.evidence) } : {}),
          } satisfies Prisma.InputJsonObject,
        },
      });
      position += 1;
    }
  }

  private async loadView(tx: ShopDb, tenantId: string, intakeId: string): Promise<IntakeSessionView> {
    const session = await tx.aiIntakeSession.findFirst({
      where: { id: intakeId, tenantId },
      select: {
        id: true,
        status: true,
        sourceType: true,
        failureReason: true,
        createdAt: true,
        completedAt: true,
        mediaReference: true,
        rawOutput: true,
      },
    });
    if (!session) {
      throw new AppException(ErrorCode.AI_INTAKE_NOT_FOUND, "Intake was not found.", HttpStatus.NOT_FOUND);
    }
    const rows = await this.itemRows(tx, tenantId, intakeId);
    const names = await this.productNames(tx, tenantId, rows);
    const upload = readUpload(session.rawOutput);
    const job = readJob(session.rawOutput);
    const settings = intakeSettings();
    return {
      id: session.id,
      status: displayStatus(session.status, job),
      sourceType: session.sourceType,
      failureReason: session.failureReason,
      createdAt: session.createdAt.toISOString(),
      completedAt: session.completedAt ? session.completedAt.toISOString() : null,
      processingAttempts: job.attempts,
      canRetry:
        session.status === AiIntakeStatus.FAILED &&
        job.retryable &&
        job.attempts <= settings.maxRetries &&
        !upload?.deletedAt,
      media: session.mediaReference === PENDING_MEDIA ? null : upload,
      items: rows.map((row) => presentItem(row, names)),
    };
  }

  private async productNames(tx: ShopDb, tenantId: string, rows: ItemRow[]): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.matchedProductId) {
        ids.add(row.matchedProductId);
      }
      const possible = readSuggestion(row.rawSuggestion).possibleProductId;
      if (possible) {
        ids.add(possible);
      }
    }
    if (ids.size === 0) {
      return new Map();
    }
    const products = await tx.product.findMany({
      where: { tenantId, id: { in: [...ids] } },
      select: { id: true, name: true },
    });
    return new Map(products.map((product) => [product.id, product.name]));
  }

  private async itemRows(tx: ShopDb, tenantId: string, sessionId: string): Promise<ItemRow[]> {
    return tx.aiIntakeItem.findMany({
      where: { tenantId, sessionId },
      orderBy: { position: "asc" },
      select: {
        id: true,
        position: true,
        detectedName: true,
        suggestedCategoryName: true,
        suggestedBrandName: true,
        suggestedBarcode: true,
        suggestedQuantity: true,
        suggestedPurchasePrice: true,
        suggestedSellingPrice: true,
        confidence: true,
        editedName: true,
        editedQuantity: true,
        editedPurchasePrice: true,
        editedSellingPrice: true,
        status: true,
        matchedProductId: true,
        rawSuggestion: true,
      },
    });
  }

  private async requireItem(tx: ShopDb, tenantId: string, sessionId: string, itemId: string): Promise<ItemRow> {
    const row = await tx.aiIntakeItem.findFirst({
      where: { id: itemId, tenantId, sessionId },
      select: {
        id: true,
        position: true,
        detectedName: true,
        suggestedCategoryName: true,
        suggestedBrandName: true,
        suggestedBarcode: true,
        suggestedQuantity: true,
        suggestedPurchasePrice: true,
        suggestedSellingPrice: true,
        confidence: true,
        editedName: true,
        editedQuantity: true,
        editedPurchasePrice: true,
        editedSellingPrice: true,
        status: true,
        matchedProductId: true,
        rawSuggestion: true,
      },
    });
    if (!row) {
      throw new AppException(ErrorCode.AI_INTAKE_ITEM_NOT_FOUND, "Suggestion was not found.", HttpStatus.NOT_FOUND);
    }
    return row;
  }

  private async lockSession(tx: ShopDb, tenantId: string, intakeId: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM ai_intake_sessions
      WHERE id = ${intakeId}::uuid AND tenant_id = ${tenantId}::uuid
      FOR UPDATE
    `;
    if (!locked[0]) {
      throw new AppException(ErrorCode.AI_INTAKE_NOT_FOUND, "Intake was not found.", HttpStatus.NOT_FOUND);
    }
    const session = await tx.aiIntakeSession.findFirst({
      where: { id: intakeId, tenantId },
    });
    if (!session) {
      throw new AppException(ErrorCode.AI_INTAKE_NOT_FOUND, "Intake was not found.", HttpStatus.NOT_FOUND);
    }
    return session;
  }

  private requireReview(status: AiIntakeStatus): void {
    if (status !== AiIntakeStatus.DRAFT_READY) {
      throw new AppException(ErrorCode.CONFLICT, "Review is closed for this intake.", HttpStatus.CONFLICT);
    }
  }

  private async claim(tx: ShopDb, tenantId: string, key: string, requestHash: string): Promise<ConfirmResult | null> {
    const existing = await tx.idempotencyKey.findUnique({
      where: { tenantId_key: { tenantId, key } },
    });
    if (!existing) {
      await tx.idempotencyKey.create({ data: { tenantId, key, requestHash } });
      return null;
    }
    if (existing.requestHash !== requestHash) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        "This idempotency key was already used for a different request.",
        HttpStatus.CONFLICT,
      );
    }
    const stored = existing.responseBody;
    if (!stored || typeof stored !== "object" || Array.isArray(stored) || !("intakeId" in stored)) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        "This idempotency key was already used for a different request.",
        HttpStatus.CONFLICT,
      );
    }
    return stored as unknown as ConfirmResult;
  }
}

function selectRows(rows: ItemRow[], itemIds: string[] | undefined): ItemRow[] {
  if (itemIds && itemIds.length === 0) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, "Select at least one suggestion.", HttpStatus.BAD_REQUEST);
  }
  const wanted = itemIds ? new Set(itemIds) : null;
  const selected = rows.filter((row) => (wanted ? wanted.has(row.id) : row.status === AiItemStatus.PENDING));
  if (wanted) {
    if (selected.length !== wanted.size) {
      throw new AppException(ErrorCode.AI_INTAKE_ITEM_NOT_FOUND, "Suggestion was not found.", HttpStatus.NOT_FOUND);
    }
    for (const row of selected) {
      if (row.status === AiItemStatus.REJECTED) {
        throw new AppException(
          ErrorCode.CONFLICT,
          "Rejected suggestions cannot be confirmed.",
          HttpStatus.CONFLICT,
        );
      }
      if (row.status === AiItemStatus.ACCEPTED) {
        throw new AppException(ErrorCode.CONFLICT, "This suggestion is already confirmed.", HttpStatus.CONFLICT);
      }
    }
  }
  if (selected.length === 0) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, "There is nothing to confirm.", HttpStatus.BAD_REQUEST);
  }
  return selected;
}

function presentItem(row: ItemRow, names: Map<string, string>): IntakeItemView {
  const suggestion = readSuggestion(row.rawSuggestion);
  const edited = suggestion.edited;
  const needsReview = suggestion.needsReview;
  const matchType = suggestion.matchType;
  const name = row.editedName ?? row.detectedName;
  const possibleId = suggestion.possibleProductId;
  return {
    id: row.id,
    position: row.position,
    status: row.status,
    name,
    brand: textChoice(edited, "brand", row.suggestedBrandName),
    category: textChoice(edited, "category", row.suggestedCategoryName),
    barcode: textChoice(edited, "barcode", row.suggestedBarcode),
    sku: textChoice(edited, "sku", suggestion.suggestedSku),
    unit: textChoice(edited, "unit", suggestion.suggestedUnit),
    quantity: formatStock(row.editedQuantity ?? row.suggestedQuantity),
    purchasePrice: formatMoney(row.editedPurchasePrice ?? row.suggestedPurchasePrice),
    sellingPrice: formatMoney(row.editedSellingPrice ?? row.suggestedSellingPrice),
    confidence: row.confidence ? row.confidence.toFixed(4) : null,
    matchType,
    reviewStatus: needsReview ? "NEEDS_REVIEW" : matchType,
    needsReview,
    matchedProduct: row.matchedProductId
      ? { id: row.matchedProductId, name: names.get(row.matchedProductId) ?? "" }
      : null,
    possibleProduct: possibleId ? { id: possibleId, name: names.get(possibleId) ?? "" } : null,
  };
}

function suggestionJson(previous: Suggestion, edited: EditedFields, match: ProductMatch): Prisma.InputJsonObject {
  const compact: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(edited)) {
    if (value !== undefined) {
      compact[key] = value;
    }
  }
  return {
    matchType: match.matchType,
    needsReview: match.needsReview,
    possibleProductId: match.possibleProductId,
    suggestedSku: previous.suggestedSku,
    suggestedUnit: previous.suggestedUnit,
    edited: compact,
  };
}

function readSuggestion(raw: Prisma.JsonValue): Suggestion {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      matchType: "NEW_PRODUCT",
      needsReview: true,
      possibleProductId: null,
      suggestedSku: null,
      suggestedUnit: null,
    };
  }
  const row = raw as Record<string, unknown>;
  const editedRaw = row.edited;
  return {
    matchType: typeof row.matchType === "string" ? row.matchType : "NEW_PRODUCT",
    needsReview: row.needsReview === true,
    possibleProductId: typeof row.possibleProductId === "string" ? row.possibleProductId : null,
    suggestedSku: typeof row.suggestedSku === "string" ? row.suggestedSku : null,
    suggestedUnit: typeof row.suggestedUnit === "string" ? row.suggestedUnit : null,
    edited:
      editedRaw && typeof editedRaw === "object" && !Array.isArray(editedRaw)
        ? (editedRaw as EditedFields)
        : undefined,
  };
}

function readUpload(raw: Prisma.JsonValue | null): UploadMeta | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const upload = (raw as { upload?: unknown }).upload;
  if (!upload || typeof upload !== "object" || Array.isArray(upload)) {
    return null;
  }
  const row = upload as Record<string, unknown>;
  if (typeof row.objectKey !== "string" || typeof row.contentType !== "string" || typeof row.fileName !== "string") {
    return null;
  }
  return {
    fileName: row.fileName,
    contentType: row.contentType,
    size: typeof row.size === "number" ? row.size : 0,
    objectKey: row.objectKey,
    verified: row.verified === true,
    deletedAt: typeof row.deletedAt === "string" ? row.deletedAt : null,
  };
}

function textChoice(
  edited: EditedFields | undefined,
  key: keyof EditedFields,
  fallback: string | null,
): string | null {
  if (edited && Object.prototype.hasOwnProperty.call(edited, key)) {
    return edited[key] ?? null;
  }
  return fallback;
}

function requireDraftName(value: string): string {
  const name = normalizeName(value);
  if (name.length === 0 || name.length > 200) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, "Enter a product name.", HttpStatus.BAD_REQUEST);
  }
  return name;
}

function optionalCode(
  value: string,
  normalize: (input: string) => string,
  max: number,
  tooLong: string,
): string | null {
  const normalized = normalize(value);
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > max) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, tooLong, HttpStatus.BAD_REQUEST);
  }
  return normalized;
}

function optionalLabel(value: string, max: number, tooLong: string): string | null {
  const label = normalizeName(value);
  if (label.length === 0) {
    return null;
  }
  if (label.length > max) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, tooLong, HttpStatus.BAD_REQUEST);
  }
  return label;
}

function optionalProviderStock(value: string | undefined): Prisma.Decimal | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  try {
    return parseStock(value);
  } catch {
    throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
  }
}

function optionalProviderMoney(value: string | undefined): Prisma.Decimal | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  try {
    return parseMoney(value);
  } catch {
    throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
  }
}

function confidenceDecimal(value: number): Prisma.Decimal {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_INVALID_RESPONSE", retryable: false });
  }
  return new Prisma.Decimal(value.toFixed(4));
}

function confidenceNumber(value: Prisma.Decimal | null): number {
  if (!value) {
    return 0;
  }
  return value.toNumber();
}

function bounded(value: string | undefined, max: number): string | null {
  if (!value) {
    return null;
  }
  const text = normalizeName(value);
  if (text.length === 0 || text.length > max) {
    return null;
  }
  return text;
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, "Intake id is invalid.", HttpStatus.BAD_REQUEST);
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AiAnalysisError(AI_CLIENT_FAILURE, { code: "AI_PROVIDER_TIMEOUT", retryable: true }));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function classifyFailure(error: unknown): { code: AiProviderFailureCode | string; retryable: boolean } {
  if (error instanceof AiAnalysisError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (error instanceof AppException) {
    return { code: error.code, retryable: false };
  }
  return { code: "AI_PROVIDER_UNKNOWN", retryable: true };
}

function sessionDocument(
  upload: UploadMeta | null,
  job: IntakeJobState,
  extra?: Record<string, Prisma.InputJsonValue>,
): Prisma.InputJsonObject {
  const document: Record<string, Prisma.InputJsonValue> = {
    job: {
      state: job.state,
      generation: job.generation,
      attempts: job.attempts,
      queuedAt: job.queuedAt,
      processingStartedAt: job.processingStartedAt,
      errorCode: job.errorCode,
      retryable: job.retryable,
    },
  };
  if (upload) {
    document.upload = {
      fileName: upload.fileName,
      contentType: upload.contentType,
      size: upload.size,
      objectKey: upload.objectKey,
      verified: upload.verified,
      deletedAt: upload.deletedAt,
    };
  }
  if (extra) {
    Object.assign(document, extra);
  }
  return document;
}

function evidenceJson(evidence: NonNullable<AiDetectedItem["evidence"]>): Prisma.InputJsonObject {
  const row: Record<string, boolean> = {};
  if (evidence.barcodeVisible !== undefined) {
    row.barcodeVisible = evidence.barcodeVisible;
  }
  if (evidence.labelVisible !== undefined) {
    row.labelVisible = evidence.labelVisible;
  }
  if (evidence.priceVisible !== undefined) {
    row.priceVisible = evidence.priceVisible;
  }
  if (evidence.quantityVisible !== undefined) {
    row.quantityVisible = evidence.quantityVisible;
  }
  return row;
}
