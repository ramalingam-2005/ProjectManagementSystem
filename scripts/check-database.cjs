// Connectivity-only diagnostic: no model calls or database writes.
const { performance } = require("node:perf_hooks");
const { getDb, closeMongoClients } = require("../src/db/mongodb.ts");
const { databaseErrorResponse } = require("../src/utils/database-errors.ts");

(async () => {
  const start = performance.now();
  try {
    const db = await getDb();
    const connected = performance.now();
    await db.command({ ping: 1 });
    console.log(JSON.stringify({ ok: true, mongodb: "reachable", connectionMs: Math.round(connected - start), pingMs: Math.round(performance.now() - connected) }));
  } catch (error) {
    const unavailable = databaseErrorResponse(error);
    console.error(JSON.stringify({ ok: false, code: unavailable?.code ?? "DATABASE_CONNECTION_FAILED", error: unavailable?.message ?? "Check the database configuration and server logs.", type: error.name, elapsedMs: Math.round(performance.now() - start) }));
    process.exitCode = 1;
  } finally {
    await closeMongoClients();
  }
})();
