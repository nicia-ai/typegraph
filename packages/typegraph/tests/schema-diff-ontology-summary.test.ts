/**
 * A diff whose only change is a `modified` ontology entry — an edge kind's
 * `acyclic` flag, a composition pair's `existence` — summarizes that change.
 * The summary is interpolated into the `MigrationError` a verified store
 * raises, so "No changes" there read as a refusal with nothing to migrate.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  createVerifiedStore,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../src";
import { MigrationError } from "../src/errors";
import { getSchemaChanges } from "../src/schema";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const Task = defineNode("Task", { schema: z.object({}) });
const Project = defineNode("Project", { schema: z.object({}) });
const dependsOn = defineEdge("dependsOn");
const inProject = defineEdge("inProject");

const MODIFIED_ONLY_SUMMARY = "Ontology: 0 added, 0 removed, 1 modified";

function taskGraph(
  options: Readonly<{ acyclic: boolean; existence: "optional" | "required" }>,
) {
  return defineGraph({
    id: "ontology_modified_summary",
    nodes: { Task: { type: Task }, Project: { type: Project } },
    edges: {
      dependsOn: {
        type: dependsOn,
        from: [Task],
        to: [Task],
        acyclic: options.acyclic,
      },
      inProject: {
        type: inProject,
        from: [Task],
        to: [Project],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(Task, Project, { via: inProject, existence: options.existence }),
    ],
  });
}

const BASELINE = { acyclic: false, existence: "optional" } as const;

const MODIFICATIONS = [
  {
    name: "acyclic turned on",
    from: BASELINE,
    to: { ...BASELINE, acyclic: true },
  },
  {
    name: "acyclic turned off",
    from: { ...BASELINE, acyclic: true },
    to: BASELINE,
  },
  {
    name: "composition existence optional to required",
    from: BASELINE,
    to: { ...BASELINE, existence: "required" },
  },
  {
    name: "composition existence required to optional",
    from: { ...BASELINE, existence: "required" },
    to: BASELINE,
  },
] as const;

describe("schema diff summary for a modified ontology entry", () => {
  for (const modification of MODIFICATIONS) {
    it(`counts ${modification.name}`, async () => {
      const backend = createTestBackend();
      await createStoreWithSchema(taskGraph(modification.from), backend);

      const diff = requireDefined(
        await getSchemaChanges(backend, taskGraph(modification.to)),
      );

      console.log(modification.name, "->", diff.summary, diff.ontology);
      expect(diff.hasChanges).toBe(true);
      expect(diff.ontology.map((change) => change.type)).toEqual(["modified"]);
      expect(diff.summary).toBe(MODIFIED_ONLY_SUMMARY);
    });
  }

  it("names the modification in a verified store's refusal", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(taskGraph(BASELINE), backend);

    const refusal = await createVerifiedStore(
      taskGraph({ ...BASELINE, acyclic: true }),
      backend,
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(MigrationError);
    expect((refusal as MigrationError).message).toContain(
      MODIFIED_ONLY_SUMMARY,
    );
    expect((refusal as MigrationError).message).not.toContain("No changes");
  });
});
