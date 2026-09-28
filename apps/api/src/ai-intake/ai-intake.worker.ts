import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { AppLogger } from "../common/logging/app-logger.service";
import { AiIntakeService } from "./ai-intake.service";
import { AiIntakeQueue } from "./ai-intake.queue";

/**
 * Runs queued intake jobs in this process. Analysis stays outside the
 * database transaction. The worker never creates products or stock.
 * A crashed job is recovered when that shop next reads or retries the intake.
 * There is no cross-shop sweep, because row security hides other shops.
 */
@Injectable()
export class AiIntakeWorker implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly intake: AiIntakeService,
    private readonly queue: AiIntakeQueue,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    this.queue.register(async (job) => {
      try {
        await this.intake.runJob(job);
        this.queue.markSuccess();
      } catch (error) {
        this.queue.markFailure();
        const message = error instanceof Error ? error.message : "intake job failed";
        this.logger.write({
          level: "error",
          message,
          module: "ai-intake",
          operation: "worker",
        });
      }
    });
    this.logger.write({
      level: "info",
      message: "intake worker listening",
      module: "ai-intake",
      operation: "worker",
    });
  }

  onModuleDestroy(): void {
    this.queue.onModuleDestroy();
  }
}
