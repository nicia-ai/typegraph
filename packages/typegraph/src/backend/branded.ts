/**
 * Nominal brands that make the store's "which backend does this work go
 * through?" decision a compile-time choice instead of a convention.
 *
 * A history-enabled `Store` holds the same `GraphBackend` shape in two roles:
 *
 * - the **recorded-capture wrapper**, through which every public graph-entity
 *   write must flow so the write is captured, and
 * - the **bare backend**, used for raw SQL / DDL / bulk-materialization work
 *   that intentionally bypasses capture (the wrapper rejects raw DDL and writes
 *   no graph entities of its own).
 *
 * Routing a graph write through the bare backend silently loses history with no
 * error. The brands below turn that footgun into a type error: a function that
 * does bulk/DDL work declares `RawBackend`, a function that performs graph
 * writes declares `GraphWriteBackend`, and the two are not mutually assignable.
 *
 * The brand is erased at runtime — both values are ordinary `GraphBackend`s.
 * Only the `as*` tagging functions, called at the few seams where a role is
 * asserted, bridge a plain backend into a role; they are the greppable audit
 * surface for "this path was deliberately routed to a capture role."
 *
 * This does not brand `TransactionBackend`: the collection-write entrypoint is
 * polymorphic over `GraphBackend | TransactionBackend`, and a raw backend is
 * structurally a `TransactionBackend`, so a brand there would be swallowed by
 * the union. The protection therefore covers the full-`GraphBackend` bulk/DDL
 * seams (where new capture-bypassing paths are actually added). Branding the
 * transaction surface is a deliberate follow-up, gated on a real bypass pattern.
 */
import { type GraphBackend } from "./types";

declare const BackendRoleBrand: unique symbol;

/**
 * The backend through which **graph-entity writes** (node/edge
 * create/update/delete) flow. When `history: true` this is the recorded-capture
 * wrapper; when history is off it is the bare backend. Either way, routing graph
 * writes here is what guarantees capture runs when it should.
 */
export type GraphWriteBackend = GraphBackend &
  Readonly<{ [BackendRoleBrand]: "graph-write" }>;

/**
 * A backend for raw SQL / DDL / bulk-materialization work that **intentionally
 * bypasses** recorded-time capture. Never route public graph-entity writes
 * here — that is the silent-history-loss footgun this brand exists to catch.
 */
export type RawBackend = GraphBackend & Readonly<{ [BackendRoleBrand]: "raw" }>;

/** Tags a backend as the graph-write seam. Call only where capture is wired. */
export function asGraphWriteBackend(backend: GraphBackend): GraphWriteBackend {
  return backend as GraphWriteBackend;
}

/** Tags a backend as the raw/DDL/bulk seam (capture-bypassing). */
export function asRawBackend(backend: GraphBackend): RawBackend {
  return backend as RawBackend;
}
