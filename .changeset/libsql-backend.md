---
"@nicia-ai/typegraph": minor
---

Add first-class libsql backend at `@nicia-ai/typegraph/sqlite/libsql`

### New convenience export

`createLibsqlBackend(client, options?)` wraps `@libsql/client` with automatic DDL
execution and correct async execution profile. The caller retains ownership of the
client, enabling shared-driver setups. Works with local files, in-memory databases,
and remote Turso URLs.

```typescript
import { createClient } from "@libsql/client";
import { createLibsqlBackend } from "@nicia-ai/typegraph/sqlite/libsql";

const client = createClient({ url: "file:app.db" });
const { backend, db } = await createLibsqlBackend(client);
const store = createStore(graph, backend);
```

### Bug fixes for async SQLite drivers

- **`db.get()` crash on empty results** — switched to `db.all()[0]` to work around
  Drizzle's `normalizeRow` crash when libsql returns no rows
  ([drizzle-team/drizzle-orm#1049](https://github.com/drizzle-team/drizzle-orm/issues/1049))
- **`instanceof Promise` check fails for Drizzle thenables** — all SQLite exec helpers
  now use unconditional `await` since Drizzle returns `SQLiteRaw` objects that are
  thenable but not `Promise` instances
  ([drizzle-team/drizzle-orm#2275](https://github.com/drizzle-team/drizzle-orm/issues/2275))

### Internal improvements

- Extracted `wrapWithManagedClose()` helper for idempotent backend close with teardown
- Shared adapter and integration test suites now accept async backend factories
- libsql backend runs the full shared test suite (214 tests)
