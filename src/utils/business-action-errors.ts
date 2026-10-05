export const INSERT_ONE_PAYLOAD_ERROR = "INVALID_INSERT_PAYLOAD:insert_one requires fieldsJson as a non-empty JSON array of FieldChange objects. Do not use documentsJson for insert_one.";
export const INSERT_MANY_PAYLOAD_ERROR = "INVALID_INSERT_PAYLOAD:insert_many requires documentsJson as a non-empty JSON array of {fields:[FieldChange,...]}. Do not use fieldsJson for insert_many.";

export class SprintCreationError extends Error {
  constructor(code: string, public readonly userMessage: string, public readonly correction?: string) {
    super(`${code}:${correction ?? userMessage}`);
  }
}

// These failures occur before a business write (or after a confirmed zero-match
// conditional update). They require clarification, never an automatic replay.
export class BugWorkflowError extends Error {
  constructor(code: string, public readonly userMessage: string) {
    super(`${code}:${userMessage}`);
  }
}
