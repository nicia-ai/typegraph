import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type PredicateExpression } from "../../src/query/ast";
import {
  fieldRef,
  numberField,
  type Predicate,
  stringField,
} from "../../src/query/predicates";

// ============================================================
// Helpers for Predicate Generation
// ============================================================

/**
 * Creates a simple comparison predicate for testing.
 */
function simplePredicate(alias: string, value: number): Predicate {
  const field = fieldRef(alias, ["props", "value"]);
  return numberField(field).eq(value);
}

/**
 * Creates a string predicate for testing.
 */
function stringPredicate(alias: string, value: string): Predicate {
  const field = fieldRef(alias, ["props", "name"]);
  return stringField(field).eq(value);
}

/**
 * Extracts the underlying expression from a predicate.
 */
function expr(p: Predicate): PredicateExpression {
  return p.__expr;
}

// ============================================================
// Property Tests - Basic Predicate Structure
// ============================================================

describe("Predicate Composition Structure", () => {
  describe("AND predicate", () => {
    it("creates correct AST structure", () => {
      const pairArb = fc.tuple(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
      );

      fc.assert(
        fc.property(pairArb, ([a, b]) => {
          const p = simplePredicate("x", a);
          const q = simplePredicate("y", b);
          const result = p.and(q);
          const expression = expr(result);

          expect(expression.__type).toBe("and");
          if (expression.__type !== "and") return;
          expect(expression.predicates).toHaveLength(2);
          expect(expression.predicates[0]).toEqual(expr(p));
          expect(expression.predicates[1]).toEqual(expr(q));
        }),
        { numRuns: 50 },
      );
    });

    it("preserves operand predicates unchanged", () => {
      const p = simplePredicate("a", 1);
      const q = simplePredicate("b", 2);
      const pExprBefore = JSON.stringify(expr(p));
      const qExprBefore = JSON.stringify(expr(q));

      p.and(q);

      expect(JSON.stringify(expr(p))).toBe(pExprBefore);
      expect(JSON.stringify(expr(q))).toBe(qExprBefore);
    });
  });

  describe("OR predicate", () => {
    it("creates correct AST structure", () => {
      const pairArb = fc.tuple(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
      );

      fc.assert(
        fc.property(pairArb, ([a, b]) => {
          const p = simplePredicate("x", a);
          const q = simplePredicate("y", b);
          const result = p.or(q);
          const expression = expr(result);

          expect(expression.__type).toBe("or");
          if (expression.__type !== "or") return;
          expect(expression.predicates).toHaveLength(2);
          expect(expression.predicates[0]).toEqual(expr(p));
          expect(expression.predicates[1]).toEqual(expr(q));
        }),
        { numRuns: 50 },
      );
    });
  });

  describe("NOT predicate", () => {
    it("creates correct AST structure", () => {
      const valueArb = fc.integer({ min: 1, max: 100 });

      fc.assert(
        fc.property(valueArb, (a) => {
          const p = simplePredicate("x", a);
          const result = p.not();
          const expression = expr(result);

          expect(expression.__type).toBe("not");
          if (expression.__type !== "not") return;
          expect(expression.predicate).toEqual(expr(p));
        }),
        { numRuns: 50 },
      );
    });

    it("preserves operand predicate unchanged", () => {
      const p = simplePredicate("a", 42);
      const pExprBefore = JSON.stringify(expr(p));

      p.not();

      expect(JSON.stringify(expr(p))).toBe(pExprBefore);
    });
  });
});

// ============================================================
// Property Tests - Chainability
// ============================================================

describe("Predicate Chainability", () => {
  it("and() returns a new predicate that can be further chained", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);
    const r = simplePredicate("c", 3);

    const pAndQ = p.and(q);
    expect(typeof pAndQ.and).toBe("function");
    expect(typeof pAndQ.or).toBe("function");
    expect(typeof pAndQ.not).toBe("function");

    const chained = pAndQ.and(r);
    expect(expr(chained).__type).toBe("and");
  });

  it("or() returns a new predicate that can be further chained", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);
    const r = simplePredicate("c", 3);

    const pOrQ = p.or(q);
    expect(typeof pOrQ.and).toBe("function");
    expect(typeof pOrQ.or).toBe("function");
    expect(typeof pOrQ.not).toBe("function");

    const chained = pOrQ.or(r);
    expect(expr(chained).__type).toBe("or");
  });

  it("not() returns a new predicate that can be further chained", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);

    const notP = p.not();
    expect(typeof notP.and).toBe("function");
    expect(typeof notP.or).toBe("function");
    expect(typeof notP.not).toBe("function");

    const chained = notP.and(q);
    expect(expr(chained).__type).toBe("and");
  });

  it("supports arbitrary chaining depth", () => {
    const depthArb = fc.integer({ min: 2, max: 10 });

    fc.assert(
      fc.property(depthArb, (depth) => {
        let current = simplePredicate("p0", 0);

        for (let index = 1; index < depth; index++) {
          const next = simplePredicate(`p${index}`, index);
          current = index % 2 === 0 ? current.and(next) : current.or(next);
        }

        // Should still be a valid predicate with chainable methods
        expect(typeof current.and).toBe("function");
        expect(typeof current.or).toBe("function");
        expect(typeof current.not).toBe("function");
      }),
      { numRuns: 20 },
    );
  });
});

// ============================================================
// Property Tests - Double Negation
// ============================================================

describe("Double Negation Structure", () => {
  it("double negation creates nested NOT structure", () => {
    const valueArb = fc.integer({ min: 1, max: 100 });

    fc.assert(
      fc.property(valueArb, (a) => {
        const p = simplePredicate("x", a);
        const notNotP = p.not().not();
        const expression = expr(notNotP);

        // Structure is NOT(NOT(p))
        expect(expression.__type).toBe("not");
        if (expression.__type !== "not") return;
        expect(expression.predicate.__type).toBe("not");
        if (expression.predicate.__type !== "not") return;
        expect(expression.predicate.predicate).toEqual(expr(p));
      }),
      { numRuns: 50 },
    );
  });

  it("triple negation creates three levels of NOT", () => {
    const p = simplePredicate("x", 42);
    const notNotNotP = p.not().not().not();
    const expression = expr(notNotNotP);

    expect(expression.__type).toBe("not");
    if (expression.__type !== "not") return;
    expect(expression.predicate.__type).toBe("not");
  });
});

// ============================================================
// Property Tests - De Morgan's Law Structure
// ============================================================

describe("De Morgan's Law Structure", () => {
  it("NOT(A AND B) has correct structure", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);

    // NOT(A AND B)
    const notAandB = p.and(q).not();
    const expression = expr(notAandB);

    expect(expression.__type).toBe("not");
    if (expression.__type !== "not") return;
    expect(expression.predicate.__type).toBe("and");
  });

  it("(NOT A) OR (NOT B) has correct structure", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);

    // (NOT A) OR (NOT B)
    const notAorNotB = p.not().or(q.not());
    const expression = expr(notAorNotB);

    expect(expression.__type).toBe("or");
    if (expression.__type !== "or") return;
    expect(expression.predicates[0]!.__type).toBe("not");
    expect(expression.predicates[1]!.__type).toBe("not");
  });

  it("NOT(A OR B) has correct structure", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);

    // NOT(A OR B)
    const notAorB = p.or(q).not();
    const expression = expr(notAorB);

    expect(expression.__type).toBe("not");
    if (expression.__type !== "not") return;
    expect(expression.predicate.__type).toBe("or");
  });

  it("(NOT A) AND (NOT B) has correct structure", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);

    // (NOT A) AND (NOT B)
    const notAandNotB = p.not().and(q.not());
    const expression = expr(notAandNotB);

    expect(expression.__type).toBe("and");
    if (expression.__type !== "and") return;
    expect(expression.predicates[0]!.__type).toBe("not");
    expect(expression.predicates[1]!.__type).toBe("not");
  });
});

// ============================================================
// Property Tests - Associativity Structure
// ============================================================

describe("Associativity Structure", () => {
  it("(A AND B) AND C creates left-nested structure", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);
    const r = simplePredicate("c", 3);

    const leftAssoc = p.and(q).and(r);
    const expression = expr(leftAssoc);

    // Structure: AND([AND([p, q]), r])
    expect(expression.__type).toBe("and");
    if (expression.__type !== "and") return;
    expect(expression.predicates).toHaveLength(2);
    expect(expression.predicates[0]!.__type).toBe("and");
    expect(expression.predicates[1]).toEqual(expr(r));
  });

  it("A AND (B AND C) creates right-nested structure", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);
    const r = simplePredicate("c", 3);

    const rightAssoc = p.and(q.and(r));
    const expression = expr(rightAssoc);

    // Structure: AND([p, AND([q, r])])
    expect(expression.__type).toBe("and");
    if (expression.__type !== "and") return;
    expect(expression.predicates).toHaveLength(2);
    expect(expression.predicates[0]).toEqual(expr(p));
    expect(expression.predicates[1]!.__type).toBe("and");
  });

  it("(A OR B) OR C creates left-nested structure", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);
    const r = simplePredicate("c", 3);

    const leftAssoc = p.or(q).or(r);
    const expression = expr(leftAssoc);

    expect(expression.__type).toBe("or");
    if (expression.__type !== "or") return;
    expect(expression.predicates).toHaveLength(2);
    expect(expression.predicates[0]!.__type).toBe("or");
    expect(expression.predicates[1]).toEqual(expr(r));
  });

  it("A OR (B OR C) creates right-nested structure", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);
    const r = simplePredicate("c", 3);

    const rightAssoc = p.or(q.or(r));
    const expression = expr(rightAssoc);

    expect(expression.__type).toBe("or");
    if (expression.__type !== "or") return;
    expect(expression.predicates).toHaveLength(2);
    expect(expression.predicates[0]).toEqual(expr(p));
    expect(expression.predicates[1]!.__type).toBe("or");
  });
});

// ============================================================
// Property Tests - Mixed Operations
// ============================================================

describe("Mixed Predicate Operations", () => {
  it("A AND (B OR C) has correct structure", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);
    const r = simplePredicate("c", 3);

    const result = p.and(q.or(r));
    const expression = expr(result);

    expect(expression.__type).toBe("and");
    if (expression.__type !== "and") return;
    expect(expression.predicates[0]).toEqual(expr(p));
    expect(expression.predicates[1]!.__type).toBe("or");
  });

  it("(A AND B) OR C has correct structure", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);
    const r = simplePredicate("c", 3);

    const result = p.and(q).or(r);
    const expression = expr(result);

    expect(expression.__type).toBe("or");
    if (expression.__type !== "or") return;
    expect(expression.predicates[0]!.__type).toBe("and");
    expect(expression.predicates[1]).toEqual(expr(r));
  });

  it("NOT(A AND B) OR C has correct structure", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);
    const r = simplePredicate("c", 3);

    const result = p.and(q).not().or(r);
    const expression = expr(result);

    expect(expression.__type).toBe("or");
    if (expression.__type !== "or") return;
    expect(expression.predicates[0]!.__type).toBe("not");
    expect(expression.predicates[1]).toEqual(expr(r));
  });

  it("A AND NOT(B OR C) has correct structure", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);
    const r = simplePredicate("c", 3);

    const result = p.and(q.or(r).not());
    const expression = expr(result);

    expect(expression.__type).toBe("and");
    if (expression.__type !== "and") return;
    expect(expression.predicates[0]).toEqual(expr(p));
    expect(expression.predicates[1]!.__type).toBe("not");
  });
});

// ============================================================
// Property Tests - Immutability
// ============================================================

describe("Predicate Immutability", () => {
  it("and() does not mutate original predicates", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (a, b) => {
          const p = simplePredicate("x", a);
          const q = simplePredicate("y", b);

          const pBefore = JSON.stringify(expr(p));
          const qBefore = JSON.stringify(expr(q));

          p.and(q);

          expect(JSON.stringify(expr(p))).toBe(pBefore);
          expect(JSON.stringify(expr(q))).toBe(qBefore);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("or() does not mutate original predicates", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (a, b) => {
          const p = simplePredicate("x", a);
          const q = simplePredicate("y", b);

          const pBefore = JSON.stringify(expr(p));
          const qBefore = JSON.stringify(expr(q));

          p.or(q);

          expect(JSON.stringify(expr(p))).toBe(pBefore);
          expect(JSON.stringify(expr(q))).toBe(qBefore);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("not() does not mutate original predicate", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (a) => {
        const p = simplePredicate("x", a);
        const pBefore = JSON.stringify(expr(p));

        p.not();

        expect(JSON.stringify(expr(p))).toBe(pBefore);
      }),
      { numRuns: 30 },
    );
  });

  it("chained operations do not mutate intermediate results", () => {
    const p = simplePredicate("a", 1);
    const q = simplePredicate("b", 2);
    const r = simplePredicate("c", 3);

    const pAndQ = p.and(q);
    const pAndQBefore = JSON.stringify(expr(pAndQ));

    pAndQ.or(r);
    pAndQ.and(r);
    pAndQ.not();

    expect(JSON.stringify(expr(pAndQ))).toBe(pAndQBefore);
  });
});

// ============================================================
// Property Tests - Field Type Predicates
// ============================================================

describe("Different Field Type Predicates", () => {
  it("string predicates can be composed", () => {
    const p = stringPredicate("a", "hello");
    const q = stringPredicate("b", "world");

    const result = p.and(q);
    expect(expr(result).__type).toBe("and");
  });

  it("mixed type predicates can be composed", () => {
    const stringPred = stringPredicate("a", "hello");
    const numberPred = simplePredicate("b", 42);

    const andResult = stringPred.and(numberPred);
    expect(expr(andResult).__type).toBe("and");

    const orResult = stringPred.or(numberPred);
    expect(expr(orResult).__type).toBe("or");
  });

  it("null check predicates can be composed", () => {
    const field1 = fieldRef("a", ["props", "name"]);
    const field2 = fieldRef("b", ["props", "value"]);

    const isNull = stringField(field1).isNull();
    const isNotNull = numberField(field2).isNotNull();

    const result = isNull.and(isNotNull);
    const expression = expr(result);
    expect(expression.__type).toBe("and");
    if (expression.__type !== "and") return;
    expect(expression.predicates[0]!.__type).toBe("null_check");
    expect(expression.predicates[1]!.__type).toBe("null_check");
  });

  it("comparison predicates preserve their operators", () => {
    const field = fieldRef("x", ["props", "value"]);
    const numberField_ = numberField(field);

    const gt = numberField_.gt(10);
    const lte = numberField_.lte(100);
    const result = gt.and(lte);
    const expression = expr(result);

    expect(expression.__type).toBe("and");
    if (expression.__type !== "and") return;
    const left = expression.predicates[0]!;
    const right = expression.predicates[1]!;

    expect(left.__type).toBe("comparison");
    expect(right.__type).toBe("comparison");

    if (left.__type !== "comparison" || right.__type !== "comparison") return;
    expect(left.op).toBe("gt");
    expect(right.op).toBe("lte");
  });
});

// ============================================================
// Property Tests - Complex Expression Trees
// ============================================================

describe("Complex Expression Trees", () => {
  it("deeply nested expressions maintain correct structure", () => {
    const a = simplePredicate("a", 1);
    const b = simplePredicate("b", 2);
    const c = simplePredicate("c", 3);
    const d = simplePredicate("d", 4);

    // ((A AND B) OR (C AND D))
    const result = a.and(b).or(c.and(d));
    const expression = expr(result);

    expect(expression.__type).toBe("or");
    if (expression.__type !== "or") return;
    expect(expression.predicates[0]!.__type).toBe("and");
    expect(expression.predicates[1]!.__type).toBe("and");
  });

  it("NOT distributes correctly in complex expressions", () => {
    const a = simplePredicate("a", 1);
    const b = simplePredicate("b", 2);
    const c = simplePredicate("c", 3);

    // NOT((A AND B) OR C)
    const result = a.and(b).or(c).not();
    const expression = expr(result);

    expect(expression.__type).toBe("not");
    if (expression.__type !== "not") return;
    expect(expression.predicate.__type).toBe("or");
  });

  it("random expression trees are structurally valid", () => {
    // Generate random expression tree
    const treeDepthArb = fc.integer({ min: 1, max: 4 });
    const operationArb = fc.constantFrom("and", "or", "not");

    fc.assert(
      fc.property(
        treeDepthArb,
        fc.array(operationArb, { minLength: 1, maxLength: 5 }),
        (baseValue, operations) => {
          let current = simplePredicate("p", baseValue);

          for (const op of operations) {
            if (op === "not") {
              current = current.not();
            } else if (op === "and") {
              const other = simplePredicate("q", baseValue + 1);
              current = current.and(other);
            } else {
              const other = simplePredicate("r", baseValue + 2);
              current = current.or(other);
            }
          }

          // Result should be a valid predicate
          expect(current.__expr).toBeDefined();
          expect(current.__expr.__type).toBeDefined();
          expect(typeof current.and).toBe("function");
          expect(typeof current.or).toBe("function");
          expect(typeof current.not).toBe("function");
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ============================================================
// Property Tests - AST Type Consistency
// ============================================================

describe("AST Type Consistency", () => {
  it("and predicates always have 'and' type", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (a, b) => {
          const result = simplePredicate("x", a).and(simplePredicate("y", b));
          expect(expr(result).__type).toBe("and");
        },
      ),
      { numRuns: 50 },
    );
  });

  it("or predicates always have 'or' type", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (a, b) => {
          const result = simplePredicate("x", a).or(simplePredicate("y", b));
          expect(expr(result).__type).toBe("or");
        },
      ),
      { numRuns: 50 },
    );
  });

  it("not predicates always have 'not' type", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (a) => {
        const result = simplePredicate("x", a).not();
        expect(expr(result).__type).toBe("not");
      }),
      { numRuns: 50 },
    );
  });

  it("and predicates always have exactly 2 children", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (a, b) => {
          const result = simplePredicate("x", a).and(simplePredicate("y", b));
          const expression = expr(result);
          if (expression.__type !== "and") return;
          expect(expression.predicates).toHaveLength(2);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("or predicates always have exactly 2 children", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (a, b) => {
          const result = simplePredicate("x", a).or(simplePredicate("y", b));
          const expression = expr(result);
          if (expression.__type !== "or") return;
          expect(expression.predicates).toHaveLength(2);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("not predicates always have exactly 1 child", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (a) => {
        const result = simplePredicate("x", a).not();
        const expression = expr(result);
        if (expression.__type !== "not") return;
        expect(expression.predicate).toBeDefined();
      }),
      { numRuns: 50 },
    );
  });
});
