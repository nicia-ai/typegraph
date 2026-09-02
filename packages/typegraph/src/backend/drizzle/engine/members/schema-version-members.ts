/**
 * The four schema-commit members every SQL engine profile exposes:
 * `commitSchemaVersion`, `commitSchemaVersionIfKindsEmpty`,
 * `commitSchemaVersionWithPreflight`, and `setActiveVersion`. All four are a
 * full mirror — same body, same delegation — because every dialect
 * difference already lives one layer down, inside the write-fence-holding
 * transaction runner this group calls through `runSchemaWriteTransaction`
 * rather than reimplementing.
 *
 * Both deps come from `EngineLateMembers` (`../profile.ts`) —
 * `runSchemaWriteTransaction` from its `fence` group, and
 * `commitSchemaVersionIfKindsEmpty` from the sibling `schemaCommit` group
 * (it issues no lock itself, so it is not filed under `fence`) — which is
 * why this group is assembled inside `createSqlBackend` after a profile's
 * `lateMembers(ctx)` runs, rather than living in `EngineAssemblyContext`
 * itself or being folded into `lateMembers` directly: both depend on
 * values `lateMembers` produces, not ones it receives.
 *
 * `commitSchemaVersionIfKindsEmpty` (the populated-kind guard plus commit —
 * the dep, as opposed to the member of the same name this group exposes) is
 * the shared helper `operation-backend-core.ts` implements once and both
 * dialects call identically today. It arrives as a dep rather than a direct
 * import of that module: this file is wired into `createSqlBackend` itself,
 * a published entrypoint root whose runtime must not reach a real Drizzle
 * package until the operation-layer extraction folds that module in for
 * good; `operation-backend-core.ts` imports `drizzle-orm` at module scope,
 * so re-importing one of its functions here would leak that edge into the
 * entrypoint today. Only its TYPE (`InternalOperationBackend`) is imported
 * directly — type-only imports are erased at build time and so carry none
 * of that weight.
 */
import type {
  CommitSchemaVersionIfKindsEmptyResult,
  CommitSchemaVersionParams,
  SchemaKindEmptinessProbe,
  SchemaVersionRow,
  SchemaWriteTransactionBackend,
  SetActiveVersionParams,
} from "../../../types";
import type { InternalOperationBackend } from "../../operation-backend-core";

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
  /**
   * The populated-kind guard plus commit, called identically by both
   * dialects — see the module doc comment for why it arrives as a dep
   * rather than a direct import.
   */
  commitSchemaVersionIfKindsEmpty: (
    target: InternalOperationBackend,
    params: CommitSchemaVersionParams,
    probes: readonly SchemaKindEmptinessProbe[],
  ) => Promise<CommitSchemaVersionIfKindsEmptyResult>;
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
  const { runSchemaWriteTransaction, commitSchemaVersionIfKindsEmpty } = deps;

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
