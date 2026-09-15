import { type JsonPointer } from "../query/json-pointer";
import type { NODE_INDEX_KEY_DIRECTIONS } from "./types";
import {
  type IndexScope,
  NODE_SYSTEM_COLUMN_NAMES,
  type NodeIndexKey,
  type SystemColumnName,
} from "./types";

export function parseNodeIndexKeyDirection(
  value: unknown,
): (typeof NODE_INDEX_KEY_DIRECTIONS)[number] | undefined {
  return value === "asc" || value === "desc" ? value : undefined;
}

export function validateEdgeIndexKeysPresence(
  value: object,
): string | undefined {
  return Object.hasOwn(value, "keys") ?
      "Edge indexes do not support keys"
    : undefined;
}

const NODE_SYSTEM_COLUMNS: ReadonlySet<SystemColumnName> = new Set(
  NODE_SYSTEM_COLUMN_NAMES,
);

export type NodeIndexKeyContract = Readonly<{
  keys: readonly NodeIndexKey[];
  fields: readonly JsonPointer[];
  coveringFields: readonly JsonPointer[];
  keySystemColumns: readonly SystemColumnName[] | undefined;
  unique: boolean;
  scope: IndexScope;
  method?: unknown;
  fieldsDeclared?: boolean;
}>;

export function getNodeScopeColumns(
  scope: IndexScope,
): readonly SystemColumnName[] {
  switch (scope) {
    case "graphAndKind": {
      return ["graph_id", "kind"];
    }
    case "graph": {
      return ["graph_id"];
    }
    case "none": {
      return [];
    }
  }
}

export function validateNodeIndexKeyContract(
  contract: NodeIndexKeyContract,
): readonly string[] {
  if (contract.keys.length === 0) return ["Node index keys must not be empty"];
  const errors: string[] = [];
  if (
    (contract.fieldsDeclared ?? contract.fields.length > 0) ||
    contract.keySystemColumns !== undefined
  ) {
    errors.push(
      "Node index keys are mutually exclusive with fields and keySystemColumns",
    );
  }
  if (contract.unique)
    errors.push("Node index keys do not support unique indexes");
  if (contract.method !== undefined && contract.method !== "btree") {
    errors.push('Node index keys support only method: "btree"');
  }
  const scopeColumns = new Set(getNodeScopeColumns(contract.scope));
  const seen = new Set<string>();
  for (const key of contract.keys) {
    const identity = key.type === "field" ? key.pointer : key.column;
    const fingerprint = `${key.type}:${identity}`;
    if (seen.has(fingerprint))
      errors.push(`Node index keys must not repeat "${identity}"`);
    seen.add(fingerprint);
    if (key.type === "system") {
      if (!NODE_SYSTEM_COLUMNS.has(key.column)) {
        errors.push(
          `Node index keys do not support system column "${key.column}"`,
        );
      }
      if (scopeColumns.has(key.column)) {
        errors.push(
          `Node index keys must not repeat a column already implied by scope "${contract.scope}": "${key.column}"`,
        );
      }
    } else if (contract.coveringFields.includes(key.pointer)) {
      errors.push(
        `Index keys and coveringFields must not overlap: "${key.pointer}"`,
      );
    }
  }
  return errors;
}
