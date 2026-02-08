/**
 * Selective Result Mapping for Smart Select Optimization.
 *
 * Converts rows returned from a selective projection query into the
 * SelectContext expected by the select callback, while guarding against
 * missing fields and unsupported "return whole node/edge" selections.
 */

import { type SelectiveField } from "../ast";
import type {
  AliasMap,
  EdgeAliasMap,
  QueryBuilderState,
  SelectContext,
} from "../builder/types";
import {
  type FieldTypeInfo,
  type SchemaIntrospector,
} from "../schema-introspector";
import { decodeSelectedValue, nullToUndefined } from "./value-decoder";

// ============================================================
// Errors
// ============================================================

export class MissingSelectiveFieldError extends Error {
  readonly alias: string;
  readonly field: string;

  constructor(alias: string, field: string) {
    super(`Smart select missing field: ${alias}.${field}`);
    this.alias = alias;
    this.field = field;
  }
}

// ============================================================
// Internal Types
// ============================================================

type AliasKind = "node" | "edge";

type SystemFieldPlan = Readonly<{
  field: string;
  outputName: string;
}>;

type MetaFieldPlan = Readonly<{
  metaKey: string;
  outputName: string;
}>;

type PropsFieldPlan = Readonly<{
  field: string;
  outputName: string;
  typeInfo: FieldTypeInfo | undefined;
}>;

type AliasPlan = Readonly<{
  alias: string;
  kind: AliasKind;
  optional: boolean;
  systemFields: readonly SystemFieldPlan[];
  metaFields: readonly MetaFieldPlan[];
  propsFields: readonly PropsFieldPlan[];
  idOutputName: string | undefined;
  metaOutputNames: ReadonlySet<string>;
  propsOutputNames: ReadonlySet<string>;
  systemOutputNames: ReadonlySet<string>;
}>;

// ============================================================
// Marker for "whole alias object" detection
// ============================================================

const SELECTABLE_ALIAS_MARKER = Symbol("selectable_alias_marker");

type SelectableAliasMarker = Readonly<{
  alias: string;
  kind: AliasKind;
}>;

function isSelectableAliasObject(
  value: unknown,
): value is SelectableAliasMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    SELECTABLE_ALIAS_MARKER in value
  );
}

function containsSelectableAliasObject(value: unknown): boolean {
  const visited = new WeakSet<object>();

  function walk(current: unknown): boolean {
    if (isSelectableAliasObject(current)) return true;

    if (Array.isArray(current)) {
      for (const item of current) {
        if (walk(item)) return true;
      }
      return false;
    }

    if (typeof current !== "object" || current === null) {
      return false;
    }

    if (visited.has(current)) return false;
    visited.add(current);

    for (const value of Object.values(current)) {
      if (walk(value)) return true;
    }
    return false;
  }

  return walk(value);
}

// ============================================================
// Public API
// ============================================================

export function mapSelectiveResults<
  Aliases extends AliasMap,
  EdgeAliases extends EdgeAliasMap,
  R,
>(
  rows: readonly Record<string, unknown>[],
  state: QueryBuilderState,
  selectiveFields: readonly SelectiveField[],
  schemaIntrospector: SchemaIntrospector,
  selectFunction: (context: SelectContext<Aliases, EdgeAliases>) => R,
): readonly R[] {
  const plans = buildAliasPlans(state, selectiveFields, schemaIntrospector);

  return rows.map((row) => {
    const context = buildSelectiveContext<Aliases, EdgeAliases>(row, plans);
    const result = selectFunction(context);

    // Returning whole alias objects is not supported by selective projection.
    // If it happens, fall back to the full fetch path.
    if (containsSelectableAliasObject(result)) {
      throw new MissingSelectiveFieldError(
        state.startAlias,
        "whole node/edge selection",
      );
    }

    return result;
  });
}

// ============================================================
// Plan Construction
// ============================================================

function buildAliasPlans(
  state: QueryBuilderState,
  selectiveFields: readonly SelectiveField[],
  schemaIntrospector: SchemaIntrospector,
): readonly AliasPlan[] {
  const aliasInfo = new Map<
    string,
    Readonly<{
      kind: AliasKind;
      optional: boolean;
      kindNames: readonly string[];
    }>
  >([
    [
      state.startAlias,
      {
        kind: "node",
        optional: false,
        kindNames: state.startKinds,
      },
    ],
  ]);

  for (const traversal of state.traversals) {
    aliasInfo.set(traversal.nodeAlias, {
      kind: "node",
      optional: traversal.optional,
      kindNames: traversal.nodeKinds,
    });
    aliasInfo.set(traversal.edgeAlias, {
      kind: "edge",
      optional: traversal.optional,
      kindNames: traversal.edgeKinds,
    });
  }

  const fieldsByAlias = new Map<string, SelectiveField[]>();
  for (const field of selectiveFields) {
    const existing = fieldsByAlias.get(field.alias) ?? [];
    existing.push(field);
    fieldsByAlias.set(field.alias, existing);
  }

  const plans: AliasPlan[] = [];

  for (const [alias, info] of aliasInfo.entries()) {
    const fields = fieldsByAlias.get(alias) ?? [];

    const systemFields: SystemFieldPlan[] = [];
    const metaFields: MetaFieldPlan[] = [];
    const propsFields: PropsFieldPlan[] = [];

    for (const field of fields) {
      if (field.isSystemField) {
        if (field.field.startsWith("meta.")) {
          metaFields.push({
            metaKey: field.field.slice(5),
            outputName: field.outputName,
          });
        } else {
          systemFields.push({
            field: field.field,
            outputName: field.outputName,
          });
        }
      } else {
        const typeInfo =
          info.kind === "node" ?
            schemaIntrospector.getSharedFieldTypeInfo(
              info.kindNames,
              field.field,
            )
          : schemaIntrospector.getSharedEdgeFieldTypeInfo(
              info.kindNames,
              field.field,
            );

        propsFields.push({
          field: field.field,
          outputName: field.outputName,
          typeInfo,
        });
      }
    }

    const idOutputName =
      systemFields.find((f) => f.field === "id")?.outputName ?? undefined;

    plans.push({
      alias,
      kind: info.kind,
      optional: info.optional,
      systemFields,
      metaFields,
      propsFields,
      idOutputName,
      metaOutputNames: new Set(metaFields.map((f) => f.outputName)),
      propsOutputNames: new Set(propsFields.map((f) => f.outputName)),
      systemOutputNames: new Set(systemFields.map((f) => f.outputName)),
    });
  }

  // Keep plan iteration stable.
  return plans.toSorted((a, b) => a.alias.localeCompare(b.alias));
}

// ============================================================
// Context Building
// ============================================================

function buildSelectiveContext<
  Aliases extends AliasMap,
  EdgeAliases extends EdgeAliasMap,
>(
  row: Record<string, unknown>,
  plans: readonly AliasPlan[],
): SelectContext<Aliases, EdgeAliases> {
  const context: Record<string, unknown> = {};

  for (const plan of plans) {
    const value =
      plan.optional && plan.idOutputName !== undefined ?
        buildOptionalAliasValue(row, plan)
      : buildRequiredAliasValue(row, plan);
    context[plan.alias] = value;
  }

  return context as SelectContext<Aliases, EdgeAliases>;
}

function buildOptionalAliasValue(
  row: Record<string, unknown>,
  plan: AliasPlan,
): unknown {
  const idValue = row[plan.idOutputName!];

  if (idValue === null || idValue === undefined) {
    return undefined;
  }
  return buildRequiredAliasValue(row, plan);
}

function buildRequiredAliasValue(
  row: Record<string, unknown>,
  plan: AliasPlan,
): unknown {
  const base: Record<string, unknown> = {
    [SELECTABLE_ALIAS_MARKER]: {
      alias: plan.alias,
      kind: plan.kind,
    } satisfies SelectableAliasMarker,
  };

  for (const field of plan.systemFields) {
    base[field.field] = nullToUndefined(row[field.outputName]);
  }

  if (plan.metaFields.length > 0) {
    const meta: Record<string, unknown> = {};
    for (const field of plan.metaFields) {
      meta[field.metaKey] = nullToUndefined(row[field.outputName]);
    }
    base.meta = createGuardedProxy(meta, `${plan.alias}.meta`);
  }

  for (const field of plan.propsFields) {
    const decoded = decodeSelectedValue(row[field.outputName], field.typeInfo);
    base[field.field] = decoded;
  }

  return createGuardedProxy(base, plan.alias);
}

function createGuardedProxy(
  target: Record<string, unknown>,
  debugPath: string,
): unknown {
  return new Proxy(target, {
    get: (object, property: string | symbol, receiver) => {
      if (typeof property === "symbol") {
        return Reflect.get(object, property, receiver) as unknown;
      }

      if (property === "then" || property === "toJSON") {
        return;
      }

      if (property in object) {
        return Reflect.get(object, property, receiver);
      }

      if (property in Object.prototype) {
        return Reflect.get(Object.prototype, property, receiver) as unknown;
      }

      throw new MissingSelectiveFieldError(debugPath, property);
    },
  });
}
