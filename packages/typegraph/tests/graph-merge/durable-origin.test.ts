import { describe, expect, it } from "vitest";

import type {
  DurableBranchDescriptor,
  DurableBranchOrigin,
} from "../../src/graph-merge";
import {
  asBaseVersion,
  asBranchId,
  durableDescriptorRefusal,
  durableOriginOfDescriptor,
  durableOriginsEqual,
} from "../../src/graph-merge";

const origin: DurableBranchOrigin = {
  allocationId: "allocation-1",
  graphId: "people",
  definitionHash: "definition-v1",
  branchId: asBranchId("branch-1"),
  base: asBaseVersion("base@3"),
  schemaAnchor: undefined,
  forkRevision: undefined,
};

describe("durable branch origin helpers", () => {
  it("extracts all TypeGraph-owned origin fences from a descriptor", () => {
    const descriptor: DurableBranchDescriptor = {
      allocationId: origin.allocationId,
      kind: "sqlite",
      version: 1,
      graphId: origin.graphId,
      definitionHash: origin.definitionHash,
      branchId: origin.branchId,
      base: origin.base,
      store: { locator: "working-copy-1" },
      schemaAnchor: undefined,
      forkRevision: undefined,
    };

    expect(durableOriginOfDescriptor(descriptor)).toEqual(origin);
  });

  it("compares every origin fence, including explicit absence", () => {
    expect(durableOriginsEqual(origin, { ...origin })).toBe(true);
    expect(
      durableOriginsEqual(origin, { ...origin, allocationId: "other" }),
    ).toBe(false);
    expect(
      durableOriginsEqual(origin, { ...origin, definitionHash: "other" }),
    ).toBe(false);
    expect(
      durableOriginsEqual(
        { ...origin, schemaAnchor: undefined },
        { ...origin, schemaAnchor: { version: 1, hash: "schema" } },
      ),
    ).toBe(false);
  });

  it("validates untrusted descriptor JSON through the shared refusal predicate", () => {
    const descriptor: DurableBranchDescriptor = {
      allocationId: origin.allocationId,
      kind: "sqlite",
      version: 1,
      graphId: origin.graphId,
      definitionHash: origin.definitionHash,
      branchId: origin.branchId,
      base: origin.base,
      store: { locator: "working-copy-1" },
    };

    expect(
      durableDescriptorRefusal(descriptor, { type: "sqlite", version: 1 }),
    ).toBeUndefined();
    expect(
      durableDescriptorRefusal(
        { ...descriptor, allocationId: undefined },
        { type: "sqlite", version: 1 },
      ),
    ).toMatchObject({ name: "BranchError" });
    expect(
      durableDescriptorRefusal(descriptor, {
        type: "sqlite",
        version: 2,
        readableVersions: [1],
      }),
    ).toBeUndefined();
    expect(
      durableDescriptorRefusal(
        {
          ...descriptor,
          recordedForkPoint: { recorded: "invalid", base: "base@3" },
        },
        { type: "sqlite", version: 1 },
      ),
    ).toMatchObject({ name: "BranchError" });
  });
});
