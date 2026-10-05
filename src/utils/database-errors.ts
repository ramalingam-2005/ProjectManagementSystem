const CONNECTION_ERRORS = new Set([
  "MongoServerSelectionError", "MongoNetworkError", "MongoNetworkTimeoutError",
  "MongoTopologyClosedError", "MongoNotConnectedError", "MongoPoolClearedError",
  "MongoWaitQueueTimeoutError",
]);

export function databaseErrorResponse(error: unknown): { status: 503; code: "DATABASE_UNAVAILABLE"; message: string } | undefined {
  const seen = new Set<unknown>();
  for (let cause = error; cause && typeof cause === "object" && !seen.has(cause);) {
    seen.add(cause);
    const value = cause as { name?: unknown; cause?: unknown };
    if (typeof value.name === "string" && CONNECTION_ERRORS.has(value.name)) {
      return {
        status: 503,
        code: "DATABASE_UNAVAILABLE",
        message: "The workspace database is temporarily unavailable. Please try again after the connection recovers.",
      };
    }
    cause = value.cause;
  }
  return undefined;
}
