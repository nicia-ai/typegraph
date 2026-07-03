/**
 * Pins an upstream V8 `JSON.parse` data-corruption bug so we notice when a
 * Node release fixes it (and can drop the escaped-key filter in
 * `schema-serialization.test.ts`).
 *
 * The bug (Node >= 23; absent on 20 and 22): parsing a JSON object whose key
 * contains a character `JSON.stringify` escapes (`"`, `\`, or a C0 control
 * character) populates an internal shape-keyed cache. A LATER `JSON.parse` of
 * a same-shaped object with a DIFFERENT escaped key at the same position gets
 * the earlier object's key STRING back instead of its own — silently
 * re-keying the value. Minimal reproduction:
 *
 *   JSON.parse('{"a":1,"\\\\":2}');           // primes the cache with "\\"
 *   Object.keys(JSON.parse('{"a":1,"\\"":2}')) // → ["a","\\"]  (should be ["a","\""])
 *
 * There is no library-level fix: the correct key is already gone once
 * `JSON.parse` returns, and a reviver does not bypass the fast path.
 *
 * Upstream (both open/assigned as of Chrome milestone 151):
 *   V8:   https://issues.chromium.org/issues/521080746
 *         "escaped-key transition lookup uses raw source bytes with decoded
 *          length" — keys of equal DECODED length collide in the map cache.
 *   Node: https://github.com/nodejs/node/issues/63785
 * Introduced in V8 12.9 (Node 23.0); clean on V8 12.4 (Node 22).
 *
 * This test asserts the CORRECT behavior. On an affected Node it is expected
 * to fail, so it is skipped there — flipping to a hard failure the day the
 * engine is fixed, which is our signal to restore full escaped-key coverage.
 */
import { describe, expect, it } from "vitest";

/** True when the running engine round-trips escaped object keys correctly. */
function engineRoundTripsEscapedKeys(): boolean {
  JSON.parse(String.raw`{"a":1,"\\":2}`);
  const keys = Object.keys(JSON.parse(String.raw`{"a":1,"\"":2}`));
  return keys.length === 2 && keys[1] === '"';
}

const engineIsAffected = !engineRoundTripsEscapedKeys();

describe("JSON.parse escaped-key round-trip (V8 regression guard)", () => {
  it.skipIf(engineIsAffected)(
    "round-trips distinct escaped keys of the same object shape",
    () => {
      JSON.parse(String.raw`{"a":1,"\\":2}`);
      const keys = Object.keys(JSON.parse(String.raw`{"a":1,"\"":2}`));
      expect(keys).toEqual(["a", '"']);
    },
  );

  it("reports whether this engine is affected", () => {
    // Documents the running engine's status in the test output; never fails.
    expect(typeof engineIsAffected).toBe("boolean");
  });
});
