import { Injectable, OnModuleDestroy } from "@nestjs/common";

export interface IntakeJob {
  tenantId: string;
  userId: string;
  role: string;
  intakeId: string;
}

/**
 * In-process queue. The database claim is the lock, so two handlers for the
 * same intake cannot both call the provider. This queue is not shared across
 * API processes. A shop's next intake request re-queues a job that was left
 * behind after a restart.
 */
@Injectable()
export class AiIntakeQueue implements OnModuleDestroy {
  private handler: ((job: IntakeJob) => Promise<void>) | null = null;
  private readonly pending = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();

  register(handler: (job: IntakeJob) => Promise<void>): void {
    this.handler = handler;
  }

  enqueue(job: IntakeJob, delayMs = 0): void {
    if (this.pending.has(job.intakeId)) {
      return;
    }
    this.pending.add(job.intakeId);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.pending.delete(job.intakeId);
      void this.handler?.(job);
    }, delayMs);
    this.timers.add(timer);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.pending.clear();
  }
}
