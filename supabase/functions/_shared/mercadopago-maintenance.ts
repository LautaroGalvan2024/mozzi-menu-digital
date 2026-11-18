export type ExpirationReport = {
  expired: number;
  blocked: number;
  blockedCountCapped: boolean;
  locked: number;
  failed: number;
  scanned: number;
  purgedTokens: number;
};

export type MaintenanceAttempt = { attemptId: string };

export interface PaymentMaintenanceDependencies<T extends MaintenanceAttempt> {
  expire(limit: number, signal: AbortSignal): Promise<ExpirationReport>;
  list(limit: number, signal: AbortSignal): Promise<T[]>;
  reconcile(attempt: T, signal: AbortSignal): Promise<void>;
  finish(attemptId: string, succeeded: boolean): Promise<void>;
  failed(attemptId: string): void;
  now?: () => number;
}

/** Coordinates bounded work; repositories keep financial transactions in SQL. */
export class PaymentMaintenanceService<T extends MaintenanceAttempt> {
  constructor(
    private readonly dependencies: PaymentMaintenanceDependencies<T>,
    private readonly budgetMs = 40_000,
  ) {}

  async run(limit: number) {
    const now = this.dependencies.now ?? Date.now;
    const startedAt = now();
    const deadline = startedAt + this.budgetMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.budgetMs);
    try {
      // Release overdue holds even if the provider is unavailable or slow. A
      // subsequent verified approval follows the existing stock reacquisition.
      const expiration = await this.dependencies.expire(limit, controller.signal);
      const attempts = await this.dependencies.list(limit, controller.signal);
      let reconciled = 0;
      let failed = 0;
      let next = 0;
      let interrupted = 0;
      await Promise.all(Array.from({ length: Math.min(3, attempts.length) }, async () => {
        while (next < attempts.length && now() < deadline && !controller.signal.aborted) {
          const attempt = attempts[next++]!;
          let succeeded = false;
          try {
            await this.dependencies.reconcile(attempt, controller.signal);
            succeeded = true;
          } catch {
            if (controller.signal.aborted || now() >= deadline) interrupted++;
            else failed++;
            this.dependencies.failed(attempt.attemptId);
          }
          try {
            // The adapter gives this small bookkeeping call its own short
            // timeout; cancellation must not leave a failed seller at the head.
            await this.dependencies.finish(attempt.attemptId, succeeded);
          } catch {
            failed++;
            this.dependencies.failed(attempt.attemptId);
          }
          if (succeeded) reconciled++;
        }
      }));
      return {
        reconciled,
        failed,
        expired: expiration.expired,
        deferred: attempts.length - next + interrupted,
        expiration,
        durationMs: Math.max(0, now() - startedAt),
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
