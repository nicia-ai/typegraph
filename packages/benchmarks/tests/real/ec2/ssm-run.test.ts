import { describe, expect, it } from "vitest";

import {
  EXIT_CODE_MARKER,
  extractExitCode,
  renderExitCodeCapture,
  waitUntil,
} from "../../../src/real/ec2/ssm-run";

describe("renderExitCodeCapture", () => {
  it("wraps the command with the preamble and exits with its code", () => {
    const script = renderExitCodeCapture({
      preamble: ["cd /opt/typegraph/packages/benchmarks"],
      command: "pnpm bench:regression > out.log 2>&1",
    });
    expect(script).toContain("cd /opt/typegraph/packages/benchmarks");
    expect(script).toContain("pnpm bench:regression > out.log 2>&1");
    expect(script).toContain("EXIT_CODE=$?");
    expect(script).toContain(EXIT_CODE_MARKER.start);
    expect(script).toContain(EXIT_CODE_MARKER.end);
    expect(script.trim().endsWith("exit $EXIT_CODE")).toBe(true);
  });

  it("capture script exits with the wrapped command's code", () => {
    // Load-bearing: without "exit $EXIT_CODE", the wrapper script's own
    // process exit status would be whatever the last `echo` produced (0),
    // silently reporting a failed wrapped command as a successful SSM
    // command invocation.
    const script = renderExitCodeCapture({ command: "false" });
    expect(script).toMatch(/exit \$EXIT_CODE\s*$/);
  });
});

describe("extractExitCode", () => {
  it("extracts an exit code between its markers", () => {
    const stdout = [
      "some preceding output",
      EXIT_CODE_MARKER.start,
      "0",
      EXIT_CODE_MARKER.end,
      "trailing output",
    ].join("\n");
    expect(extractExitCode(stdout)).toBe(0);

    const nonZero = [EXIT_CODE_MARKER.start, "2", EXIT_CODE_MARKER.end].join(
      "\n",
    );
    expect(extractExitCode(nonZero)).toBe(2);
  });

  it("returns undefined when the end marker is missing (truncated stdout)", () => {
    const truncated = [EXIT_CODE_MARKER.start, "0"].join("\n");
    expect(extractExitCode(truncated)).toBeUndefined();
  });

  it("returns undefined for a non-integer payload", () => {
    const garbled = [
      EXIT_CODE_MARKER.start,
      "not-a-number",
      EXIT_CODE_MARKER.end,
    ].join("\n");
    expect(extractExitCode(garbled)).toBeUndefined();
  });

  it("returns undefined when both markers are absent", () => {
    expect(extractExitCode("no markers at all")).toBeUndefined();
  });
});

describe("waitUntil", () => {
  it("resolves once the check passes", async () => {
    let calls = 0;
    await waitUntil("test condition", 1, 1000, async () => {
      calls += 1;
      return calls >= 3;
    });
    expect(calls).toBe(3);
  });

  it("surfaces the last error on timeout", async () => {
    await expect(
      waitUntil("a condition that always throws", 1, 5, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/last error: boom/);
  });

  it("times out with no error suffix when check never throws", async () => {
    await expect(
      waitUntil("a condition that never becomes true", 1, 5, async () => false),
    ).rejects.toThrow(
      /Timed out waiting for: a condition that never becomes true$/,
    );
  });
});
