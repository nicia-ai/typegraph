# DoltLite development and validation

The maintained backend lives in `src/backend/doltlite`, with a typed Drizzle
transport under `src/backend/drizzle/doltlite-connection.ts`. The CLI smoke
runner uses this backend; it no longer substitutes a better-sqlite3 shim.
Public setup and capability details are in
[Backend Setup](../../../../apps/docs/src/content/docs/backend-setup.md#doltlite).

The backend needs a Node binding that preserves extended SQLite errors,
enables vec1/math functions, and releases its files on `close()`. Upstream
merged all three in
[doltlite-node#15](https://github.com/dolthub/doltlite-node/pull/15)
(closing [#9](https://github.com/dolthub/doltlite-node/issues/9),
[#10](https://github.com/dolthub/doltlite-node/issues/10) and
[#11](https://github.com/dolthub/doltlite-node/issues/11)), but no release
carries them yet: the published 0.51.14 binding predates the fix. The
source-build workflow therefore builds the unmodified upstream binding at
commit `5917efb805215dd49ff6798f78383be02e75a548` against the SHA-256
verified 0.51.14 engine release and runs upstream's native regression test.
This remains a release prerequisite until upstream publishes a fixed
binding; then the build script goes away and the dependency pin moves to
that release. The backend refuses a binding without structured errors before
opening user data; it never invents error codes from messages.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @nicia-ai/typegraph build:doltlite-binding
pnpm --filter @nicia-ai/typegraph smoke:doltlite
pnpm --filter @nicia-ai/typegraph test:doltlite
pnpm --filter @nicia-ai/typegraph test:doltlite:merge
```

The source build requires a C/C++ compiler, Python 3, Git, curl, and SHA-256
utilities. It builds in an ignored `packages/typegraph/tmp` directory and
replaces only the generated pnpm binding symlink. An ordinary dependency
install may restore the published binding; rebuild afterward.

The smoke runner owns disposable file-backed databases and reports PASS,
GAP, and FAIL separately. Ten checks pass with the source-built binding. Two
raw-SQL observations remain GAPs: `dolt_commit` can commit an enclosing SQL
transaction, and native row merge can conflict on shared recorded-clock and
recorded-anchor metadata. They are documented engine semantics, not a claim that the managed
backend fails its contract. Upstream confirmed the first matches Dolt and is
intended ([doltlite#2742](https://github.com/dolthub/doltlite/issues/2742)). Unexpected results, including a changed pinned
gap, fail the command.

The shared adapter/integration battery runs without weakened assertions.
The core lane explicitly disables vectors, like the raw SQLite adapter lane;
separate vec1 cases exercise the managed embedding and hybrid-query paths.
The shared graph-merge matrix has a DoltLite selector and runs all 51 existing
matrix suites. Additional cases cover native branch allocation, semantic
merge, cleanup, recorded reads after reopen, and writer contention.

Validation on Node 24 with the source-built binding (doltlite-node
`5917efb8`, engine 0.51.14, macOS arm64): `test:doltlite` passed 2,411
cases with the shared suite's existing 49 skips, covering the shared
adapter/integration battery and the dedicated lifecycle, crash-recovery, and
vector cases; `test:doltlite:merge` passed 615 graph-merge cases. CI runs
Node 22 and 24 on Linux. Windows, ANN indexing, and browser/WASM remain
outside the validated capability set; the Windows `close()` file-handle leak
([doltlite-node#11](https://github.com/dolthub/doltlite-node/issues/11)) is
fixed by the same upstream change, but Windows itself is still unvalidated
here.
