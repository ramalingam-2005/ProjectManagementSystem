import { isModelRequestTooLarge } from "@/src/utils/model-errors";

function retryAfterMs(error: unknown, attempt: number): number {
  const message = error instanceof Error ? error.message : String(error);
  const seconds = message.match(/try again in\s+([0-9.]+)s/i)?.[1];
  if (seconds) return Math.ceil(Number(seconds) * 1000) + 250;
  return Math.min(2000 * 2 ** attempt, 12_000);
}

function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Sending the same oversized payload again cannot resolve a size failure.
  if (isModelRequestTooLarge(error) || /tokens per day|\(TPD\)/i.test(message)) return false;
  return /429|rate.?limit|503|unavailable|timeout|ECONNRESET|tool_use_failed|Failed to call a function/i.test(message);
}

export async function withModelRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === maxAttempts - 1) throw error;
      const delay = retryAfterMs(error, attempt);
      if (delay > 30_000) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
