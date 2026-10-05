import { z } from "zod";
import type { Document } from "mongodb";
import type { MongoReadOperation } from "@/src/security/mongo-policy";

export interface MongoReadAction {
  collection: string;
  operation: MongoReadOperation;
  filter?: Document;
  projection?: Document;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  pipeline?: Document[];
  reason?: string;
}

// The recursive safety validator handles operators and values inside these objects.
export const MongoReadActionSchema = z.object({
  collection: z.string().min(1).max(80), operation: z.string().min(1).max(40),
  filter: z.record(z.unknown()).optional(), projection: z.record(z.unknown()).optional(),
  sort: z.record(z.unknown()).optional(), pipeline: z.array(z.record(z.unknown())).optional(),
  limit: z.number().optional(), skip: z.number().optional(), reason: z.string().max(180).optional(),
}).strict();
