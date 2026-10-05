import { Db, MongoClient } from "mongodb";
import { createHash } from "node:crypto";

// Next.js development reloads can evaluate this module again. Share connection
// attempts across those evaluations and concurrent requests in this process.
const cacheKey = Symbol.for("product-engineering.mongodb.clients");
const processCache = globalThis as typeof globalThis & { [cacheKey]?: Map<string, Promise<MongoClient>> };
const clients = processCache[cacheKey] ??= new Map<string, Promise<MongoClient>>();

function serverSelectionTimeoutMS(): number {
  const value = process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS?.trim();
  if (!value) return 30_000;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 60_000) {
    throw new Error("MONGODB_SERVER_SELECTION_TIMEOUT_MS must be an integer between 1000 and 60000.");
  }
  return milliseconds;
}

export function getDbName(): string {
  return process.env.MONGODB_DB?.trim() || "product_engineering";
}

export async function getMongoClient(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error("MONGODB_URI is missing");

  const timeout = serverSelectionTimeoutMS();
  // Configuration changes must not reuse a client for another database URI.
  // Keep credentials out of the cache key and any diagnostics.
  const key = createHash("sha256").update(JSON.stringify([uri, timeout])).digest("hex");
  let clientPromise = clients.get(key);
  if (!clientPromise) {
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 0,
      serverSelectionTimeoutMS: timeout,
    });
    clientPromise = client.connect().catch(async (error) => {
      if (clients.get(key) === clientPromise) clients.delete(key);
      try { await client.close(); } catch { /* Keep the original connection error. */ }
      throw error;
    });
    clients.set(key, clientPromise);
  }

  return clientPromise;
}

// For process shutdown and command-line diagnostics, never per HTTP request.
export async function closeMongoClients(): Promise<void> {
  const pending = [...clients.values()];
  clients.clear();
  await Promise.allSettled(pending.map(async (entry) => (await entry).close()));
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(getDbName());
}
