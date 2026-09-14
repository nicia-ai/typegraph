import { describe, expect, expectTypeOf, it } from "vitest";

import { ConfigurationError, expr } from "../src";
import {
  type PreparedBindings,
  validatePreparedBindingsDeclaration,
} from "../src/query/builder/prepared-bindings";
import {
  collectParameterMetadata,
  validateQueryBindings,
} from "../src/query/builder/prepared-query";

describe("composed prepared bindings", () => {
  it("retains declared names and value types", () => {
    const parameters = {
      minimum: expr.param("minimum", "number"),
      name: expr.param("name", "string"),
    };
    expectTypeOf<PreparedBindings<typeof parameters>>().toEqualTypeOf<
      Readonly<{ minimum: number; name: string }>
    >();
    expect(() => {
      validatePreparedBindingsDeclaration(
        parameters,
        [],
        Object.values(parameters),
      );
    }).not.toThrow();
    expect(() => {
      validateQueryBindings(
        [],
        { minimum: 3, name: "Ada" },
        Object.values(parameters),
      );
    }).not.toThrow();
  });

  it("rejects conflicting parameter types across separate expressions", () => {
    expect(() =>
      collectParameterMetadata(
        [],
        [expr.param("value", "string"), expr.param("value", "number")],
      ),
    ).toThrow(ConfigurationError);
  });

  it("refuses missing, extra, mistyped and renamed declarations", () => {
    const parameter = expr.param("minimum", "number");
    const parameters = [parameter];
    expect(() => {
      validatePreparedBindingsDeclaration({}, [], parameters);
    }).toThrow(ConfigurationError);
    expect(() => {
      validatePreparedBindingsDeclaration(
        { minimum: parameter, extra: expr.param("extra", "number") },
        [],
        parameters,
      );
    }).toThrow(ConfigurationError);
    expect(() => {
      validatePreparedBindingsDeclaration(
        { minimum: expr.param("minimum", "string") },
        [],
        parameters,
      );
    }).toThrow(ConfigurationError);
    expect(() => {
      validatePreparedBindingsDeclaration(
        { minimum: expr.param("other", "number") },
        [],
        parameters,
      );
    }).toThrow(ConfigurationError);
    expect(() => {
      validatePreparedBindingsDeclaration(
        { minimum: expr.literal(2) },
        [],
        parameters,
      );
    }).toThrow(ConfigurationError);
  });

  it("validates bindings against the complete expression inventory", () => {
    const expressions = [
      expr.param("minimum", "number"),
      expr.param("name", "string"),
    ];
    expect(() => {
      validateQueryBindings([], { minimum: 2 }, expressions);
    }).toThrow(/Missing bindings/);
    expect(() => {
      validateQueryBindings(
        [],
        { minimum: 2, name: "Ada", extra: 1 },
        expressions,
      );
    }).toThrow(/Unexpected bindings/);
    expect(() => {
      validateQueryBindings([], { minimum: "2", name: "Ada" }, expressions);
    }).toThrow(/must be a number/);
    expect(() => {
      validateQueryBindings(
        [],
        { minimum: Number.NaN, name: "Ada" },
        expressions,
      );
    }).toThrow();
  });
});
