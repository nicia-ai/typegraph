import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSnbCliOptions } from "./cli";

describe("parseSnbCliOptions history and engine-set flags", () => {
  it("records history and tolerates skipped engines by default, as before", () => {
    const options = parseSnbCliOptions(["--profile=smoke"]);
    assert.equal(options.recordHistory, true);
    assert.equal(options.requireAllEngines, false);
  });

  it("turns history off with --no-history and requires every engine with --require-all-engines", () => {
    const options = parseSnbCliOptions([
      "--profile=smoke",
      "--no-history",
      "--require-all-engines",
    ]);
    assert.equal(options.recordHistory, false);
    assert.equal(options.requireAllEngines, true);
  });
});
