/**
 * Guards the sliced registration of the shared integration suite.
 *
 * Each backend lane runs `createIntegrationTestSuite` from several
 * `<lane>-integration-slice-<index>.test.ts` files so vitest can parallelize
 * and shard the suite by file. Slicing is only safe while the slices of a lane
 * add up to the whole suite: a missing slice file, a repeated index, or a
 * slicer that drops a registration would silently remove cross-backend
 * coverage while every remaining file still reports green. This suite turns
 * each of those into a failing test.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { requireDefined } from "../src/utils/presence";
import {
  INTEGRATION_REGISTRATIONS,
  type IntegrationRegistration,
  type IntegrationSuiteSlice,
  selectIntegrationRegistrations,
} from "./backends/integration-registrations";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const BACKENDS_DIRECTORY = "tests/backends";

/**
 * Every lane that runs the shared suite, as `<directory>/<file prefix>`.
 * Listed rather than discovered so deleting all of a lane's slice files fails
 * here instead of shrinking the set the other assertions iterate.
 */
const EXPECTED_LANES = [
  "tests/backends/postgres/pglite",
  "tests/backends/postgres/postgres",
  "tests/backends/postgres/postgres-js",
  "tests/backends/sqlite/libsql",
  "tests/backends/sqlite/sqlite",
] as const;

const SHARED_SUITES_DIRECTORY = "tests/backends/integration";

/**
 * `toMatchSnapshot()` stores its snapshot under the running test FILE. A
 * registration moves between slice files whenever the list, a weight, or a
 * lane's slice count changes, which would strand the recorded snapshot and
 * fail CI on a "new" one. Shared suites record per-dialect expectations with
 * `toMatchFileSnapshot(<path beside the suite>)` instead.
 */
const PER_TEST_FILE_SNAPSHOT_CALL = ".toMatchSnapshot(";

const SLICE_FILE_PATTERN =
  /^(?<prefix>.+)-integration-slice-(?<index>\d+)\.test\.ts$/;

/** The `slice: { index, count }` a slice file passes to its lane module. */
const STATED_SLICE_PATTERN =
  /slice:\s*\{\s*index:\s*(?<index>\d+),\s*count:\s*(?<count>\d+)\s*\}/g;

type SliceFile = Readonly<{
  lane: string;
  file: string;
  fileNameIndex: number;
  statedSlices: readonly IntegrationSuiteSlice[];
}>;

function discoverSliceFiles(): readonly SliceFile[] {
  const entries = readdirSync(path.join(PACKAGE_ROOT, BACKENDS_DIRECTORY), {
    recursive: true,
    withFileTypes: true,
  });
  return entries.flatMap((entry) => {
    const match = SLICE_FILE_PATTERN.exec(entry.name);
    if (!entry.isFile() || match?.groups === undefined) return [];
    const absolutePath = path.join(entry.parentPath, entry.name);
    const directory = path
      .relative(PACKAGE_ROOT, entry.parentPath)
      .split(path.sep)
      .join("/");
    const statedSlices = [
      ...readFileSync(absolutePath, "utf8").matchAll(STATED_SLICE_PATTERN),
    ].map((stated) => ({
      index: Number(requireDefined(stated.groups)["index"]),
      count: Number(requireDefined(stated.groups)["count"]),
    }));
    return [
      {
        lane: `${directory}/${requireDefined(match.groups["prefix"])}`,
        file: `${directory}/${entry.name}`,
        fileNameIndex: Number(match.groups["index"]),
        statedSlices,
      },
    ];
  });
}

function sliceFilesByLane(): ReadonlyMap<string, readonly SliceFile[]> {
  const byLane = new Map<string, SliceFile[]>();
  for (const sliceFile of discoverSliceFiles()) {
    byLane.set(sliceFile.lane, [
      ...(byLane.get(sliceFile.lane) ?? []),
      sliceFile,
    ]);
  }
  return byLane;
}

/** The one slice a slice file states; fails on none or several. */
function statedSlice(sliceFile: SliceFile): IntegrationSuiteSlice {
  expect(
    sliceFile.statedSlices,
    `${sliceFile.file} must state exactly one \`slice: { index, count }\``,
  ).toHaveLength(1);
  return requireDefined(sliceFile.statedSlices[0]);
}

function laneSliceCount(lane: string): number {
  const sliceFiles = requireDefined(
    sliceFilesByLane().get(lane),
    `No slice files found for lane ${lane}`,
  );
  return statedSlice(requireDefined(sliceFiles[0])).count;
}

function registrationNames(
  registrations: readonly IntegrationRegistration[],
): readonly string[] {
  return registrations.map((registration) => registration.register.name);
}

function unionOfSlices(
  count: number,
  registrations?: readonly IntegrationRegistration[],
): readonly string[] {
  return Array.from({ length: count }, (_, index) =>
    registrationNames(
      selectIntegrationRegistrations({ index, count }, registrations),
    ),
  ).flat();
}

function sharedSuitesUsingPerTestFileSnapshots(): readonly string[] {
  const directory = path.join(PACKAGE_ROOT, SHARED_SUITES_DIRECTORY);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .filter((entry) =>
      readFileSync(path.join(directory, entry.name), "utf8").includes(
        PER_TEST_FILE_SNAPSHOT_CALL,
      ),
    )
    .map((entry) => `${SHARED_SUITES_DIRECTORY}/${entry.name}`);
}

describe("integration suite slices", () => {
  it("keeps shared suites free of snapshots keyed by the running test file", () => {
    expect(sharedSuitesUsingPerTestFileSnapshots()).toEqual([]);
  });

  it("registers every sub-suite exactly once in the registration list", () => {
    const names = registrationNames(INTEGRATION_REGISTRATIONS);
    expect(names.length).toBeGreaterThan(0);
    expect(names.toSorted()).toEqual([...new Set(names)].toSorted());
  });

  it("has slice files for exactly the expected lanes", () => {
    expect([...sliceFilesByLane().keys()].toSorted()).toEqual([
      ...EXPECTED_LANES,
    ]);
  });

  describe.each(EXPECTED_LANES)("lane %s", (lane) => {
    it("has one slice file per index 0..count-1, each stating its own index and the lane's count", () => {
      const sliceFiles = requireDefined(
        sliceFilesByLane().get(lane),
        `No slice files found for lane ${lane}`,
      );
      const count = laneSliceCount(lane);

      for (const sliceFile of sliceFiles) {
        expect(
          statedSlice(sliceFile),
          `${sliceFile.file} must state the index in its file name and the lane's slice count`,
        ).toEqual({ index: sliceFile.fileNameIndex, count });
      }
      expect(
        sliceFiles
          .map((sliceFile) => statedSlice(sliceFile).index)
          .toSorted((left, right) => left - right),
        `${lane} slice files must cover indexes 0..${count - 1} exactly once`,
      ).toEqual(Array.from({ length: count }, (_, index) => index));
    });

    it("covers the full registration list exactly once across its slices", () => {
      const union = unionOfSlices(laneSliceCount(lane));

      expect(union.toSorted()).toEqual(
        registrationNames(INTEGRATION_REGISTRATIONS).toSorted(),
      );
    });
  });
});

// Registration stand-ins: only their identity and weight matter to the slicer.
function registerExistingHeavy(): void {
  // Registers nothing.
}
function registerExistingLight(): void {
  // Registers nothing.
}
function registerNewlyAdded(): void {
  // Registers nothing.
}

describe("selectIntegrationRegistrations", () => {
  const SLICE_COUNT = 2;

  it("places a newly added, unweighted registration in exactly one slice", () => {
    const registrations: readonly IntegrationRegistration[] = [
      { register: registerExistingHeavy, weight: 9 },
      { register: registerExistingLight, weight: 1 },
      { register: registerNewlyAdded },
    ];

    expect(unionOfSlices(SLICE_COUNT, registrations).toSorted()).toEqual(
      registrationNames(registrations).toSorted(),
    );
  });

  it("keeps the heaviest registration apart from the rest and preserves suite order within a slice", () => {
    const registrations: readonly IntegrationRegistration[] = [
      { register: registerExistingLight, weight: 1 },
      { register: registerExistingHeavy, weight: 9 },
      { register: registerNewlyAdded, weight: 2 },
    ];

    expect(
      registrationNames(
        selectIntegrationRegistrations(
          { index: 0, count: SLICE_COUNT },
          registrations,
        ),
      ),
    ).toEqual(["registerExistingHeavy"]);
    expect(
      registrationNames(
        selectIntegrationRegistrations(
          { index: 1, count: SLICE_COUNT },
          registrations,
        ),
      ),
    ).toEqual(["registerExistingLight", "registerNewlyAdded"]);
  });

  it.each([
    { index: 2, count: 2 },
    { index: -1, count: 2 },
    { index: 0, count: 0 },
    { index: 0.5, count: 2 },
  ])("refuses the out-of-range slice %o", (slice) => {
    expect(() => selectIntegrationRegistrations(slice)).toThrow(RangeError);
  });
});
