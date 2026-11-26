/**
 * A stored date under every transparent wrapper and every kind of check, as a
 * write that re-validates the stored row reads it.
 *
 * An update merges its patch over the stored props and parses the result, so
 * a stored date's text is turned back into a `Date` first
 * (`reviveStoredDates`). A check that rewrites the value on every parse — an
 * `.overwrite()` — would rewrite that untouched date on every update, so a
 * rewrite is refused; but an `.overwrite()` that returns its input unchanged
 * rewrites nothing, and an update to an unrelated field of such a row must
 * succeed as it does for a plain date. Each kind here differs from the others
 * in one wrapper and one check, and each case states the outcome per write
 * path: an update of an unrelated field, a set update of one, `validateStore`
 * over the row, and an export/import round trip.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, type NodeType } from "../../../src";
import { exportGraph, importGraph } from "../../../src/interchange";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const STATED = new Date("2024-01-02T03:04:05.678Z");
const FALLBACK = new Date("1999-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

function shifted(date: Date): Date {
  return new Date(date.getTime() + DAY_MS);
}

/** A value an `.overwrite()` on a wrapper sees: the date, or the wrapper's empty value. */
function shiftIfDate<T>(value: T): T {
  return (value instanceof Date ? shifted(value) : value) as T;
}

type DateSchema = z.ZodType<Date | null | undefined, Date | null | undefined>;

/** Where a check sits, and what it does. */
const CHECKS = {
  none: { onDate: (date: z.ZodDate) => date, onWrapper: undefined },
  refine: {
    onDate: (date: z.ZodDate) => date.refine(() => true),
    onWrapper: undefined,
  },
  identityOverwriteOnDate: {
    onDate: (date: z.ZodDate) => date.overwrite((value) => value),
    onWrapper: undefined,
  },
  identityOverwriteOnWrapper: {
    onDate: (date: z.ZodDate) => date,
    onWrapper: <T>(value: T): T => value,
  },
  shiftingOverwriteOnDate: {
    onDate: (date: z.ZodDate) => date.overwrite((value) => shifted(value)),
    onWrapper: undefined,
  },
  shiftingOverwriteOnWrapper: {
    onDate: (date: z.ZodDate) => date,
    onWrapper: shiftIfDate,
  },
} as const;

type CheckName = keyof typeof CHECKS;

/** The transparent wrappers a stored date can sit under. */
const WRAPPERS = {
  bare: (date: z.ZodType<Date>) => date,
  optional: (date: z.ZodType<Date>) => date.optional(),
  nullable: (date: z.ZodType<Date>) => date.nullable(),
  default: (date: z.ZodType<Date>) => date.default(FALLBACK),
  prefault: (date: z.ZodType<Date>) => date.prefault(FALLBACK),
  catch: (date: z.ZodType<Date>) => date.catch(FALLBACK),
  readonly: (date: z.ZodType<Date>) => date.readonly(),
  nonoptional: (date: z.ZodType<Date>) => date.optional().nonoptional(),
} as const;

type WrapperName = keyof typeof WRAPPERS;

function dateSchema(wrapper: WrapperName, check: CheckName): DateSchema {
  const { onDate, onWrapper } = CHECKS[check];
  const wrapped = WRAPPERS[wrapper](onDate(z.date())) as unknown as z.ZodType<
    Date | null | undefined
  >;
  return (
    onWrapper === undefined ? wrapped : (
      wrapped.overwrite((value) => onWrapper(value))
    )) as DateSchema;
}

/** A date held by a container whose own `.overwrite()` sees it. */
const CONTAINERS = {
  identityOverwriteOnObject: z
    .object({ at: z.date() })
    .overwrite((value) => value),
  shiftingOverwriteOnObject: z
    .object({ at: z.date() })
    .overwrite((value) => ({ at: shifted(value.at) })),
  identityOverwriteOnArray: z.array(z.date()).overwrite((value) => value),
  shiftingOverwriteOnArray: z
    .array(z.date())
    .overwrite((value) => value.map((date) => shifted(date))),
} as const;

type ContainerName = keyof typeof CONTAINERS;

function containerValue(name: ContainerName): unknown {
  return name.endsWith("Object") ? { at: STATED } : [STATED];
}

type MatrixCase = Readonly<{
  name: string;
  at: z.ZodType;
  /** What a create states for `at`. */
  stated: unknown;
}>;

const CASES: readonly MatrixCase[] = [
  ...Object.keys(WRAPPERS).flatMap((wrapper) =>
    Object.keys(CHECKS)
      // On a bare date a check "on the wrapper" sits on the date itself.
      .filter((check) => wrapper !== "bare" || !check.endsWith("OnWrapper"))
      .map((check) => ({
        name: `${wrapper}_${check}`,
        at: dateSchema(wrapper as WrapperName, check as CheckName),
        stated: STATED,
      })),
  ),
  ...Object.keys(CONTAINERS).map((container) => ({
    name: container,
    at: CONTAINERS[container as ContainerName],
    stated: containerValue(container as ContainerName),
  })),
];

function kindName(name: string): string {
  return `OverwriteMatrix_${name}`;
}

const NODE_TYPES: Readonly<Record<string, NodeType>> = Object.fromEntries(
  CASES.map((matrixCase) => [
    kindName(matrixCase.name),
    defineNode(kindName(matrixCase.name), {
      schema: z.object({ title: z.string(), at: matrixCase.at }),
    }),
  ]),
);

function buildMatrixGraph(id: string) {
  return defineGraph({
    id,
    nodes: Object.fromEntries(
      Object.entries(NODE_TYPES).map(([name, type]) => [name, { type }]),
    ),
    edges: {},
  });
}

/**
 * One write path's outcome, as a code: `K` kept the stored date, `R` refused
 * the write, `F` stored the `.catch()` fallback over it, `FS` stored the
 * fallback shifted, `S` stored the date shifted again.
 */
type OutcomeCode = "K" | "R" | "F" | "FS" | "S";

/** `update  updateWhere  validateStore-violations  import`, one code each. */
type CaseCodes = `${OutcomeCode} ${OutcomeCode} ${number} ${OutcomeCode}`;

/**
 * What main observed for each case before this change, recorded by running
 * this matrix against main's source. Every `K` here is a write main completed
 * without changing the stored date, and must stay `K` (`no case regresses`
 * below). The rest are each a defect: an identity `.overwrite()` on the date
 * or on an object or array holding it refused every update and was reported
 * by `validateStore`; under a `.catch()` the refused stored text was replaced
 * by the fallback (`F`); a shifting `.overwrite()` on a wrapper rewrote the
 * untouched date on every update (`S`); and import refused every date (`R`)
 * or stored the fallback.
 */
const MAIN_OBSERVED: Readonly<Record<string, CaseCodes>> = {
  bare_none: "K K 0 R",
  bare_refine: "K K 0 R",
  bare_identityOverwriteOnDate: "R R 1 R",
  bare_shiftingOverwriteOnDate: "R R 1 R",
  optional_none: "K K 0 R",
  optional_refine: "K K 0 R",
  optional_identityOverwriteOnDate: "R R 1 R",
  optional_identityOverwriteOnWrapper: "K K 0 R",
  optional_shiftingOverwriteOnDate: "R R 1 R",
  optional_shiftingOverwriteOnWrapper: "S R 0 R",
  nullable_none: "K K 0 R",
  nullable_refine: "K K 0 R",
  nullable_identityOverwriteOnDate: "R R 1 R",
  nullable_identityOverwriteOnWrapper: "K K 0 R",
  nullable_shiftingOverwriteOnDate: "R R 1 R",
  nullable_shiftingOverwriteOnWrapper: "S R 0 R",
  default_none: "K K 0 R",
  default_refine: "K K 0 R",
  default_identityOverwriteOnDate: "R R 1 R",
  default_identityOverwriteOnWrapper: "K K 0 R",
  default_shiftingOverwriteOnDate: "R R 1 R",
  default_shiftingOverwriteOnWrapper: "S R 0 R",
  prefault_none: "K K 0 R",
  prefault_refine: "K K 0 R",
  prefault_identityOverwriteOnDate: "R R 1 R",
  prefault_identityOverwriteOnWrapper: "K K 0 R",
  prefault_shiftingOverwriteOnDate: "R R 1 R",
  prefault_shiftingOverwriteOnWrapper: "S R 0 R",
  catch_none: "K K 0 F",
  catch_refine: "K K 0 F",
  catch_identityOverwriteOnDate: "F F 0 F",
  catch_identityOverwriteOnWrapper: "K K 0 F",
  catch_shiftingOverwriteOnDate: "F F 0 F",
  catch_shiftingOverwriteOnWrapper: "S R 0 FS",
  readonly_none: "K K 0 R",
  readonly_refine: "K K 0 R",
  readonly_identityOverwriteOnDate: "R R 1 R",
  readonly_identityOverwriteOnWrapper: "K K 0 R",
  readonly_shiftingOverwriteOnDate: "R R 1 R",
  readonly_shiftingOverwriteOnWrapper: "S R 0 R",
  nonoptional_none: "K K 0 R",
  nonoptional_refine: "K K 0 R",
  nonoptional_identityOverwriteOnDate: "R R 1 R",
  nonoptional_identityOverwriteOnWrapper: "K K 0 R",
  nonoptional_shiftingOverwriteOnDate: "R R 1 R",
  nonoptional_shiftingOverwriteOnWrapper: "S R 0 R",
  identityOverwriteOnObject: "R R 1 R",
  shiftingOverwriteOnObject: "R R 1 R",
  identityOverwriteOnArray: "R R 1 R",
  shiftingOverwriteOnArray: "R R 1 R",
};

/**
 * The outcome every case must have: a check that keeps the stored date lets
 * every path keep it; one that would rewrite it (a shifting `.overwrite()`
 * anywhere on the way) refuses each write that would re-validate it and the
 * import. Either way the stored row itself parses, so `validateStore`
 * reports nothing.
 */
function expectedCodes(name: string): CaseCodes {
  return name.includes("shifting") ? "R R 0 R" : "K K 0 K";
}

type MatrixCollection = Readonly<{
  create: (props: Record<string, unknown>) => Promise<{ id: string }>;
  update: (id: string, props: Record<string, unknown>) => Promise<unknown>;
  updateWhere: (args: {
    where: (node: { id: { eq: (value: string) => unknown } }) => unknown;
    patch: Record<string, unknown>;
  }) => Promise<unknown>;
  getById: (id: string) => Promise<Record<string, unknown> | undefined>;
  find: () => Promise<readonly Record<string, unknown>[]>;
}>;

function collectionOf(nodes: unknown, name: string): MatrixCollection {
  const collection = (nodes as Readonly<Record<string, MatrixCollection>>)[
    kindName(name)
  ];
  if (collection === undefined) throw new Error(`No collection for ${name}`);
  return collection;
}

/** The code for a stored `at`, relative to what the create stored. */
function storedCode(stored: unknown, created: unknown): OutcomeCode {
  const text = JSON.stringify(stored);
  if (text === JSON.stringify(created)) return "K";
  if (text.includes(FALLBACK.toISOString())) return "F";
  if (text.includes(shifted(FALLBACK).toISOString())) return "FS";
  return "S";
}

async function writeCode(
  write: () => Promise<unknown>,
  read: () => Promise<unknown>,
  created: unknown,
): Promise<OutcomeCode> {
  try {
    await write();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("ValidationError");
    return "R";
  }
  return storedCode(await read(), created);
}

export function registerStoredDateOverwriteMatrixIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a stored date under every wrapper and check", () => {
    it("keeps every stored date a write leaves untouched, or refuses the write", async () => {
      const source = await context.createStore(
        buildMatrixGraph("stored_date_overwrite_matrix"),
      );
      const created: Record<string, unknown> = {};
      const ids: Record<string, string> = {};
      for (const { name, stated } of CASES) {
        const collection = collectionOf(source.nodes, name);
        const node = await collection.create({ title: "a", at: stated });
        ids[name] = node.id;
        const read = await collection.getById(node.id);
        created[name] = read?.["at"];
      }
      const target = await context.createStore(
        buildMatrixGraph("stored_date_overwrite_matrix_import"),
      );
      const imported = await importGraph(target, await exportGraph(source), {
        onConflict: "error",
        onUnknownProperty: "error",
      });

      const observed: Record<string, CaseCodes> = {};
      for (const { name } of CASES) {
        const kind = kindName(name);
        const collection = collectionOf(source.nodes, name);
        const id = ids[name] ?? "";
        const readAt = async () => {
          const read = await collection.getById(id);
          return read?.["at"];
        };
        const update = await writeCode(
          () => collection.update(id, { title: "b" }),
          readAt,
          created[name],
        );
        const updateWhere = await writeCode(
          () =>
            collection.updateWhere({
              where: (node) => node.id.eq(id),
              patch: { title: "c" },
            }),
          readAt,
          created[name],
        );
        const report = await source.validateStore({ entity: "node", kind });
        const refusedImport = imported.errors.some(
          (error) => error.entityType === "node" && error.kind === kind,
        );
        const importedRows = await collectionOf(target.nodes, name).find();
        const importCode =
          refusedImport ? "R" : (
            storedCode(importedRows[0]?.["at"], created[name])
          );
        observed[name] =
          `${update} ${updateWhere} ${report.violations.length} ${importCode}`;
      }

      expect(observed).toEqual(
        Object.fromEntries(
          CASES.map(({ name }) => [name, expectedCodes(name)]),
        ),
      );
      // No case regresses: every path main completed while keeping the stored
      // date still does.
      const regressions = CASES.flatMap(({ name }) => {
        const main = requireDefined(MAIN_OBSERVED[name]).split(" ");
        const now = requireDefined(observed[name]).split(" ");
        return main.flatMap((code, index) =>
          code === "K" && now[index] !== "K" ? [[name, index, now[index]]] : [],
        );
      });
      expect(regressions).toEqual([]);
    });

    it("an update that states a rewriting date stores what its schema makes of it", async () => {
      const store = await context.createStore(
        buildMatrixGraph("stored_date_overwrite_matrix_restated"),
      );
      const restated = new Date("2025-05-05T00:00:00.000Z");
      for (const { name, stated } of CASES.filter((matrixCase) =>
        matrixCase.name.endsWith("shiftingOverwriteOnWrapper"),
      )) {
        const collection = collectionOf(store.nodes, name);
        const node = await collection.create({ title: "a", at: stated });
        await collection.update(node.id, { title: "b", at: restated });
        const read = await collection.getById(node.id);
        expect([name, read?.["at"]]).toEqual([
          name,
          shifted(restated).toISOString(),
        ]);
      }
    });
  });
}
