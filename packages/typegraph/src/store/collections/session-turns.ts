/**
 * Collection calls on a caller-owned transaction session, one turn each.
 *
 * A collection call reads session state before it writes — an edge delete's
 * lookup and early return, a get-or-create's probe, an upsert's prefetch —
 * and decides from what it read. An overlapping call that opens a TypeGraph
 * savepoint scope can change that state and later roll it back, so the call
 * takes its turn on the session ({@link withSessionTurn}) at its entry, before
 * its first read, and keeps it until it returns. Units the call makes inside
 * that turn (its write frame, savepoint scope, sidecar sync) nest under it.
 *
 * Which members are calls is derived from the collection types: every member
 * returning a promise is one unit; a member returning a query builder issues
 * nothing until the builder runs, so it is passed through. The classification
 * tables below are checked against the types, so a new collection member must
 * be classified before the package compiles.
 */
import { withSessionTurn } from "../../backend/session-exclusivity";
import {
  type GraphBackend,
  type TransactionBackend,
} from "../../backend/types";
import { type AnyEdgeType, type NodeType } from "../../core/types";
import { type EdgeCollection, type NodeCollection } from "../types";

type MemberClass<Member> =
  Member extends (...args: never) => PromiseLike<unknown> ? "session-unit"
  : "builder";

type MemberClasses<Collection> = {
  readonly [Key in keyof Collection]-?: MemberClass<Collection[Key]>;
};

const NODE_COLLECTION_MEMBERS = {
  create: "session-unit",
  createFromRecord: "session-unit",
  getById: "session-unit",
  getByIds: "session-unit",
  update: "session-unit",
  compareAndSet: "session-unit",
  updateWhere: "session-unit",
  reparent: "session-unit",
  bulkReparent: "session-unit",
  delete: "session-unit",
  hardDelete: "session-unit",
  planDelete: "session-unit",
  find: "session-unit",
  count: "session-unit",
  upsertById: "session-unit",
  upsertByIdFromRecord: "session-unit",
  bulkCreate: "session-unit",
  bulkUpsertById: "session-unit",
  bulkReplaceById: "session-unit",
  bulkInsert: "session-unit",
  bulkDelete: "session-unit",
  bulkHardDelete: "session-unit",
  findByConstraint: "session-unit",
  bulkFindByConstraint: "session-unit",
  bulkFindByIndex: "session-unit",
  getOrCreateByConstraint: "session-unit",
  bulkGetOrCreateByConstraint: "session-unit",
} as const satisfies MemberClasses<NodeCollection<NodeType>>;

const EDGE_COLLECTION_MEMBERS = {
  create: "session-unit",
  getById: "session-unit",
  getByIds: "session-unit",
  update: "session-unit",
  findFrom: "session-unit",
  findTo: "session-unit",
  bulkFindFrom: "session-unit",
  bulkFindTo: "session-unit",
  batchFindFrom: "builder",
  batchFindTo: "builder",
  batchFindByEndpoints: "builder",
  delete: "session-unit",
  hardDelete: "session-unit",
  find: "session-unit",
  count: "session-unit",
  bulkCreate: "session-unit",
  bulkUpsertById: "session-unit",
  bulkInsert: "session-unit",
  bulkDelete: "session-unit",
  bulkHardDelete: "session-unit",
  findByEndpoints: "session-unit",
  getOrCreateByEndpoints: "session-unit",
  bulkGetOrCreateByEndpoints: "session-unit",
} as const satisfies MemberClasses<EdgeCollection<AnyEdgeType>>;

type MemberTable = Readonly<Record<string, "session-unit" | "builder">>;

function withSessionTurns<Collection extends object>(
  collection: Collection,
  members: MemberTable,
  backend: GraphBackend | TransactionBackend,
): Collection {
  const record = collection as Readonly<
    Record<string, (...args: readonly unknown[]) => unknown>
  >;
  const wrapped: Record<string, unknown> = { ...record };
  for (const [name, memberClass] of Object.entries(members)) {
    if (memberClass !== "session-unit") continue;
    const member = record[name];
    if (member === undefined) continue;
    wrapped[name] = (...args: unknown[]) =>
      withSessionTurn(backend, async () => {
        // Awaited inside the turn, so a synchronous throw rejects too.
        const result: unknown = await Reflect.apply(member, collection, args);
        return result;
      });
  }
  return wrapped as Collection;
}

/** A node collection whose every call is one turn on `backend`'s session. */
export function nodeCollectionInSessionTurns<Collection extends object>(
  collection: Collection,
  backend: GraphBackend | TransactionBackend,
): Collection {
  return withSessionTurns(collection, NODE_COLLECTION_MEMBERS, backend);
}

/** An edge collection whose every call is one turn on `backend`'s session. */
export function edgeCollectionInSessionTurns<Collection extends object>(
  collection: Collection,
  backend: GraphBackend | TransactionBackend,
): Collection {
  return withSessionTurns(collection, EDGE_COLLECTION_MEMBERS, backend);
}
