import { BackpressureError } from './errors';

export interface ConcurrencyLimiterOptions {
  name: string;
  maxInFlight: number;
  retryAfterSeconds?: number;
}

export interface ConcurrencyLimiter {
  readonly name: string;
  readonly maxInFlight: number;
  execute<T>(operation: () => Promise<T>): Promise<T>;
  getInFlight(): number;
}

/**
 * Reject-fast in-flight cap for money/RPC paths.
 *
 * When `maxInFlight` calls are already running, further calls throw
 * {@link BackpressureError} (HTTP 503) instead of queuing unbounded work
 * against Postgres or Soroban.
 */
export function createConcurrencyLimiter(
  options: ConcurrencyLimiterOptions,
): ConcurrencyLimiter {
  const maxInFlight = Math.max(1, options.maxInFlight);
  const retryAfterSeconds = options.retryAfterSeconds ?? 1;
  let inFlight = 0;

  return {
    name: options.name,
    maxInFlight,
    getInFlight: () => inFlight,
    async execute<T>(operation: () => Promise<T>): Promise<T> {
      if (inFlight >= maxInFlight) {
        throw new BackpressureError(
          `Too many in-flight ${options.name} operations. Please retry shortly.`,
          retryAfterSeconds,
        );
      }

      inFlight += 1;
      try {
        return await operation();
      } finally {
        inFlight -= 1;
      }
    },
  };
}
