/**
 * The trust marks and atomic-program registrations `createSqlBackend`
 * applies to a freshly assembled backend, once the resource audit
 * (`create-sql-backend.ts`, the only audit writer) has already run.
 *
 * Every gate here mirrors the profile-refusal reasoning in
 * `create-sql-backend.ts`'s own doc comment: `markFirstPartyFactory` trusts
 * only the exact profile object `isFirstPartyProfile` recognizes, never a
 * copy, spread, or otherwise derived profile that merely resembles a
 * bundled one; `markBundledRootAutocommitEligible` trusts the profile's own
 * `autocommit.singleStatementDurable` declaration, never construction site
 * alone, because it is a durability claim; and `markSchemaFencedInsertEligible`
 * trusts the resolved fence plan actually fencing something
 * (`kind !== "unfenced"`), since the fused insert's lock clause is
 * profile-supplied and an empty clause is only correct when the profile's
 * own plan says writers are serialized.
 */
import {
  type AtomicMutationProgramRegistration,
  registerAtomicMutationPrograms,
} from "../../capabilities/atomic-mutation-program";
import { registerAtomicSqlProgram } from "../../capabilities/atomic-sql-program";
import { markBundledRootAutocommitEligible } from "../../capabilities/autocommit-single-statement";
import { markSchemaFencedInsertEligibleUnderFence } from "../../capabilities/schema-fenced-insert";
import {
  markFirstPartyFactory,
  type WriteFencePlan,
} from "../../capabilities/write-fence";
import {
  type AdapterBackend,
  type BackendCapabilities,
  supportsRootAtomicBatch,
} from "../../types";
import type { SqlExecutionAdapter } from "../execution/types";

export type ApplyEngineMarksDeps = Readonly<{
  /**
   * Whether `profile` is the exact object `isFirstPartyProfile` recognizes
   * (resolved once by `createSqlBackend`) — the sole gate on
   * `markFirstPartyFactory`.
   */
  isFirstParty: boolean;
  /** The backend's capabilities after `finalizeEngineCapabilities` runs — what `supportsRootAtomicBatch` gates the atomic-program registrations on. */
  capabilities: BackendCapabilities;
  /** The write-fence decision resolved once in `createSqlBackend`, gating `markSchemaFencedInsertEligible`. */
  fencePlan: WriteFencePlan;
  /** The profile's own durability declaration, gating `markBundledRootAutocommitEligible`. */
  autocommit: Readonly<{ singleStatementDurable: boolean }>;
  /** The profile's root execution adapter, registered as the atomic SQL program when the backend supports root atomic batching. */
  execution: SqlExecutionAdapter;
  /** The per-mutation-family atomic programs, assembled from the profile's operation-backend layer. */
  atomicMutationPrograms: AtomicMutationProgramRegistration;
}>;

/**
 * Applies every mark and registration a profile-built backend earns, in the
 * same order and under the same gates `createSqlBackend` always has.
 */
export function applyEngineMarks<TTx>(
  backend: AdapterBackend<TTx>,
  deps: ApplyEngineMarksDeps,
): void {
  if (deps.isFirstParty) {
    markFirstPartyFactory(backend);
  }
  markSchemaFencedInsertEligibleUnderFence(backend, deps.fencePlan);
  if (deps.autocommit.singleStatementDurable) {
    markBundledRootAutocommitEligible(backend);
  }
  if (supportsRootAtomicBatch(deps.capabilities)) {
    registerAtomicSqlProgram(backend, deps.execution);
    registerAtomicMutationPrograms(backend, deps.atomicMutationPrograms);
  }
}
