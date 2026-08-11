/**
 * The backend members no module outside the sanctioned write seam may call.
 *
 * `WRITE_MEMBER_KEYS` is the union of the three WRITE classes of the member
 * classification (`src/backend/member-classes.ts`) — graph-entity writes,
 * their sidecars, and backend-owned bulk ingestion. It is re-exported here,
 * store-side, rather than consumed straight from the classification so this
 * module can carry the pin that ties the entity-write class to the
 * recorded-capture checklist: the capture overlay must wrap exactly the
 * members the pipeline calls graph-entity writes, or one of the two lists is
 * lying about the same surface.
 *
 * The `eslint/write-pipeline-inventory.mjs` mirror of these names is asserted
 * equal to this list by `write-pipeline-ratchet.test.ts`. Neither side is
 * hand-copied from the other: this one is derived from the type, the ESLint
 * one is data the flat config can import, and the ratchet fails on drift in
 * either direction.
 */
import {
  BULK_WRITE_MEMBERS,
  ENTITY_WRITE_MEMBERS,
  SIDECAR_WRITE_MEMBERS,
} from "../../backend/member-classes";
import { type Assert, type Equal } from "../../utils/type-assert";
import {
  type RECORDED_OPTIONAL_WRITE_METHODS,
  type RECORDED_REQUIRED_WRITE_METHODS,
} from "../recorded-capture/write-surface";

export const WRITE_MEMBER_KEYS = [
  ...ENTITY_WRITE_MEMBERS,
  ...SIDECAR_WRITE_MEMBERS,
  ...BULK_WRITE_MEMBERS,
] as const;

export type WriteMemberKey = (typeof WRITE_MEMBER_KEYS)[number];

// ONE OWNER for "what is a graph-entity write". The recorded-capture factories
// wrap the members on their checklist; the write pipeline bans the members in
// its entity-write class. If those two sets ever differ, one of them is
// wrapping (or banning) a surface the other does not recognise — so they are
// the same names or the build fails.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _entityWritesMatchCaptureChecklist = Assert<
  Equal<
    (typeof ENTITY_WRITE_MEMBERS)[number],
    | (typeof RECORDED_REQUIRED_WRITE_METHODS)[number]
    | (typeof RECORDED_OPTIONAL_WRITE_METHODS)[number]
  >
>;
