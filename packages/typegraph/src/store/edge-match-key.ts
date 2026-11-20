/**
 * Canonical identity keys for edge endpoint matching.
 *
 * The key deliberately contains the complete directed endpoint tuple and every
 * declared match field. It is an injective JSON array encoding, not a hash, so
 * callers can use it as the durable owner key without accepting collisions.
 */
import type { EdgeMatchIdentityStorage } from "../backend/types";
import { isPortableEdgeMatchIdentityValue } from "../core/edge-match-identity-value";
import type { EdgeMatchIdentity } from "../core/types";
import { ConfigurationError, ValidationError } from "../errors";
import { createDataKeyedBag, readOwnProperty } from "../utils/object";
import { encodeTupleKey } from "../utils/tuple-key";

const ABSENT_PERSISTED_JSON_VALUE = "\u001D";
const MAX_EDGE_MATCH_IDENTITY_INDEX_BYTES = 2000;
const TEXT_ENCODER = new TextEncoder();

function normalizeEdgeMatchIdentityProps(
  props: Readonly<Record<string, unknown>>,
  identity: EdgeMatchIdentity,
  scope: Readonly<{ graphId: string; edgeKind: string }>,
): Record<string, unknown> {
  const identityProps = createDataKeyedBag<unknown>();
  for (const field of identity.fields) {
    identityProps[field] = readOwnProperty(props, field);
  }
  try {
    return normalizePersistedEdgeMatchProps(identityProps);
  } catch (error) {
    throw new ConfigurationError(
      `Edge match identity "${identity.name}" contains a value that cannot be persisted as JSON.`,
      {
        code: "EDGE_MATCH_IDENTITY_VALUE_NOT_SCALAR",
        graphId: scope.graphId,
        edgeKind: scope.edgeKind,
        identityName: identity.name,
        fields: identity.fields,
      },
      {
        cause: error,
        suggestion:
          "Use absent, null, string, finite-number, or boolean values for durable identity fields and properties.",
      },
    );
  }
}

export type EdgeMatchKeyInput = Readonly<{
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  props: Readonly<Record<string, unknown>>;
  matchOn: readonly string[];
}>;

/** Returns the property bag as JSON persistence will retain it. */
export function normalizePersistedEdgeMatchProps(
  props: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  try {
    // eslint-disable-next-line unicorn/prefer-structured-clone -- intentionally applies JSON persistence semantics
    return JSON.parse(JSON.stringify(props)) as Record<string, unknown>;
  } catch (error) {
    throw new ValidationError(
      "Edge properties used for endpoint matching must be persistable JSON.",
      {
        operation: "create",
        issues: [
          {
            path: "properties",
            message:
              "Use JSON-compatible values; BigInt and other non-JSON values cannot be matched or persisted.",
          },
        ],
      },
      { cause: error },
    );
  }
}

/** Canonical representation of one persisted JSON value. */
export function canonicalPersistedJsonValue(value: unknown): string {
  if (value === undefined) return ABSENT_PERSISTED_JSON_VALUE;
  // eslint-disable-next-line unicorn/prefer-structured-clone -- intentionally applies JSON persistence semantics
  return canonicalizeJsonValue(JSON.parse(JSON.stringify(value)));
}

function canonicalizeJsonValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJsonValue(item)).join(",")}]`;
  }
  const entries = Object.keys(value)
    .toSorted()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalizeJsonValue(
          (value as Record<string, unknown>)[key],
        )}`,
    );
  return `{${entries.join(",")}}`;
}

/** Creates the canonical owner key for a directed edge match identity. */
function buildEdgeMatchKeyFromPersistedProps(
  input: EdgeMatchKeyInput,
  persistedProps: Readonly<Record<string, unknown>>,
): string {
  const fields = [...new Set(input.matchOn)].toSorted();
  return encodeTupleKey([
    input.fromKind,
    input.fromId,
    input.toKind,
    input.toId,
    ...fields.flatMap((field) => [
      field,
      canonicalPersistedJsonValue(readOwnProperty(persistedProps, field)),
    ]),
  ]);
}

/** Creates the canonical owner key for a directed edge match identity. */
export function buildEdgeMatchKey(input: EdgeMatchKeyInput): string {
  return buildEdgeMatchKeyFromPersistedProps(
    input,
    normalizePersistedEdgeMatchProps(input.props),
  );
}

/** Resolves the persisted identity pair every edge writer must apply. */
export function resolveEdgeMatchIdentityStorage(
  identity: EdgeMatchIdentity | undefined,
  input: Omit<EdgeMatchKeyInput, "matchOn">,
  scope: Readonly<{ graphId: string; edgeKind: string }>,
): EdgeMatchIdentityStorage | undefined {
  if (identity === undefined) return undefined;
  const nonScalarFields = identity.fields.filter(
    (field) =>
      !isPortableEdgeMatchIdentityValue(readOwnProperty(input.props, field)),
  );
  if (nonScalarFields.length > 0) {
    throw new ConfigurationError(
      `Edge match identity "${identity.name}" must use JSON scalar fields.`,
      {
        code: "EDGE_MATCH_IDENTITY_VALUE_NOT_SCALAR",
        graphId: scope.graphId,
        edgeKind: scope.edgeKind,
        identityName: identity.name,
        fields: nonScalarFields,
      },
      {
        suggestion:
          "Use absent, null, string, finite-number, or boolean values for durable identity fields.",
      },
    );
  }
  const persistedProps = normalizeEdgeMatchIdentityProps(
    input.props,
    identity,
    scope,
  );
  const key = buildEdgeMatchKeyFromPersistedProps(
    {
      ...input,
      matchOn: identity.fields,
    },
    persistedProps,
  );
  // PostgreSQL's btree tuple limit is lower than the unbounded TEXT type used
  // by both adapters. Apply one backend-independent budget to the complete
  // unique tuple so SQLite cannot accept an identity a PostgreSQL store would
  // later refuse with SQLSTATE 54000.
  const indexTuple = encodeTupleKey([
    scope.graphId,
    scope.edgeKind,
    identity.name,
    key,
  ]);
  const indexBytes = TEXT_ENCODER.encode(indexTuple).byteLength;
  if (indexBytes > MAX_EDGE_MATCH_IDENTITY_INDEX_BYTES) {
    throw new ConfigurationError(
      `Edge match identity "${identity.name}" for kind "${scope.edgeKind}" exceeds the portable storage limit.`,
      {
        code: "EDGE_MATCH_IDENTITY_KEY_TOO_LARGE",
        graphId: scope.graphId,
        edgeKind: scope.edgeKind,
        identityName: identity.name,
        indexBytes,
        maxIndexBytes: MAX_EDGE_MATCH_IDENTITY_INDEX_BYTES,
      },
      {
        suggestion:
          "Declare smaller primitive identity fields instead of embedding large values in a durable edge identity.",
      },
    );
  }
  return {
    name: identity.name,
    key,
  };
}

/**
 * Decides whether an edge props update would rewrite its durable identity.
 *
 * Every update entry point consumes this decision instead of re-spelling the
 * persisted-JSON comparison. The returned error is also the shared refusal,
 * allowing collection writes to throw it while interchange records it against
 * one imported row.
 */
export function edgeMatchIdentityUpdateRefusal(
  input: Readonly<{
    identity: EdgeMatchIdentity | undefined;
    kind: string;
    id: string;
    beforeProps: Readonly<Record<string, unknown>>;
    afterProps: Readonly<Record<string, unknown>>;
  }>,
): ValidationError | undefined {
  const changedFields =
    input.identity?.fields.filter(
      (field) =>
        canonicalPersistedJsonValue(
          readOwnProperty(input.beforeProps, field),
        ) !==
        canonicalPersistedJsonValue(readOwnProperty(input.afterProps, field)),
    ) ?? [];
  if (changedFields.length === 0) return undefined;

  return new ValidationError(
    `Edge kind "${input.kind}" match identity fields are immutable: ${changedFields.join(", ")}`,
    {
      kind: input.kind,
      operation: "update",
      id: input.id,
      issues: changedFields.map((field) => ({
        path: field,
        message: `Field "${field}" belongs to match identity "${input.identity?.name ?? "unknown"}" and cannot be updated`,
      })),
    },
  );
}
