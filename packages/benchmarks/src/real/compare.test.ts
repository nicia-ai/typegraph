import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeEngineTargets,
  parseCompareOptions,
  planCompareSteps,
} from "./compare";
import { EXTERNAL_PGGRAPH_URL_ENV } from "./harness/external-servers";

const ROOT = "/tmp/compare-root";

describe("parseCompareOptions", () => {
  it("defaults to all five engines, smoke then SF1, and no history", () => {
    const options = parseCompareOptions([], ROOT);
    assert.deepEqual(options.engines, [
      "typegraph-sqlite",
      "typegraph-postgres",
      "neo4j",
      "ladybugdb",
      "pggraph",
    ]);
    assert.deepEqual(options.scales, ["smoke", "sf1"]);
    assert.equal(options.recordHistory, false);
    assert.equal(options.outputRoot, ROOT);
  });

  it("always runs smoke before the real scales, whatever order is given", () => {
    assert.deepEqual(parseCompareOptions(["--scales=sf1,smoke"], ROOT).scales, [
      "smoke",
      "sf1",
    ]);
  });

  it("refuses unknown engines, scales and flags", () => {
    assert.throws(
      () => parseCompareOptions(["--engines=neo5j"], ROOT),
      /Unknown engine/,
    );
    assert.throws(
      () => parseCompareOptions(["--scales=sf3"], ROOT),
      /Unknown scale/,
    );
    assert.throws(
      () => parseCompareOptions(["--check=no"], ROOT),
      /Unknown argument/,
    );
  });

  it("ignores a forwarded -- separator", () => {
    assert.deepEqual(
      parseCompareOptions(["--", "--engines=neo4j"], ROOT).engines,
      ["neo4j"],
    );
  });
});

describe("planCompareSteps", () => {
  it("runs every scale with every engine under the parity gate and without history", () => {
    const steps = planCompareSteps(
      parseCompareOptions(
        [
          "--engines=typegraph-sqlite,ladybugdb",
          "--data-dir-sf1=/data/sf1",
          "--requests-per-query=40",
        ],
        ROOT,
      ),
    );
    assert.deepEqual(
      steps.map((step) => step.profile),
      ["smoke", "sf1"],
    );
    assert.deepEqual(steps[0]!.args, [
      "--profile=smoke",
      "--engines=typegraph-sqlite,ladybugdb",
      `--output=${ROOT}/snb-smoke`,
      "--check",
      "--require-all-engines",
      "--no-history",
      "--requests-per-query=40",
    ]);
    assert.deepEqual(steps[1]!.args, [
      "--profile=sf1",
      "--engines=typegraph-sqlite,ladybugdb",
      `--output=${ROOT}/snb-sf1`,
      "--check",
      "--require-all-engines",
      "--no-history",
      "--data-dir=/data/sf1",
      "--requests-per-query=40",
    ]);
  });

  it("appends history only when asked", () => {
    const [step] = planCompareSteps(
      parseCompareOptions(["--history", "--scales=smoke"], ROOT),
    );
    assert.equal(step!.args.includes("--no-history"), false);
  });
});

describe("describeEngineTargets", () => {
  it("names the container image or the redacted existing server per engine", () => {
    const lines = describeEngineTargets(["neo4j", "pggraph", "ladybugdb"], {
      [EXTERNAL_PGGRAPH_URL_ENV]: "postgresql://bench:secret@db:5432/x",
    });
    assert.match(lines[0]!, /^neo4j: container neo4j:2026\.10\.2@sha256:/);
    assert.equal(
      lines[1],
      `pggraph: existing server postgresql://bench:***@db:5432/x (${EXTERNAL_PGGRAPH_URL_ENV})`,
    );
    assert.equal(lines[2], "ladybugdb: in-process");
    assert.doesNotMatch(lines.join("\n"), /secret/);
  });
});
