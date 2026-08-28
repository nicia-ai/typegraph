/**
 * The sole classifier for managed writes that may omit an explicit transaction.
 *
 * A qualifying operation has exactly one stateful SQL statement. Its schema
 * fence, and (for edges) endpoint verdict, live inside that statement. Every
 * other managed-write shape retains `runInWriteTransaction`: an option here is
 * either applied by that one statement or this classifier refuses the path.
 */
import { type z } from "zod";

import { isBundledRootAutocommitEligible } from "../../backend/capabilities/autocommit-single-statement";
import { supportsNodeInsertProjectionRequirements } from "../../backend/capabilities/node-insert-projections";
import { isSchemaFencedInsertEligible } from "../../backend/capabilities/schema-fenced-insert";
import {
  type GraphBackend,
  type TransactionBackend,
} from "../../backend/types";
import { getEmbeddingFields } from "../embedding-sync";
import { getSearchableFields } from "../fulltext-sync";

/** Internal signal that a zero-row autocommit attempt needs transactional recovery. */
export class AutocommitWriteRequiresTransaction extends Error {
  constructor() {
    super("The managed autocommit attempt requires transactional recovery.");
    this.name = "AutocommitWriteRequiresTransaction";
  }
}

export type NodeAutocommitSingleStatementCandidate = Readonly<{
  backend: GraphBackend | TransactionBackend;
  schemaVersion: number | undefined;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
  identityEnabled: boolean;
  idGenerated: boolean;
  kindRegistered: boolean;
  uniqueConstraintCount: number;
  disjointKindCount: number;
  schema: z.ZodType;
}>;

export type EdgeAutocommitSingleStatementCandidate = Readonly<{
  backend: GraphBackend | TransactionBackend;
  schemaVersion: number | undefined;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
  kindRegistered: boolean;
  convergesDynamically: boolean;
  cardinality: "many" | "one" | "unique" | "oneActive";
}>;

export type AutocommitSingleStatementCandidate =
  | Readonly<{
      kind: "node";
      candidate: NodeAutocommitSingleStatementCandidate;
    }>
  | Readonly<{
      kind: "edge";
      candidate: EdgeAutocommitSingleStatementCandidate;
    }>;

/**
 * Whether the selected execution boundary can safely carry a schema fence in
 * the write statement. A root backend without interactive transactions may
 * use this only when its bundled-factory provenance proves the whole path is
 * the known one-statement implementation and this operation allows direct
 * root autocommit; derived wrappers intentionally do not inherit that proof.
 */
function canUseSchemaFenceAtExecutionBoundary(
  backend: GraphBackend | TransactionBackend,
  rootAutocommitAllowed: boolean,
): boolean {
  if (backend.commands.session === "transaction") return true;
  if (backend.capabilities.execution.interactiveTransactions) return true;
  return rootAutocommitAllowed && isBundledRootAutocommitEligible(backend);
}

/**
 * The operation-independent proof that the schema fence may be carried by
 * the first INSERT. SQL statement atomicity is the relevant guarantee here;
 * `capabilities.execution.interactiveTransactions` describes interactive transaction support and
 * is one valid boundary, but is not required for a proven bundled-root write.
 */
export function canFuseSchemaFenceInFirstWrite(
  input: AutocommitSingleStatementCandidate,
): boolean {
  switch (input.kind) {
    case "node": {
      const candidate = input.candidate;
      return (
        candidate.schemaVersion !== undefined &&
        canUseSchemaFenceAtExecutionBoundary(
          candidate.backend,
          candidate.idGenerated,
        ) &&
        isSchemaFencedInsertEligible(candidate.backend) &&
        !candidate.historyEnabled &&
        !candidate.revisionTrackingEnabled &&
        (!candidate.identityEnabled || candidate.idGenerated) &&
        candidate.kindRegistered &&
        candidate.uniqueConstraintCount === 0 &&
        candidate.disjointKindCount === 0 &&
        (candidate.idGenerated ?
          candidate.backend.insertNodeWithSchemaFence !== undefined
        : candidate.backend.insertNodeIfAbsentWithSchemaFence !== undefined)
      );
    }

    case "edge": {
      const candidate = input.candidate;
      return (
        candidate.schemaVersion !== undefined &&
        canUseSchemaFenceAtExecutionBoundary(candidate.backend, true) &&
        isSchemaFencedInsertEligible(candidate.backend) &&
        !candidate.historyEnabled &&
        !candidate.revisionTrackingEnabled &&
        candidate.kindRegistered &&
        !candidate.convergesDynamically &&
        candidate.cardinality === "many"
      );
    }
  }
}

/**
 * Returns true only for a bundled root's fully fused, one-statement write.
 *
 * This deliberately does not infer an opt-in from capability names or from a
 * custom backend implementing the fused members: a custom proxy can introduce
 * arbitrary work around a member call. The private root provenance is the
 * contract that makes direct autocommit safe.
 */
export function isAutocommitSingleStatementWrite(
  input: AutocommitSingleStatementCandidate,
): boolean {
  switch (input.kind) {
    case "node": {
      const candidate = input.candidate;
      return (
        candidate.schemaVersion !== undefined &&
        isBundledRootAutocommitEligible(candidate.backend) &&
        !candidate.historyEnabled &&
        !candidate.revisionTrackingEnabled &&
        !candidate.identityEnabled &&
        candidate.idGenerated &&
        candidate.kindRegistered &&
        candidate.uniqueConstraintCount === 0 &&
        candidate.disjointKindCount === 0 &&
        ((
          getEmbeddingFields(candidate.schema).length > 0 ||
          getSearchableFields(candidate.schema).length > 0
        ) ?
          supportsNodeInsertProjectionRequirements(candidate.backend, {
            embedding: getEmbeddingFields(candidate.schema).length > 0,
            fulltext: getSearchableFields(candidate.schema).length > 0,
          })
        : candidate.backend.insertNodeWithSchemaFence !== undefined)
      );
    }

    case "edge": {
      const candidate = input.candidate;
      return (
        candidate.schemaVersion !== undefined &&
        isBundledRootAutocommitEligible(candidate.backend) &&
        !candidate.historyEnabled &&
        !candidate.revisionTrackingEnabled &&
        candidate.kindRegistered &&
        !candidate.convergesDynamically &&
        candidate.cardinality === "many"
      );
    }
  }
}
