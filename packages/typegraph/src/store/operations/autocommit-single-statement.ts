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
import { type GraphBackend } from "../../backend/types";
import { getEmbeddingFields } from "../embedding-sync";
import { getSearchableFields } from "../fulltext-sync";

export type NodeAutocommitSingleStatementCandidate = Readonly<{
  backend: GraphBackend;
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
  backend: GraphBackend;
  schemaVersion: number | undefined;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
  idGenerated: boolean;
  kindRegistered: boolean;
  convergesOnMatchKey: boolean;
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
        candidate.backend.capabilities.transactions &&
        isBundledRootAutocommitEligible(candidate.backend) &&
        !candidate.historyEnabled &&
        !candidate.revisionTrackingEnabled &&
        !candidate.identityEnabled &&
        candidate.idGenerated &&
        candidate.kindRegistered &&
        candidate.uniqueConstraintCount === 0 &&
        candidate.disjointKindCount === 0 &&
        getEmbeddingFields(candidate.schema).length === 0 &&
        getSearchableFields(candidate.schema).length === 0 &&
        candidate.backend.insertNodeWithSchemaFence !== undefined
      );
    }

    case "edge": {
      const candidate = input.candidate;
      return (
        candidate.schemaVersion !== undefined &&
        candidate.backend.capabilities.transactions &&
        isBundledRootAutocommitEligible(candidate.backend) &&
        !candidate.historyEnabled &&
        !candidate.revisionTrackingEnabled &&
        candidate.idGenerated &&
        candidate.kindRegistered &&
        !candidate.convergesOnMatchKey &&
        candidate.cardinality === "many" &&
        candidate.backend.insertEdgeIfEndpointsLiveWithSchemaFence !== undefined
      );
    }
  }
}
