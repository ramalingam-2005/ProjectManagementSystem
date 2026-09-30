import { Db, MongoClient } from "mongodb";

let clientPromise: Promise<MongoClient> | null = null;

export function getDbName(): string {
  return process.env.MONGODB_DB?.trim() || "product_engineering";
}

export async function getMongoClient(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error("MONGODB_URI is missing");

  if (!clientPromise) {
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 10_000,
    });
    clientPromise = client.connect().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }

  return clientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(getDbName());
}
