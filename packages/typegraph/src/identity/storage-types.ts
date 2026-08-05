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
}>;
