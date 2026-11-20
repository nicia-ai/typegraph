import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ensureNamedVolume,
  isStoppedContainerState,
  removeContainerIfPresent,
  removeVolumeIfPresent,
  runtimeMemoryBytes,
} from "./container-runtime";
import { podmanLikeRuntime } from "./podman-like-runtime";

describe("container runtime steps (Podman semantics)", () => {
  it("creates a missing volume once and leaves an existing one alone", async () => {
    const fake = podmanLikeRuntime();
    await ensureNamedVolume(fake.runtime, "data");
    await ensureNamedVolume(fake.runtime, "data");
    assert.deepEqual(
      fake.commands.filter((command) => command[1] === "create"),
      [["volume", "create", "data"]],
    );
  });

  it("removes only what exists, so teardown can repeat", async () => {
    const fake = podmanLikeRuntime();
    await fake.runtime([
      "run",
      "-d",
      "--name",
      "server",
      "-v",
      "data:/data",
      "image",
    ]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await removeContainerIfPresent(fake.runtime, "server", {
        anonymousVolumes: true,
      });
      await removeVolumeIfPresent(fake.runtime, "data");
    }
    assert.equal(fake.containers.size, 0);
    assert.equal(fake.volumes.size, 0);
    assert.ok(
      fake.commands.some((command) => command.join(" ") === "rm -f -v server"),
    );
  });
});

describe("runtimeMemoryBytes", () => {
  it("reads Docker's info shape", async () => {
    const bytes = await runtimeMemoryBytes((args) =>
      Promise.resolve(args.includes("{{.MemTotal}}") ? "1024\n" : ""),
    );
    assert.equal(bytes, 1024);
  });

  it("falls back to Podman's info shape when Docker's template fails", async () => {
    const bytes = await runtimeMemoryBytes((args) =>
      args.includes("{{.Host.MemTotal}}") ?
        Promise.resolve("2048\n")
      : Promise.reject(new Error("can't evaluate field MemTotal")),
    );
    assert.equal(bytes, 2048);
  });

  it("returns undefined when neither shape answers", async () => {
    assert.equal(
      await runtimeMemoryBytes(() => Promise.reject(new Error("no runtime"))),
      undefined,
    );
  });
});

describe("isStoppedContainerState", () => {
  it("treats Docker's and Podman's stopped states as stopped", () => {
    for (const state of ["exited", "dead", "stopped"]) {
      assert.equal(isStoppedContainerState(state), true, state);
    }
    for (const state of ["running", "created", "configured", ""]) {
      assert.equal(isStoppedContainerState(state), false, state);
    }
  });
});
