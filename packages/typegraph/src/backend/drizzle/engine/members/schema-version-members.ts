/**
 * The four schema-commit members every SQL engine profile exposes:
 * `commitSchemaVersion`, `commitSchemaVersionIfKindsEmpty`,
 * `commitSchemaVersionWithPreflight`, and `setActiveVersion`. All four are a
 * full mirror — same body, same delegation — because every dialect
 * difference already lives one layer down, inside the write-fence-holding
 * transaction runner this group calls through `runSchemaWriteTransaction`
 * rather than reimplementing.
 *
 * `runSchemaWriteTransaction` comes from `EngineLateMembers.fence`
 * (`../profile.ts`), which is why this group is assembled inside
 * `createSqlBackend` after a profile's `lateMembers(ctx)` runs, rather than
 * living in `EngineAssemblyContext` itself or being folded into
 * `lateMembers` directly: it depends on a value `lateMembers` produces, not
 * one it receives.
 *
 * The populated-kind guard plus commit (the member of the same name this
 * group exposes delegates to it) is imported directly from
 * `operation-backend-core.ts`, the module that implements it once for both
 * dialects: this file is wired into `createSqlBackend` itself, a published
 * entrypoint root, but that entrypoint's module tree already imports
 * `drizzle-orm` as a value elsewhere (the contribution-marker member group
 * it assembles, and the fulltext gate it applies, both come from modules
 * that import it at module scope), so this import adds no new reach into a
 * real Drizzle package that was not already there.
 */
import type {
  CommitSchemaVersionIfKindsEmptyResult,
  CommitSchemaVersionParams,
  SchemaKindEmptinessProbe,
  SchemaVersionRow,
  SchemaWriteTransactionBackend,
  SetActiveVersionParams,
} from "../../../types";
import {
  commitSchemaVersionIfKindsEmpty,
  type InternalOperationBackend,
} from "../../operation-backend-core";

export type CreateSchemaVersionMembersDeps = Readonly<{
  /**
   * The internal, write-fence-holding transaction runner every member below
   * delegates to. Its uniform `(graphId, fn)` signature is what lets this
   * body stay dialect-agnostic: PostgreSQL's implementation locks the named
   * graph's schema row inside `fn`; SQLite's ignores `graphId` because its
   * schema lock is per-connection, not per-graph. `fn` receives the full
   * `InternalOperationBackend`, not the narrower `SchemaWriteTransactionBackend`
   * a caller's own preflight runs against — this runner is the trusted
   * internal caller the lock exists to gate.
   */
  runSchemaWriteTransaction: <T>(
    graphId: string,
    fn: (target: InternalOperationBackend) => Promise<T>,
  ) => Promise<T>;
}>;

export type SchemaVersionMembers = Readonly<{
  commitSchemaVersion: (
    params: CommitSchemaVersionParams,
  ) => Promise<SchemaVersionRow>;
  commitSchemaVersionIfKindsEmpty: (
    params: CommitSchemaVersionParams,
    probes: readonly SchemaKindEmptinessProbe[],
  ) => Promise<CommitSchemaVersionIfKindsEmptyResult>;
  commitSchemaVersionWithPreflight: (
    params: CommitSchemaVersionParams,
    // The schema-write target, not the narrowed transaction backend: a
    // preflight may have to CREATE the storage it then fills, and that DDL
    // belongs in this transaction rather than before it.
    preflight: (target: SchemaWriteTransactionBackend) => Promise<void>,
  ) => Promise<SchemaVersionRow>;
  setActiveVersion: (params: SetActiveVersionParams) => Promise<void>;
}>;

/**
 * Builds the schema-commit member group. Moved out of the two dialect files
 * unchanged: same fenced commit, same populated-kind guard, same
 * preflight-then-commit sequencing, same fenced `setActiveVersion`.
 */
export function createSchemaVersionMembers(
  deps: CreateSchemaVersionMembersDeps,
): SchemaVersionMembers {
  const { runSchemaWriteTransaction } = deps;

  return {
    async commitSchemaVersion(
      params: CommitSchemaVersionParams,
    ): Promise<SchemaVersionRow> {
      return runSchemaWriteTransaction(params.graphId, (target) =>
        target.commitSchemaVersion(params),
      );
    },

    async commitSchemaVersionIfKindsEmpty(
      params: CommitSchemaVersionParams,
      probes: readonly SchemaKindEmptinessProbe[],
    ): Promise<CommitSchemaVersionIfKindsEmptyResult> {
      return runSchemaWriteTransaction(params.graphId, (target) =>
        commitSchemaVersionIfKindsEmpty(target, params, probes),
      );
    },

    async commitSchemaVersionWithPreflight(
      params: CommitSchemaVersionParams,
      preflight: (target: SchemaWriteTransactionBackend) => Promise<void>,
    ): Promise<SchemaVersionRow> {
      return runSchemaWriteTransaction(params.graphId, async (target) => {
        await preflight(target);
        return target.commitSchemaVersion(params);
      });
    },

    async setActiveVersion(params: SetActiveVersionParams): Promise<void> {
      await runSchemaWriteTransaction(params.graphId, (target) =>
        target.setActiveVersion(params),
      );
    },
  };
}
