import { describe, expect, it } from "vitest";

import { createSqlSchema } from "../src/query/compiler/schema";
import {
  createRecordedBackend,
  createRecordedTransactionScope,
  RECORDED_OPTIONAL_WRITE_METHODS,
  RECORDED_REQUIRED_WRITE_METHODS,
} from "../src/store/recorded-capture";
import { createTestBackend } from "./test-utils";

type MethodBag = Record<string, unknown>;

// A GraphBackend is structurally a TransactionBackend, so the base backend can
// stand in as the scope's transaction target — the resulting wrapper overrides
// the same methods a real transaction target would.
function buildWrappers(): {
  base: MethodBag;
  autocommit: MethodBag;
  transactional: MethodBag;
} {
  const base = createTestBackend();
  const schema = createSqlSchema(base.tableNames);
  return {
    base,
    autocommit: createRecordedBackend(base, schema),
    transactional: createRecordedTransactionScope(base, schema).backend,
  };
}

// A method is "wrapped" when the factory replaced the spread-through base
// reference with its own capturing override.
function isWrapped(
  wrapper: MethodBag,
  base: MethodBag,
  method: string,
): boolean {
  return (
    typeof wrapper[method] === "function" && wrapper[method] !== base[method]
  );
}

/**
 * Guardrail for the two recorded-capture factories. They enumerate the same
 * write surface in parallel (delegate-then-touch vs. one captured autocommit
 * transaction per call); a method wired into one but not the other silently
 * bypasses recorded-time capture for that write kind. Rather than collapse the
 * two type-checked factories into an unsafe generic dispatch, this asserts they
 * wrap the identical set of write methods, so the drift fails loudly here.
 */
describe("recorded-capture write-surface parity", () => {
  it("wraps every required write method in both capture factories", () => {
    const { base, autocommit, transactional } = buildWrappers();
    for (const method of RECORDED_REQUIRED_WRITE_METHODS) {
      expect(
        isWrapped(autocommit, base, method),
        `autocommit factory must capture-wrap ${method}`,
      ).toBe(true);
      expect(
        isWrapped(transactional, base, method),
        `transaction factory must capture-wrap ${method}`,
      ).toBe(true);
    }
  });

  it("wraps every optional write method the backend provides in both factories", () => {
    const { base, autocommit, transactional } = buildWrappers();
    for (const method of RECORDED_OPTIONAL_WRITE_METHODS) {
      if (typeof base[method] !== "function") continue;
      expect(
        isWrapped(autocommit, base, method),
        `autocommit factory must capture-wrap optional ${method}`,
      ).toBe(true);
      expect(
        isWrapped(transactional, base, method),
        `transaction factory must capture-wrap optional ${method}`,
      ).toBe(true);
    }
  });

  it("keeps read methods callable through both capture factories", () => {
    const { autocommit, transactional } = buildWrappers();
    for (const method of ["getNode", "getEdge", "getNodes", "getEdges"]) {
      expect(typeof autocommit[method], `${method} must pass through`).toBe(
        "function",
      );
      expect(typeof transactional[method], `${method} must pass through`).toBe(
        "function",
      );
    }
  });

  it("wraps the identical write-method set in both factories (no drift)", () => {
    const { base, autocommit, transactional } = buildWrappers();
    const candidates = [
      ...RECORDED_REQUIRED_WRITE_METHODS,
      ...RECORDED_OPTIONAL_WRITE_METHODS,
    ];
    const autocommitWrapped = candidates.filter((method) =>
      isWrapped(autocommit, base, method),
    );
    const transactionalWrapped = candidates.filter((method) =>
      isWrapped(transactional, base, method),
    );
    expect(autocommitWrapped).toEqual(transactionalWrapped);
  });
});
