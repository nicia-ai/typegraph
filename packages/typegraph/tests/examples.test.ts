import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

import { main as basicUsage } from "../examples/01-basic-usage";
import { main as schemaValidation } from "../examples/02-schema-validation";
import { main as subclassHierarchy } from "../examples/03-subclass-hierarchy";
import { main as disjointConstraints } from "../examples/04-disjoint-constraints";
import { main as edgeImplications } from "../examples/05-edge-implications";
import { main as inverseEdges } from "../examples/06-inverse-edges";
import { main as deleteBehaviors } from "../examples/07-delete-behaviors";
import { main as customOntology } from "../examples/08-custom-ontology";
import { main as paginationStreaming } from "../examples/09-pagination-streaming";
import { main as semanticSearch } from "../examples/11-semantic-search";

// Note: 10-postgresql.ts is excluded - it requires an external PostgreSQL database

const EXAMPLES = [
  { name: "01-basic-usage", main: basicUsage },
  { name: "02-schema-validation", main: schemaValidation },
  { name: "03-subclass-hierarchy", main: subclassHierarchy },
  { name: "04-disjoint-constraints", main: disjointConstraints },
  { name: "05-edge-implications", main: edgeImplications },
  { name: "06-inverse-edges", main: inverseEdges },
  { name: "07-delete-behaviors", main: deleteBehaviors },
  { name: "08-custom-ontology", main: customOntology },
  { name: "09-pagination-streaming", main: paginationStreaming },
  { name: "11-semantic-search", main: semanticSearch },
] as const;

describe("examples", () => {
  let consoleLogSpy: MockInstance;
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(vi.fn());
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(vi.fn());
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  for (const { name, main } of EXAMPLES) {
    it(`${name} runs without error`, async () => {
      await expect(main()).resolves.toBeUndefined();
    });
  }
});
