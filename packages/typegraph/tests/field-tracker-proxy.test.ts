/**
 * Tests for field tracking proxy edge cases.
 *
 * Focuses on Promise compatibility, symbol handling, and Object prototype
 * property handling that enables the tracking proxies to work correctly
 * in async contexts and with common JavaScript patterns.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineNode } from "../src";
import { type QueryBuilderState } from "../src/query/builder/types";
import {
  createTrackingContext,
  FieldAccessTracker,
  type TrackingContextOptions,
} from "../src/query/execution/field-tracker";
import { createSchemaIntrospector } from "../src/query/schema-introspector";

// ============================================================
// Test Types
// ============================================================

/**
 * Type for the tracking proxy in tests - allows accessing any property.
 */
type TestProxy = Record<string | symbol, unknown>;

// ============================================================
// Test Setup
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().optional(),
  }),
});

const schemaIntrospector = createSchemaIntrospector(
  new Map([["Person", { schema: Person.schema }]]),
  new Map(),
);

function createTestState(): QueryBuilderState {
  return {
    startKinds: ["Person"],
    startAlias: "p",
    currentAlias: "p",
    includeSubClasses: false,
    traversals: [],
    predicates: [],
    projection: [],
    orderBy: [],
    limit: undefined,
    offset: undefined,
    temporalMode: "current",
    asOf: undefined,
    groupBy: undefined,
    having: undefined,
  };
}

function createTestOptions(
  mode: "falsy" | "truthy" | "max" = "truthy",
): TrackingContextOptions {
  return {
    schemaIntrospector,
    mode,
    optionalTraversalAliases: "present",
  };
}

/**
 * Create a tracking context with typed access to aliases.
 */
function createTypedContext(
  state: QueryBuilderState,
  tracker: FieldAccessTracker,
  options: TrackingContextOptions,
): { p: TestProxy } & Record<string, TestProxy> {
  return createTrackingContext(state, tracker, options) as {
    p: TestProxy;
  } & Record<string, TestProxy>;
}

// ============================================================
// Promise Compatibility Tests
// ============================================================

describe("Promise compatibility", () => {
  it("returns undefined for 'then' property to avoid Promise detection", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    // When a proxy returns undefined for 'then', it won't be treated as a thenable
    expect(context.p.then).toBeUndefined();
  });

  it("does not record 'then' access as a field", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    // Access 'then' - this should not be recorded
    void context.p.then;

    const fields = tracker.getAccessedFields();
    const thenField = fields.find((f) => f.field === "then");
    expect(thenField).toBeUndefined();
  });

  it("allows proxy to be awaited without becoming a Promise", async () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    // This should not throw or hang - proxy is not a thenable
    const result = await Promise.resolve(context.p);

    // The proxy itself is returned (not awaited as a Promise)
    expect(result).toBeDefined();
  });

  it("works correctly in select functions", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    // Simulate an async select callback
    const asyncSelect = () => {
      return {
        name: context.p.name,
        id: context.p.id,
      };
    };

    const result = asyncSelect();

    expect(result.name).toBeDefined();
    expect(result.id).toBeDefined();

    const fields = tracker.getAccessedFields();
    expect(fields).toContainEqual({
      alias: "p",
      field: "name",
      isSystemField: false,
    });
    expect(fields).toContainEqual({
      alias: "p",
      field: "id",
      isSystemField: true,
    });
  });
});

// ============================================================
// JSON Serialization Compatibility
// ============================================================

describe("JSON serialization compatibility", () => {
  it("returns undefined for 'toJSON' property", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    expect(context.p.toJSON).toBeUndefined();
  });

  it("does not record 'toJSON' access as a field", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    void context.p.toJSON;

    const fields = tracker.getAccessedFields();
    const toJsonField = fields.find((f) => f.field === "toJSON");
    expect(toJsonField).toBeUndefined();
  });
});

// ============================================================
// Symbol Handling
// ============================================================

describe("symbol property handling", () => {
  it("returns undefined for symbol properties", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    const customSymbol = Symbol("custom");
    expect(context.p[customSymbol]).toBeUndefined();
  });

  it("returns undefined for well-known symbols", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    expect(context.p[Symbol.iterator]).toBeUndefined();
    expect(context.p[Symbol.toStringTag]).toBeUndefined();
  });

  it("does not record symbol access", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    void context.p[Symbol("test")];
    void context.p[Symbol.iterator];

    const fields = tracker.getAccessedFields();
    expect(fields).toHaveLength(0);
  });
});

// ============================================================
// Object Prototype Property Handling
// ============================================================

describe("Object prototype property handling", () => {
  it("returns Object for 'constructor' property", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    expect(context.p.constructor).toBe(Object);
  });

  it("returns Object.prototype for '__proto__' property", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    expect(context.p.__proto__).toBe(Object.prototype);
  });

  it("returns correct value for 'hasOwnProperty'", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    // Should return the actual hasOwnProperty function from Object.prototype
    expect(typeof context.p.hasOwnProperty).toBe("function");
  });

  it("returns correct value for 'toString'", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    expect(typeof context.p.toString).toBe("function");
  });

  it("does not record Object prototype property access", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    void context.p.constructor;
    void context.p.__proto__;
    void context.p.hasOwnProperty;
    void context.p.toString;

    const fields = tracker.getAccessedFields();
    expect(fields).toHaveLength(0);
  });
});

// ============================================================
// System Field Handling
// ============================================================

describe("system field tracking", () => {
  it("records 'id' as a system field", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    void context.p.id;

    const fields = tracker.getAccessedFields();
    expect(fields).toContainEqual({
      alias: "p",
      field: "id",
      isSystemField: true,
    });
  });

  it("records 'kind' as a system field", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    void context.p.kind;

    const fields = tracker.getAccessedFields();
    expect(fields).toContainEqual({
      alias: "p",
      field: "kind",
      isSystemField: true,
    });
  });

  it("returns placeholder values for system fields based on mode", () => {
    const falsyTracker = new FieldAccessTracker();
    const falsyContext = createTypedContext(
      createTestState(),
      falsyTracker,
      createTestOptions("falsy"),
    );

    const truthyTracker = new FieldAccessTracker();
    const truthyContext = createTypedContext(
      createTestState(),
      truthyTracker,
      createTestOptions("truthy"),
    );

    // Falsy mode returns empty string
    expect(falsyContext.p.id).toBe("");

    // Truthy mode returns non-empty string
    expect(truthyContext.p.id).toBe("x");
  });
});

// ============================================================
// Meta Field Handling
// ============================================================

describe("meta field tracking", () => {
  it("records all meta fields when 'meta' is accessed", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    void context.p.meta;

    const fields = tracker.getAccessedFields();
    const metaFields = fields.filter((f) => f.field.startsWith("meta."));

    // Should include version, validFrom, validTo, createdAt, updatedAt, deletedAt
    expect(metaFields.length).toBeGreaterThanOrEqual(6);
    expect(metaFields.every((f) => f.isSystemField)).toBe(true);
  });

  it("returns meta placeholder object with correct structure", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    const meta = context.p.meta;

    expect(meta).toHaveProperty("version");
    expect(meta).toHaveProperty("createdAt");
    expect(meta).toHaveProperty("updatedAt");
    expect(meta).toHaveProperty("validFrom");
    expect(meta).toHaveProperty("validTo");
    expect(meta).toHaveProperty("deletedAt");
  });
});

// ============================================================
// User Field Handling
// ============================================================

describe("user field tracking", () => {
  it("records user-defined fields as non-system fields", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    void context.p.name;
    void context.p.email;

    const fields = tracker.getAccessedFields();
    expect(fields).toContainEqual({
      alias: "p",
      field: "name",
      isSystemField: false,
    });
    expect(fields).toContainEqual({
      alias: "p",
      field: "email",
      isSystemField: false,
    });
  });

  it("returns type-appropriate placeholders for user fields", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(
      state,
      tracker,
      createTestOptions("truthy"),
    );

    // String field should return truthy string placeholder
    expect(typeof context.p.name).toBe("string");
    expect(context.p.name).toBeTruthy();
  });
});

// ============================================================
// Deduplication
// ============================================================

describe("field access deduplication", () => {
  it("records each field only once even when accessed multiple times", () => {
    const tracker = new FieldAccessTracker();
    const state = createTestState();
    const context = createTypedContext(state, tracker, createTestOptions());

    // Access same field multiple times
    void context.p.name;
    void context.p.name;
    void context.p.name;

    const fields = tracker.getAccessedFields();
    const nameFields = fields.filter((f) => f.field === "name");
    expect(nameFields).toHaveLength(1);
  });
});
