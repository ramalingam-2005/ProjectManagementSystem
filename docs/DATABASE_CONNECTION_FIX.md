# Database timeout recovery

The reported workload request failed with `Server selection timed out after
10000 ms`. A direct check subsequently connected in 7.6 seconds; three fresh
connections then completed in under one second. The original network outage
could not be reproduced during investigation.

## Recovery bug

The conversation checkpointer cached its initialization promise. When a
connection or index-setup attempt failed, that rejected promise remained cached.
Later chat requests could fail with the same error even after MongoDB recovered.
Initialization failures now clear the cached promise so a later request can
initialize again. Tests cover both connection and setup failure.

## Shared connection handling

- A process-wide pool cache survives development module reloads and shares
  concurrent connection attempts. Each connection configuration has its own key;
  credentials are hashed before being used as cache keys.
- Failed initial connections are closed and removed from the cache.
- Server selection defaults to 30 seconds. Set
  `MONGODB_SERVER_SELECTION_TIMEOUT_MS` to an integer from 1000 to 60000 to change
  it. This controls server selection, independently of query execution limits.
- Chat, health and review APIs return HTTP 503 with `DATABASE_UNAVAILABLE` for
  recognized MongoDB connection failures, without exposing connection strings.
- Wrapped read failures preserve their cause. A known database outage does not
  trigger another connection wait just to audit that failure to the same database.
  Normal successful actions and ordinary refusals retain their audit behavior.
- If a tool reports an outage, the agent stops requesting further actions and
  retains any confirmed receipts. The application does not replay the chat or
  business mutations. Approval retries continue to use the existing review ID.

MongoDB recommends reusing a client across requests and documents a 30-second
default server-selection timeout. See [client reuse](https://www.mongodb.com/docs/drivers/node/v6.x/connect/mongoclient/)
and [connection options](https://www.mongodb.com/docs/drivers/node/v6.x/connect/connection-options/).

## Verification

- `npm test`: 145 tests passed, including 15 connection/recovery regressions.
- `npm run typecheck`: passed.
- `npm run build`: passed, including TypeScript and production page generation.
- `npm run check:db`: passed; connection 922 ms, ping 63 ms in the verification run.
- `check:db` only connects and pings. It makes no model calls or record writes.
- The live Sprint 14 calculation passed for all 10 developers and reported Aditya
  Rao at 18 assigned points against 8 capacity. Diagnostic audit entries stayed
  in memory; no business records were changed.

Persistent network, DNS, cluster availability or access-list failures still need
infrastructure attention. A larger selection window cannot repair those failures.
