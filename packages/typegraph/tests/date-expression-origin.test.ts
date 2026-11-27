/**
 * A query expression's date decodes by the leaf its origin names: a date the
 * caller stated (a literal or parameter, or a composition of only those) as
 * the `Date` stated, and stored property text by the strict stored leaf
 * (portable text only). The decoded inputs here are the values an engine
 * returns, so every leaf choice is checked on text the two leaves disagree on:
 * a year-0000 instant, which `Date` holds and portable storage does not.
 */
import { describe, expect, it } from "vitest";

import { expr } from "../src";
import { decodeExpressionValue } from "../src/query/builder/executable-projection-query";
import { createFieldExpression } from "../src/query/expressions";
import { jsonPointer } from "../src/query/json-pointer";
import { fieldRef } from "../src/query/predicates";
import { decodeStatedDate } from "../src/store/stored-date-revival";

const YEAR_ZERO_TEXT = "0000-06-01T00:00:00.000Z";
const YEAR_ZERO = new Date(YEAR_ZERO_TEXT);

const scope = Symbol("date origin test scope");

function storedDate() {
  return createFieldExpression<Date, "d">(
    fieldRef("d", ["props"], {
      jsonPointer: jsonPointer(["at"]),
      valueType: "date",
    }),
    scope,
    true,
  );
}

function storedTitle() {
  return createFieldExpression<string, "d">(
    fieldRef("d", ["props"], {
      jsonPointer: jsonPointer(["title"]),
      valueType: "string",
    }),
    scope,
    false,
  );
}

const ORDER = { orderBy: [{ expression: storedTitle() }] } as const;

describe("a query expression's date decodes by its origin", () => {
  it("decodes a stated scalar date as the Date stated and a stored one as portable text only", () => {
    const decoded = {
      literal: decodeExpressionValue(
        YEAR_ZERO_TEXT,
        expr.literal(new Date(YEAR_ZERO)),
      ),
      parameter: decodeExpressionValue(
        YEAR_ZERO_TEXT,
        expr.param("at", "date"),
      ),
      statedCoalesce: decodeExpressionValue(
        YEAR_ZERO_TEXT,
        expr.coalesce(expr.param("at", "date"), expr.literal(YEAR_ZERO)),
      ),
      statedExtreme: decodeExpressionValue(
        YEAR_ZERO_TEXT,
        expr.max(expr.literal(YEAR_ZERO)),
      ),
      stored: decodeExpressionValue(YEAR_ZERO_TEXT, storedDate()),
      mixedCoalesce: decodeExpressionValue(
        YEAR_ZERO_TEXT,
        expr.coalesce(storedDate(), expr.literal(YEAR_ZERO)),
      ),
      storedExtreme: decodeExpressionValue(
        YEAR_ZERO_TEXT,
        expr.min(storedDate()),
      ),
    };
    expect(decoded).toEqual({
      literal: YEAR_ZERO,
      parameter: YEAR_ZERO,
      statedCoalesce: YEAR_ZERO,
      statedExtreme: YEAR_ZERO,
      stored: YEAR_ZERO_TEXT,
      mixedCoalesce: YEAR_ZERO_TEXT,
      storedExtreme: YEAR_ZERO_TEXT,
    });
  });

  it("decodes collected elements and record fields by the origin of the expression collected", () => {
    const collectedText = `["${YEAR_ZERO_TEXT}",null]`;
    expect({
      stated: decodeExpressionValue(
        collectedText,
        expr.collect(expr.literal(YEAR_ZERO), ORDER),
      ),
      stored: decodeExpressionValue(
        collectedText,
        expr.collect(storedDate(), ORDER),
      ),
    }).toEqual({
      stated: [YEAR_ZERO, undefined],
      stored: [YEAR_ZERO_TEXT, undefined],
    });

    const records = expr.collect(
      { stated: expr.literal(YEAR_ZERO), stored: storedDate() },
      ORDER,
    );
    expect(
      decodeExpressionValue(
        JSON.stringify([{ stated: YEAR_ZERO_TEXT, stored: YEAR_ZERO_TEXT }]),
        records,
      ),
    ).toEqual([{ stated: YEAR_ZERO, stored: YEAR_ZERO_TEXT }]);
  });

  it("a stated date's leaf accepts any valid instant and never produces an Invalid Date", () => {
    expect([
      decodeStatedDate(YEAR_ZERO_TEXT),
      decodeStatedDate(YEAR_ZERO.getTime()),
      decodeStatedDate(YEAR_ZERO),
      decodeStatedDate("not a date"),
      decodeStatedDate(true),
    ]).toEqual([YEAR_ZERO, YEAR_ZERO, YEAR_ZERO, "not a date", true]);
  });
});
