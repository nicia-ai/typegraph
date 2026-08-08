import { type GraphDef } from "../core/define-graph";
import { type ReadCoordinate } from "../core/temporal";
import { type SqlSchema } from "../query/compiler/schema";
import { type KindRegistry } from "../registry/kind-registry";
import { type IdentityTarget, type PlainNodeRef } from "./sql-target";
import { type IdentityNode } from "./types";

export type IdentityServiceContext<G extends GraphDef> = Readonly<{
  graph: G;
  graphId: string;
  schemaVersion: number | undefined;
  registry: KindRegistry;
  backend: IdentityTarget;
  schema: SqlSchema;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
  sameIdAcrossKinds: "fold" | "ignore";
  coordinate?: ReadCoordinate;
  loadNodes: (
    references: readonly PlainNodeRef[],
    coordinate?: ReadCoordinate,
  ) => Promise<readonly (IdentityNode<G> | undefined)[]>;
}>;

export type IdentityTransferAssertion = Readonly<{
  id: string;
  relation: "same" | "different";
  a: PlainNodeRef;
  b: PlainNodeRef;
  validFrom: string;
  validTo?: string | undefined;
  endedBy?: PlainNodeRef | undefined;
}>;

export type IdentityImportSummary = Readonly<{
  created: number;
  skipped: number;
}>;

export type IdentityInterchangeReadOptions = Readonly<{
  nodeKinds?: readonly string[];
  includeDeleted?: boolean;
}>;

export type IdentityAssertionPageOptions = IdentityInterchangeReadOptions &
  Readonly<{
    /** Exclusive assertion-id cursor. */
    after?: string;
    limit: number;
  }>;

export type IdentityAssertionPage = Readonly<{
  assertions: readonly IdentityTransferAssertion[];
  /** Cursor of the last database row scanned, including filtered-out rows. */
  nextAfter?: string;
  /** Whether the database returned fewer rows than the requested scan limit. */
  done: boolean;
}>;
