import { Prisma } from "@prisma/client";

export interface IntakeJobState {
  state: "IDLE" | "QUEUED" | "PROCESSING";
  generation: number;
  attempts: number;
  queuedAt: string | null;
  processingStartedAt: string | null;
  errorCode: string | null;
  retryable: boolean;
}

export function idleJob(): IntakeJobState {
  return {
    state: "IDLE",
    generation: 0,
    attempts: 0,
    queuedAt: null,
    processingStartedAt: null,
    errorCode: null,
    retryable: false,
  };
}

export function readJob(raw: Prisma.JsonValue | null): IntakeJobState {
  const idle = idleJob();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return idle;
  }
  const job = (raw as { job?: unknown }).job;
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    return idle;
  }
  const row = job as Record<string, unknown>;
  const state = row.state === "QUEUED" || row.state === "PROCESSING" ? row.state : "IDLE";
  return {
    state,
    generation: integer(row.generation),
    attempts: integer(row.attempts),
    queuedAt: typeof row.queuedAt === "string" ? row.queuedAt : null,
    processingStartedAt: typeof row.processingStartedAt === "string" ? row.processingStartedAt : null,
    errorCode: typeof row.errorCode === "string" ? row.errorCode : null,
    retryable: row.retryable === true,
  };
}

export function isStale(job: IntakeJobState, timeoutMinutes: number, now = Date.now()): boolean {
  const stamp = job.state === "PROCESSING" ? job.processingStartedAt : job.state === "QUEUED" ? job.queuedAt : null;
  if (!stamp) {
    return false;
  }
  const started = Date.parse(stamp);
  if (!Number.isFinite(started)) {
    return false;
  }
  return started < now - timeoutMinutes * 60_000;
}

/** API status. `QUEUED` is derived. The database enum stays `UPLOADED` until processing starts. */
export function displayStatus(dbStatus: string, job: IntakeJobState): string {
  if (dbStatus === "UPLOADED" && job.state === "QUEUED") {
    return "QUEUED";
  }
  return dbStatus;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
