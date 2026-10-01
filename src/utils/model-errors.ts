function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function isModelRequestTooLarge(error: unknown): boolean {
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  return status === 413 || /\b413\b|request too large|context_length_exceeded|MODEL_CONTEXT_TOO_LARGE/i.test(errorText(error));
}

export function modelErrorResponse(error: unknown): { status: number; message: string } | undefined {
  if (isModelRequestTooLarge(error)) return { status: 413, message: "This request contains more context than the model can process. Narrow the request or start a new chat." };
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  if (status === 429 || /\b429\b|rate.?limit/i.test(errorText(error))) {
    return { status: 429, message: "The assistant has reached its model usage limit. Please try again after the limit resets." };
  }
  return undefined;
}
