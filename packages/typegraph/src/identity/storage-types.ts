import { type IdentityRelation } from "./types";

export type IdentityAssertionStorageRow = Readonly<{
  graph_id: string;
  id: string;
  rel: IdentityRelation;
  a_kind: string;
  a_id: string;
  b_kind: string;
  b_id: string;
  valid_from: string;
  valid_to: string | undefined;
  created_at: string;
  updated_at: string;
  deleted_at: string | undefined;
  /**
   * The node whose soft-delete cascade ended this assertion, or `undefined`
   * when the ending was an explicit retraction (and on every open row). Always
   * one of this row's own two endpoints — the cascade only ends assertions
   * that touch the deleted node.
   */
  ended_by_kind: string | undefined;
  ended_by_id: string | undefined;
}>;
