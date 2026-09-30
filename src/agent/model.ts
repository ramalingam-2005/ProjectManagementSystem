import { ChatGroq } from "@langchain/groq";

function apiKey(): string {
  const value =
    process.env.GROQ_API_KEY?.trim();

  if (!value) {
    throw new Error(
      "GROQ_API_KEY is missing"
    );
  }

  return value;
}

export function getModel(maxTokens = 1800) {
  return new ChatGroq({
    apiKey: apiKey(),

    model:
      process.env.GROQ_MODEL?.trim() ||
      "openai/gpt-oss-20b",

    temperature: 0,

    // Give enough room for a complete tool call
    maxTokens,

    // Important for GPT-OSS:
    // don't waste many tokens reasoning
    reasoningEffort: "low",

    maxRetries: 2,
  });
}

export function getRouterModel() {
  return new ChatGroq({
    apiKey: apiKey(),

    model:
      process.env.GROQ_ROUTER_MODEL?.trim() ||
      "openai/gpt-oss-20b",

    temperature: 0,

    // Router response should be tiny
    maxTokens: 200,

    reasoningEffort: "low",

    maxRetries: 2,
  });
}
