import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
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
  ) {}

  onModuleInit(): void {
    this.queue.register((job) => this.intake.runJob(job));
  }

  onModuleDestroy(): void {
    this.queue.onModuleDestroy();
  }
}
