/**
 * The one factory every SQL engine profile is assembled through.
 *
 * `createSqlBackend` owns what is the same for every SQL engine: deriving
 * the final capabilities, resolving the write-fence decision once, refusing
 * a profile that cannot back the marks it is about to earn, assembling the
 * backend object literal from a profile's members, auditing its resource
 * shape, and applying the trust marks and atomic-program registrations. A
 * profile owns only what genuinely differs between engines.
 */
import { ConfigurationError } from "../../../errors";
import { registerAtomicMutationPrograms } from "../../capabilities/atomic-mutation-program";
import { registerAtomicSqlProgram } from "../../capabilities/atomic-sql-program";
import { markBundledRootAutocommitEligible } from "../../capabilities/autocommit-single-statement";
import { markSchemaFencedInsertEligible } from "../../capabilities/schema-fenced-insert";
import {
  markFirstPartyFactory,
  pessimisticLockDeclarationLine,
  resolveWriteFencePlan,
} from "../../capabilities/write-fence";
import { auditBackendResource } from "../../transaction-resource";
import { type AdapterBackend, supportsRootAtomicBatch } from "../../types";
import { finalizeEngineCapabilities } from "./capabilities";
import { createSchemaVersionMembers } from "./members/schema-version-members";
import type { EngineAssemblyContext, SqlEngineProfile } from "./profile";

/**
 * Assembles one `AdapterBackend` from a {@link SqlEngineProfile}.
 *
 * The three refusals below are what makes marking sound for a profile this
 * factory did not write itself, not only for the two bundled ones:
 *
 * - a profile whose resolved capabilities omit `pessimisticLocks` is
 *   refused outright — every other mark and registration below assumes a
 *   resolvable write-fence decision, and `resolveWriteFencePlan`'s
 *   dialect-derivation fallback is sound only for the two bundled dialects;
 * - `markBundledRootAutocommitEligible` is gated on the profile's own
 *   `autocommit.singleStatementDurable` declaration, never on construction
 *   site alone — it is a durability claim, not a convenience;
 * - `markSchemaFencedInsertEligible` is gated on the resolved fence plan
 *   actually fencing something (`kind !== "unfenced"`), since the fused
 *   insert's lock clause is profile-supplied and an empty clause is only
 *   correct when the profile's own plan says writers are serialized.
 */
export function createSqlBackend<TTx>(
  profile: SqlEngineProfile<TTx>,
): AdapterBackend<TTx> {
  const capabilities = finalizeEngineCapabilities(profile.declaredCapabilities, {
    execution: profile.execution,
    contributionRebuildSupported: profile.contributionRebuildSupported,
  });

  if (capabilities.pessimisticLocks === undefined) {
    throw new ConfigurationError(
      "This engine profile declares no usable write fence: " +
        "capabilities.pessimisticLocks is absent, so createSqlBackend " +
        "cannot resolve a write-fence decision for it and refuses to mark " +
        "it as fenced. Add ONE line to the capabilities the profile " +
        `declares:\n\n  ${pessimisticLockDeclarationLine(profile.dialect)}\n\n` +
        "(that is the correct declaration for this profile's dialect).",
      {
        code: "ENGINE_PROFILE_REQUIRES_WRITE_FENCE_DECLARATION",
        dialect: profile.dialect,
      },
      {
        suggestion:
          "Declare capabilities.pessimisticLocks on this profile's declaredCapabilities.",
      },
    );
  }

  const fencePlan = resolveWriteFencePlan({
    dialect: profile.dialect,
    capabilities,
  });

  const ctx: EngineAssemblyContext<TTx> = {
    capabilities,
    fencePlan,
    operations: profile.operations,
    contributionMaterializer: profile.contributionMaterializer,
    self: () => backend,
  };

  const late = profile.lateMembers(ctx);
  const inline = profile.inlineMembers(ctx);

  // Annotated against the real `AdapterBackend<TTx>` declarations (`this:
  // void` included, and `commitSchemaVersionWithPreflight`'s
  // `SchemaCommitPreflightBackend` preflight parameter) rather than left to
  // infer `SchemaVersionMembers`. Once this group is spread into the `as
  // AdapterBackend<TTx>` literal below, that cast can no longer catch a
  // divergence between `SchemaVersionMembers` and the four keys it fills —
  // this annotation is what still does. Every later group assembled here
  // rather than inside a profile's own `inlineMembers` gets the same
  // treatment.
  const schemaVersionMembers: Required<
    Pick<
      AdapterBackend<TTx>,
      | "commitSchemaVersion"
      | "commitSchemaVersionIfKindsEmpty"
      | "commitSchemaVersionWithPreflight"
      | "setActiveVersion"
    >
  > = createSchemaVersionMembers({
    runSchemaWriteTransaction: late.fence.runSchemaWriteTransaction,
    commitSchemaVersionIfKindsEmpty:
      late.schemaCommit.commitSchemaVersionIfKindsEmpty,
  });

  // `inline` is a `Partial<AdapterBackend<TTx>>` (it drains toward empty as
  // later steps extract its members into shared factories), so TypeScript
  // sees every key it contributes as optional in the object literal below —
  // including `close`, which every profile always supplies today. The cast
  // is the one place that gap is bridged; `AdapterBackend<TTx>` is not
  // otherwise narrowed or reconstructed here. Until `inlineMembers` is
  // removed, this cast is the only place completeness could silently break;
  // the member-key-set characterization snapshot in
  // tests/engine-profile-parity.test.ts is what actually catches a missing
  // member group in the meantime, and this cast must go when
  // `inlineMembers` does.
  //
  // `inline` is spread LAST on purpose: while any group extracted out of it
  // still has a same-named body left behind in a profile's own
  // `inlineMembers` (a deletion an extraction step forgot), `inline` wins
  // the key and the stale body keeps running unnoticed, because a spread's
  // duplicate keys are invisible to both TypeScript and this cast. Placing
  // every extracted group — `schemaVersionMembers` included — before
  // `inline` means a forgotten deletion is caught the moment a
  // characterization test exercises the member, rather than silently
  // reintroducing the old body. Keep new groups assembled here ahead of
  // `inline` for the same reason.
  const backend = {
    ...ctx.operations,
    ...late.transactions,
    ...late.rawSql,
    lockSchemaVersionForWrite: late.fence.lockSchemaVersionForWrite,
    ...schemaVersionMembers,
    ...late.maintenance,
    ...(late.trustedImport === undefined ?
      {}
    : { trustedImport: late.trustedImport }),
    ...late.extensions,
    ...inline,
  } as AdapterBackend<TTx>;

  // INVARIANT: audit before any wrapper can observe this backend — see
  // transaction-resource.ts. Unconditional: an abstention recorded as
  // "independent" is a verdict the guards can tell apart from a backend
  // nobody looked at.
  auditBackendResource(backend, profile.resourceAudit);
  markFirstPartyFactory(backend);
  if (fencePlan.kind !== "unfenced") {
    markSchemaFencedInsertEligible(backend);
  }
  if (profile.autocommit.singleStatementDurable) {
    markBundledRootAutocommitEligible(backend);
  }
  if (supportsRootAtomicBatch(capabilities)) {
    registerAtomicSqlProgram(backend, profile.execution);
    registerAtomicMutationPrograms(backend, {
      createNodes: ctx.operations.executeAtomicNodeBatch,
      replaceNodes: ctx.operations.executeAtomicNodeReplacementBatch,
      createEdges: ctx.operations.executeAtomicEdgeBatch,
      deleteNodes: ctx.operations.executeAtomicNodeDeleteBatch,
      deleteEdges: ctx.operations.executeAtomicEdgeDeleteBatch,
      updateNodes: ctx.operations.executeAtomicNodeResolvedUpdateBatch,
      updateEdges: ctx.operations.executeAtomicEdgeResolvedUpdateBatch,
      mutateNodes: ctx.operations.executeAtomicNodeResolvedMutationSet,
      mutateEdges: ctx.operations.executeAtomicEdgeMutationProgram,
    });
  }

  return backend;
}
