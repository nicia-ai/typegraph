# DoltLite development and validation

The maintained backend lives in `src/backend/doltlite`, with a typed Drizzle
transport under `src/backend/drizzle/doltlite-connection.ts`. The CLI smoke
runner uses this backend; it no longer substitutes a better-sqlite3 shim.
Public setup and capability details are in
[Backend Setup](../../../../apps/docs/src/content/docs/backend-setup.md#doltlite).

The published Node binding 0.51.1 drops extended SQLite errors and disables
vec1/math functions. The source-build workflow applies
[the upstream patch](../../../../patches/doltlite-node-0.51.1.patch), pinned
to binding commit `120662566453e808ed799ac6f69f9eebf165809f` and the SHA-256
verified 0.51.1 engine release. This remains a release prerequisite until
upstream publishes those fixes. The backend refuses the unpatched binding
before opening user data; it never invents error codes from messages.

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
GAP, and FAIL separately. Ten checks pass with the patched binding. Two
raw-SQL observations remain GAPs: `dolt_commit` can commit an enclosing SQL
transaction, and native row merge can conflict on shared recorded-clock
metadata. They are documented engine semantics, not a claim that the managed
backend fails its contract. Unexpected results, including a changed pinned
gap, fail the command.

The shared adapter/integration battery runs without weakened assertions.
The core lane explicitly disables vectors, like the raw SQLite adapter lane;
separate vec1 cases exercise the managed embedding and hybrid-query paths.
The shared graph-merge matrix has a DoltLite selector and runs all 40 existing
matrix suites. Additional cases cover native branch allocation, semantic
merge, cleanup, recorded reads after reopen, and writer contention.

Validation on Node 24/Linux with the patched binding: 1,183 shared cases
passed, with the shared suite's existing 28 skips; 432 graph-merge cases
passed; dedicated cases cover lifecycle, crash recovery, and vectors. CI runs
Node 22 and 24 on Linux. Other platforms, ANN indexing, and browser/WASM
remain outside the validated capability set.
