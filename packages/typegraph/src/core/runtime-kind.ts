import { type z } from "zod";

import { RuntimeKindTokenError } from "../errors";
import { type EdgeType, type KindEntity, type NodeType } from "./types";

declare const RUNTIME_KIND_TOKEN_BRAND: unique symbol;

/** The schema identity a runtime-kind token is licensed against. */
export type RuntimeKindSchemaBinding = Readonly<{
  graphId: string;
  schemaVersion: number | undefined;
  schemaHash: string | undefined;
}>;

/** Store-issued evidence for one persisted runtime node kind. */
export type RuntimeNodeKind<
  K extends string = string,
  S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> = Readonly<{
  entity: "node";
  kind: K;
  [RUNTIME_KIND_TOKEN_BRAND]: S;
}>;

/** Store-issued evidence for one persisted runtime edge kind. */
export type RuntimeEdgeKind<
  K extends string = string,
  S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> = Readonly<{
  entity: "edge";
  kind: K;
  [RUNTIME_KIND_TOKEN_BRAND]: S;
}>;

/** Node type recovered from validated runtime-kind evidence. */
export type RuntimeNodeTypeFor<T extends RuntimeNodeKind> =
  T extends RuntimeNodeKind<infer K, infer S> ? NodeType<K, S> : never;

/** Edge type recovered from validated runtime-kind evidence. */
export type RuntimeEdgeTypeFor<T extends RuntimeEdgeKind> =
  T extends RuntimeEdgeKind<infer K, infer S> ?
    EdgeType<
      K,
      S,
      readonly NodeType[] | undefined,
      readonly NodeType[] | undefined
    >
  : never;

type RuntimeKindToken = RuntimeNodeKind | RuntimeEdgeKind;

export type RuntimeKindInput = string | RuntimeKindToken;
export type RuntimeKindTokenResolver = (
  token: unknown,
  entity: KindEntity,
) => string;

type RuntimeKindTokenMetadata = Readonly<{
  owner: object;
  binding: RuntimeKindSchemaBinding;
  entity: KindEntity;
  kind: string;
}>;

const TOKEN_METADATA = new WeakMap<object, RuntimeKindTokenMetadata>();

export function createRuntimeKindToken<
  const K extends string,
  S extends z.ZodObject<z.ZodRawShape>,
>(
  owner: object,
  binding: RuntimeKindSchemaBinding,
  entity: "node",
  kind: K,
): RuntimeNodeKind<K, S>;
export function createRuntimeKindToken<
  const K extends string,
  S extends z.ZodObject<z.ZodRawShape>,
>(
  owner: object,
  binding: RuntimeKindSchemaBinding,
  entity: "edge",
  kind: K,
): RuntimeEdgeKind<K, S>;
export function createRuntimeKindToken(
  owner: object,
  binding: RuntimeKindSchemaBinding,
  entity: KindEntity,
  kind: string,
): RuntimeKindToken {
  const token = Object.freeze({ entity, kind }) as RuntimeKindToken;
  TOKEN_METADATA.set(token, { owner, binding, entity, kind });
  return token;
}

/** Resolves Store-issued evidence after checking its owner and schema fence. */
export function resolveRuntimeKindToken(
  token: unknown,
  expectedEntity: KindEntity,
  owner: object | undefined,
  binding: RuntimeKindSchemaBinding | undefined,
): string {
  const tokenObject =
    typeof token === "object" && token !== null ? token : undefined;
  const metadata =
    tokenObject === undefined ? undefined : TOKEN_METADATA.get(tokenObject);
  if (tokenObject === undefined || metadata === undefined) {
    throw new RuntimeKindTokenError("invalid", expectedEntity);
  }
  if (metadata.entity !== expectedEntity) {
    throw new RuntimeKindTokenError("wrong-entity", expectedEntity, {
      actualEntity: metadata.entity,
      kind: metadata.kind,
    });
  }
  if (
    !("kind" in tokenObject) ||
    typeof tokenObject.kind !== "string" ||
    tokenObject.kind !== metadata.kind
  ) {
    throw new RuntimeKindTokenError("wrong-kind", expectedEntity, {
      kind: metadata.kind,
    });
  }
  if (owner === undefined || metadata.owner !== owner) {
    throw new RuntimeKindTokenError("wrong-store", expectedEntity, {
      kind: metadata.kind,
      graphId: metadata.binding.graphId,
    });
  }
  const bindingMatches =
    binding?.graphId === metadata.binding.graphId &&
    binding.schemaVersion === metadata.binding.schemaVersion &&
    binding.schemaHash === metadata.binding.schemaHash;
  if (!bindingMatches) {
    throw new RuntimeKindTokenError("stale", expectedEntity, {
      kind: metadata.kind,
      graphId: metadata.binding.graphId,
      tokenSchemaVersion: metadata.binding.schemaVersion,
      currentSchemaVersion: binding?.schemaVersion,
      tokenSchemaHash: metadata.binding.schemaHash,
      currentSchemaHash: binding?.schemaHash,
    });
  }
  return metadata.kind;
}

/** One owner for string-or-token dispatch across every dynamic API. */
export function resolveRuntimeKindInput(
  input: RuntimeKindInput,
  entity: KindEntity,
  resolver: RuntimeKindTokenResolver | undefined,
): string {
  if (typeof input === "string") return input;
  if (resolver === undefined) {
    return resolveRuntimeKindToken(input, entity, undefined, undefined);
  }
  return resolver(input, entity);
}
