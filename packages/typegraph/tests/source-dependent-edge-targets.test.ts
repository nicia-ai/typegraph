import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type EdgeRegistration,
  EndpointError,
  EndpointPairError,
  implies,
  inverseOf,
  isEdgeTargetMap,
  isEdgeTypeWithEndpoints,
  subClassOf,
} from "../src";
import { defineGraphExtension } from "../src/graph-extension";
import { importGraph } from "../src/interchange/import";
import { buildKindRegistry } from "../src/registry";
import { computeSchemaHash, serializeSchema } from "../src/schema";
import { computeSchemaDiff } from "../src/schema/migration";
import { type NodeRef, type TypedEdgeCollection } from "../src/store/types";
import { createTestBackend } from "./test-utils";

describe("Source-dependent edge targets (Issue #603)", () => {
  const Task = defineNode("Task", {
    schema: z.object({ title: z.string() }),
  });
  const Course = defineNode("Course", {
    schema: z.object({ name: z.string() }),
  });
  const Employee = defineNode("Employee", {
    schema: z.object({ name: z.string() }),
  });
  const Department = defineNode("Department", {
    schema: z.object({ code: z.string() }),
  });
  const Student = defineNode("Student", {
    schema: z.object({ matric: z.string() }),
  });

  describe("Edge Definition & Target Map Validation", () => {
    it("creates an edge with map-valued 'to'", () => {
      const dependsOn = defineEdge("dependsOn", {
        from: [Task, Course],
        to: {
          Task: [Task],
          Course: [Course],
        },
      });

      expect(isEdgeTargetMap(dependsOn.to)).toBe(true);
      expect(isEdgeTypeWithEndpoints(dependsOn)).toBe(true);
      expect(dependsOn.from).toEqual([Task, Course]);
      expect(dependsOn.to).toEqual({
        Task: [Task],
        Course: [Course],
      });
    });

    it("supports computed keys via [Node.kind]", () => {
      const dependsOn = defineEdge("dependsOn", {
        from: [Task, Course],
        to: {
          [Task.kind]: [Task],
          [Course.kind]: [Course],
        },
      });

      expect(isEdgeTargetMap(dependsOn.to)).toBe(true);
      expect(dependsOn.to).toEqual({
        Task: [Task],
        Course: [Course],
      });
    });

    it("rejects map-valued 'to' when 'from' is missing", () => {
      expect(() =>
        // @ts-expect-error from is missing
        defineEdge("bad", {
          to: {
            Task: [Task],
          },
        }),
      ).toThrow(ConfigurationError);
    });

    it("rejects map-valued 'to' when a declared 'from' kind is missing from mapping", () => {
      expect(() =>
        defineEdge("bad", {
          from: [Task, Course],
          // @ts-expect-error Course is missing
          to: {
            Task: [Task],
          },
        }),
      ).toThrow(ConfigurationError);
    });

    it("rejects map-valued 'to' when extra keys not in 'from' are present", () => {
      expect(() =>
        defineEdge("bad", {
          from: [Task],
          to: {
            Task: [Task],
            Course: [Course],
          },
        }),
      ).toThrow(ConfigurationError);
    });

    it("rejects empty target array in mapping", () => {
      expect(() =>
        defineEdge("bad", {
          from: [Task],
          to: {
            // @ts-expect-error empty array not allowed
            Task: [],
          },
        }),
      ).toThrow(ConfigurationError);
    });

    it("normalizes duplicate target node types in target array", () => {
      const edge = defineEdge("rel", {
        from: [Task],
        to: {
          Task: [Task, Task],
        },
      });
      expect(edge.to).toEqual({
        Task: [Task],
      });
    });
  });

  describe("Graph Registration & Narrowing", () => {
    it("allows bare edge with map-valued 'to' in defineGraph", () => {
      const dependsOn = defineEdge("dependsOn", {
        from: [Task, Course],
        to: {
          Task: [Task],
          Course: [Course],
        },
      });

      const graph = defineGraph({
        id: "g1",
        nodes: { Task: { type: Task }, Course: { type: Course } },
        edges: { dependsOn },
      });

      expect(graph.edges.dependsOn.type).toBe(dependsOn);
      expect(graph.edges.dependsOn.from).toEqual([Task, Course]);
      expect(graph.edges.dependsOn.to).toEqual({
        Task: [Task],
        Course: [Course],
      });
    });

    it("allows map-valued registration to narrow a Cartesian edge", () => {
      const genericDependsOn = defineEdge("dependsOn", {
        from: [Task, Course],
        to: [Task, Course],
      });

      const graph = defineGraph({
        id: "g2",
        nodes: { Task: { type: Task }, Course: { type: Course } },
        edges: {
          dependsOn: {
            type: genericDependsOn,
            from: [Task, Course],
            to: {
              Task: [Task],
              Course: [Course],
            },
          },
        },
      });

      expect(graph.edges.dependsOn.to).toEqual({
        Task: [Task],
        Course: [Course],
      });
    });

    it("allows map-valued registration to narrow a map-valued edge", () => {
      const wideEdge = defineEdge("assignedTo", {
        from: [Employee, Student],
        to: {
          Employee: [Department, Course],
          Student: [Course],
        },
      });

      const graph = defineGraph({
        id: "g3",
        nodes: {
          Employee: { type: Employee },
          Department: { type: Department },
        },
        edges: {
          assignedTo: {
            type: wideEdge,
            from: [Employee],
            to: {
              Employee: [Department],
            },
          },
        },
      });

      expect(graph.edges.assignedTo.to).toEqual({
        Employee: [Department],
      });
    });

    it("rejects map-valued registration widening beyond built-in map edge", () => {
      const narrowEdge = defineEdge("dependsOn", {
        from: [Task, Course],
        to: {
          Task: [Task],
          Course: [Course],
        },
      });

      expect(() =>
        defineGraph({
          id: "g_invalid",
          nodes: { Task: { type: Task }, Course: { type: Course } },
          edges: {
            dependsOn: {
              type: narrowEdge,
              from: [Task, Course],
              to: {
                Task: [Task, Course], // Widening! Course not allowed for Task
                Course: [Course],
              },
            },
          },
        }),
      ).toThrow(ConfigurationError);
    });

    it("rejects array-valued registration that erases built-in correlation", () => {
      const correlatedEdge = defineEdge("dependsOn", {
        from: [Task, Course],
        to: {
          Task: [Task],
          Course: [Course],
        },
      });

      expect(() =>
        defineGraph({
          id: "g_invalid",
          nodes: { Task: { type: Task }, Course: { type: Course } },
          edges: {
            dependsOn: {
              type: correlatedEdge,
              from: [Task, Course],
              to: [Task, Course], // Cartesian would erase correlation and allow Task->Course
            },
          },
        }),
      ).toThrow(ConfigurationError);
    });
  });

  describe("Runtime Endpoint Pair Validation", () => {
    const dependsOn = defineEdge("dependsOn", {
      from: [Task, Course],
      to: {
        Task: [Task],
        Course: [Course],
      },
    });

    const graph = defineGraph({
      id: "social_tasks",
      nodes: { Task: { type: Task }, Course: { type: Course } },
      edges: { dependsOn },
    });

    it("accepts valid endpoint pairs (Task->Task and Course->Course)", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const task1 = await store.nodes.Task.create({ title: "Task 1" });
      const task2 = await store.nodes.Task.create({ title: "Task 2" });
      const course1 = await store.nodes.Course.create({ name: "Math" });
      const course2 = await store.nodes.Course.create({ name: "Physics" });

      const edge1 = await store.edges.dependsOn.create(task1, task2);
      expect(edge1.fromKind).toBe("Task");
      expect(edge1.toKind).toBe("Task");

      const edge2 = await store.edges.dependsOn.create(course1, course2);
      expect(edge2.fromKind).toBe("Course");
      expect(edge2.toKind).toBe("Course");
    });

    it("rejects undeclared endpoint pairs with typed EndpointPairError", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const task1 = await store.nodes.Task.create({ title: "Task 1" });
      const course1 = await store.nodes.Course.create({ name: "Math" });

      // Task -> Course is undeclared
      await expect(
        // @ts-expect-error undeclared endpoint pair
        store.edges.dependsOn.create(task1, course1),
      ).rejects.toThrow(EndpointPairError);

      try {
        // @ts-expect-error undeclared endpoint pair
        await store.edges.dependsOn.create(task1, course1);
      } catch (err) {
        expect(err).toBeInstanceOf(EndpointPairError);
        const pairErr = err as EndpointPairError;
        expect(pairErr.details.endpoint).toBe("pair");
        expect(pairErr.details.edgeKind).toBe("dependsOn");
        expect(pairErr.details.fromKind).toBe("Task");
        expect(pairErr.details.toKind).toBe("Course");
        expect(pairErr.details.allowedPairs).toEqual([
          { from: "Course", to: "Course" },
          { from: "Task", to: "Task" },
        ]);
      }

      // Course -> Task is also undeclared
      await expect(
        // @ts-expect-error undeclared endpoint pair
        store.edges.dependsOn.create(course1, task1),
      ).rejects.toThrow(EndpointPairError);
    });

    it("still rejects invalid source kind with EndpointError (endpoint: 'from')", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const task1 = await store.nodes.Task.create({ title: "Task 1" });

      await expect(
        // @ts-expect-error unknown kind
        store.edges.dependsOn.create({ kind: "Unknown", id: "u-1" }, task1),
      ).rejects.toThrow(EndpointError);
    });

    it("enforces pair validation even when reference-existence check is disabled", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      await expect(
        store.edges.dependsOn.create(
          // @ts-expect-error undeclared endpoint pair
          { kind: "Task", id: "t-nonexistent" },
          { kind: "Course", id: "c-nonexistent" },
          {},
          { validateEndpoints: false } as any,
        ),
      ).rejects.toThrow(EndpointPairError);
    });
  });

  describe("Subtype & Inheritance Semantics (subClassOf)", () => {
    const SubTask = defineNode("SubTask", {
      schema: z.object({ title: z.string(), priority: z.number() }),
    });

    const subGraph = defineGraph({
      id: "sub_test",
      nodes: {
        Task: { type: Task },
        SubTask: { type: SubTask },
        Course: { type: Course },
      },
      edges: {
        dependsOn: {
          type: defineEdge("dependsOn"),
          from: [Task, Course],
          to: {
            Task: [Task],
            Course: [Course],
          },
        },
      },
      ontology: [subClassOf(SubTask, Task)],
    });

    it("allows SubTask to connect to Task and SubTask because SubTask is a subtype of Task", async () => {
      const backend = createTestBackend();
      const store = createStore(subGraph, backend);

      const task = await store.nodes.Task.create({ title: "Main Task" });
      const subtask1 = await store.nodes.SubTask.create({
        title: "Sub 1",
        priority: 1,
      });
      const subtask2 = await store.nodes.SubTask.create({
        title: "Sub 2",
        priority: 2,
      });

      // SubTask -> Task
      const e1 = await (store.edges.dependsOn.create as any)(
        { kind: "SubTask", id: subtask1.id },
        { kind: "Task", id: task.id },
      );
      expect(e1.id).toBeDefined();

      // Task -> SubTask
      const e2 = await (store.edges.dependsOn.create as any)(
        { kind: "Task", id: task.id },
        { kind: "SubTask", id: subtask2.id },
      );
      expect(e2.id).toBeDefined();

      // SubTask -> SubTask
      const e3 = await (store.edges.dependsOn.create as any)(
        { kind: "SubTask", id: subtask1.id },
        { kind: "SubTask", id: subtask2.id },
      );
      expect(e3.id).toBeDefined();
    });

    it("rejects SubTask -> Course", async () => {
      const backend = createTestBackend();
      const store = createStore(subGraph, backend);

      const subtask = await store.nodes.SubTask.create({
        title: "Sub",
        priority: 1,
      });
      const course = await store.nodes.Course.create({ name: "Math" });

      await expect(
        (store.edges.dependsOn.create as any)(
          { kind: "SubTask", id: subtask.id },
          { kind: "Course", id: course.id },
        ),
      ).rejects.toThrow(EndpointPairError);
    });
  });

  describe("Bulk Operations & Atomicity", () => {
    const dependsOn = defineEdge("dependsOn", {
      from: [Task, Course],
      to: {
        Task: [Task],
        Course: [Course],
      },
    });

    const graph = defineGraph({
      id: "bulk_test",
      nodes: { Task: { type: Task }, Course: { type: Course } },
      edges: { dependsOn },
    });

    it("bulkCreate accepts heterogeneous valid pairs", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const t1 = await store.nodes.Task.create({ title: "T1" });
      const t2 = await store.nodes.Task.create({ title: "T2" });
      const c1 = await store.nodes.Course.create({ name: "C1" });
      const c2 = await store.nodes.Course.create({ name: "C2" });

      const edges = await store.edges.dependsOn.bulkCreate([
        { from: t1, to: t2 },
        { from: c1, to: c2 },
      ]);
      expect(edges).toHaveLength(2);
    });

    it("bulkCreate rolls back completely when one item is an invalid pair", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const t1 = await store.nodes.Task.create({ title: "T1" });
      const t2 = await store.nodes.Task.create({ title: "T2" });
      const c1 = await store.nodes.Course.create({ name: "C1" });

      await expect(
        store.edges.dependsOn.bulkCreate([
          { from: t1, to: t2 }, // Valid item
          // @ts-expect-error undeclared pair
          { from: t1, to: c1 }, // Invalid pair
        ]),
      ).rejects.toThrow(EndpointPairError);

      // Verify no edges were created
      const count = await store.edges.dependsOn.count();
      expect(count).toBe(0);
    });

    it("bulkUpsertById rolls back completely when an item has an invalid pair", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const t1 = await store.nodes.Task.create({ title: "T1" });
      const t2 = await store.nodes.Task.create({ title: "T2" });
      const c1 = await store.nodes.Course.create({ name: "C1" });

      await expect(
        store.edges.dependsOn.bulkUpsertById([
          { id: "e1" as any, from: t1, to: t2 },
          // @ts-expect-error undeclared pair
          { id: "e2" as any, from: t1, to: c1 },
        ]),
      ).rejects.toThrow(EndpointPairError);

      expect(await store.edges.dependsOn.count()).toBe(0);
    });
  });

  describe("Import & Graph Merge", () => {
    const dependsOn = defineEdge("dependsOn", {
      from: [Task, Course],
      to: {
        Task: [Task],
        Course: [Course],
      },
    });

    const graph = defineGraph({
      id: "import_merge_test",
      nodes: { Task: { type: Task }, Course: { type: Course } },
      edges: { dependsOn },
    });

    it("importGraph rejects edges with invalid endpoint pairs", async () => {
      const backend = createTestBackend();
      const [store] = await createStoreWithSchema(graph, backend);

      const result = await importGraph(
        store,
        {
          formatVersion: "2.0",
          exportedAt: new Date().toISOString(),
          source: {
            type: "external",
          },
          nodes: [
            { kind: "Task", id: "t1", properties: { title: "T1" } },
            { kind: "Course", id: "c1", properties: { name: "C1" } },
          ],
          edges: [
            {
              kind: "dependsOn",
              id: "e-invalid",
              from: { kind: "Task", id: "t1" },
              to: { kind: "Course", id: "c1" }, // Invalid pair!
              properties: {},
            },
          ],
        },
        { onConflict: "error" },
      );

      expect(result.success).toBe(false);
      expect(result.edges.created).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.entityType).toBe("edge");
      expect(result.errors[0]?.error).toContain("Invalid endpoint pair");
    });
  });

  describe("Ontology Compatibility (implies and inverseOf)", () => {
    it("rejects implies() when matching projected domains have incompatible pairs", () => {
      // Both edges have projected from: [Task, Course] and to: [Task, Course],
      // but orthogonal pairs!
      const edgeA = defineEdge("edgeA", {
        from: [Task, Course],
        to: {
          Task: [Task],
          Course: [Course],
        },
      });
      const edgeB = defineEdge("edgeB", {
        from: [Task, Course],
        to: {
          Task: [Course],
          Course: [Task],
        },
      });

      expect(() =>
        buildKindRegistry(
          defineGraph({
            id: "ont_test",
            nodes: { Task: { type: Task }, Course: { type: Course } },
            edges: { edgeA, edgeB },
            ontology: [implies(edgeA, edgeB)],
          }),
        ),
      ).toThrow(ConfigurationError);
    });

    it("accepts implies() when pairs are subset-compatible", () => {
      const subEdge = defineEdge("subEdge", {
        from: [Task],
        to: {
          Task: [Task],
        },
      });
      const parentEdge = defineEdge("parentEdge", {
        from: [Task, Course],
        to: {
          Task: [Task],
          Course: [Course],
        },
      });

      const graph = defineGraph({
        id: "ont_good",
        nodes: { Task: { type: Task }, Course: { type: Course } },
        edges: { subEdge, parentEdge },
        ontology: [implies(subEdge, parentEdge)],
      });

      expect(graph.ontology).toHaveLength(1);
    });

    it("rejects inverseOf() when reversed endpoint pairs are incompatible", () => {
      const assignedTo = defineEdge("assignedTo", {
        from: [Employee, Student],
        to: {
          Employee: [Department],
          Student: [Course],
        },
      });
      // Incompatible inverse: reversed pairs would be Department->Employee and Course->Student,
      // but this edge only allows Department->Student and Course->Employee!
      const wrongInverse = defineEdge("wrongInverse", {
        from: [Department, Course],
        to: {
          Department: [Student],
          Course: [Employee],
        },
      });

      expect(() =>
        buildKindRegistry(
          defineGraph({
            id: "inv_bad",
            nodes: {
              Employee: { type: Employee },
              Department: { type: Department },
              Student: { type: Student },
              Course: { type: Course },
            },
            edges: { assignedTo, wrongInverse },
            ontology: [inverseOf(assignedTo, wrongInverse)],
          }),
        ),
      ).toThrow(ConfigurationError);
    });

    it("accepts inverseOf() with matching reversed endpoint pairs", () => {
      const assignedTo = defineEdge("assignedTo", {
        from: [Employee, Student],
        to: {
          Employee: [Department],
          Student: [Course],
        },
      });
      const hasAssigned = defineEdge("hasAssigned", {
        from: [Department, Course],
        to: {
          Department: [Employee],
          Course: [Student],
        },
      });

      const graph = defineGraph({
        id: "inv_good",
        nodes: {
          Employee: { type: Employee },
          Department: { type: Department },
          Student: { type: Student },
          Course: { type: Course },
        },
        edges: { assignedTo, hasAssigned },
        ontology: [inverseOf(assignedTo, hasAssigned)],
      });

      expect(graph.ontology).toHaveLength(1);
    });
  });

  describe("Schema Persistence, Hashing & Diffing", () => {
    it("serializes targetKindsBySource and canonicalizes pair order for hashing", async () => {
      // Declaration 1: Task first, then Course
      const graph1 = defineGraph({
        id: "schema_test",
        nodes: { Task: { type: Task }, Course: { type: Course } },
        edges: {
          dependsOn: {
            type: defineEdge("dependsOn"),
            from: [Task, Course],
            to: {
              Task: [Task],
              Course: [Course],
            },
          },
        },
      });

      // Declaration 2: Course first, then Task in mapping
      const graph2 = defineGraph({
        id: "schema_test",
        nodes: { Task: { type: Task }, Course: { type: Course } },
        edges: {
          dependsOn: {
            type: defineEdge("dependsOn"),
            from: [Task, Course],
            to: {
              Course: [Course],
              Task: [Task],
            },
          },
        },
      });

      const serialized1 = serializeSchema(graph1, 1);
      expect(serialized1.edges["dependsOn"]?.targetKindsBySource).toEqual({
        Course: ["Course"],
        Task: ["Task"],
      });

      const hash1 = await computeSchemaHash(serialized1);
      const hash2 = await computeSchemaHash(serializeSchema(graph2, 1));

      // Order of mapping declaration must not change schema hash
      expect(hash1).toBe(hash2);
    });

    it("detects pair-only changes in schema diff when from/to domain unions stay identical", () => {
      // Before: Cartesian (all combinations of Task and Course)
      const graphBefore = defineGraph({
        id: "diff_test",
        nodes: { Task: { type: Task }, Course: { type: Course } },
        edges: {
          dependsOn: {
            type: defineEdge("dependsOn"),
            from: [Task, Course],
            to: [Task, Course],
          },
        },
      });

      // After: Correlated map (Task->Task, Course->Course)
      const graphAfter = defineGraph({
        id: "diff_test",
        nodes: { Task: { type: Task }, Course: { type: Course } },
        edges: {
          dependsOn: {
            type: defineEdge("dependsOn"),
            from: [Task, Course],
            to: {
              Task: [Task],
              Course: [Course],
            },
          },
        },
      });

      const diff = computeSchemaDiff(
        serializeSchema(graphBefore, 1),
        serializeSchema(graphAfter, 2),
      );
      expect(diff.hasChanges).toBe(true);
      const edgeChange = diff.edges.find((c) => c.kind === "dependsOn");
      expect(edgeChange).toBeDefined();
      expect(edgeChange?.details).toContain("targetKindsBySource");
    });
  });

  describe("Graph Extensions with Source-Dependent Targets", () => {
    it("merges extension declaring map-valued edge into host graph", async () => {
      const backend = createTestBackend();
      const baseGraph = defineGraph({
        id: "ext_base",
        nodes: { Task: { type: Task }, Course: { type: Course } },
        edges: {},
      });

      const [store] = await createStoreWithSchema(baseGraph, backend);
      const evolved = await store.evolve(
        defineGraphExtension({
          edges: {
            dependsOn: {
              from: ["Task", "Course"],
              to: {
                Task: ["Task"],
                Course: ["Course"],
              },
            },
          },
        }),
      );

      const edgeType = evolved.registry.getEdgeType("dependsOn");
      expect(edgeType).toBeDefined();
      expect(isEdgeTargetMap(edgeType?.to)).toBe(true);

      const t1 = await evolved.nodes.Task.create({ title: "Ext T1" });
      const t2 = await evolved.nodes.Task.create({ title: "Ext T2" });
      const c1 = await evolved.nodes.Course.create({ name: "Ext C1" });

      const edges = (evolved as any).edges;
      // Valid write
      const e1 = await edges.dependsOn.create(t1, t2);
      expect(e1.id).toBeDefined();

      // Invalid pair write
      await expect(edges.dependsOn.create(t1, c1)).rejects.toThrow(
        EndpointPairError,
      );
    });
  });

  describe("Review Findings Hardening", () => {
    // Finding 1: Mapped runtime extensions can be reloaded
    it("finding 1: mapped runtime extensions can be persisted and reloaded from schema", async () => {
      const backend = createTestBackend();
      const baseGraph = defineGraph({
        id: "reload_ext_test",
        nodes: { Task: { type: Task }, Course: { type: Course } },
        edges: {},
      });

      const [store] = await createStoreWithSchema(baseGraph, backend);
      await store.evolve(
        defineGraphExtension({
          edges: {
            dependsOn: {
              from: ["Task", "Course"],
              to: {
                Task: ["Task"],
                Course: ["Course"],
              },
            },
          },
        }),
      );

      // Reopen store from the persisted schema in the database
      const [reopened] = await createStoreWithSchema(baseGraph, backend);
      const edgeType = reopened.registry.getEdgeType("dependsOn");
      expect(edgeType).toBeDefined();
      expect(isEdgeTargetMap(edgeType?.to)).toBe(true);
    });

    // Finding 2: Narrowing existing edges reports breaking change and requires empty
    it("finding 2: narrowing Cartesian declaration to mapping is breaking and requires empty", () => {
      const graphBefore = defineGraph({
        id: "narrow_diff_test",
        nodes: { Task: { type: Task }, Course: { type: Course } },
        edges: {
          dependsOn: {
            type: defineEdge("dependsOn"),
            from: [Task, Course],
            to: [Task, Course],
          },
        },
      });

      const graphAfter = defineGraph({
        id: "narrow_diff_test",
        nodes: { Task: { type: Task }, Course: { type: Course } },
        edges: {
          dependsOn: {
            type: defineEdge("dependsOn"),
            from: [Task, Course],
            to: {
              Task: [Task],
              Course: [Course],
            },
          },
        },
      });

      const diff = computeSchemaDiff(
        serializeSchema(graphBefore, 1),
        serializeSchema(graphAfter, 2),
      );
      expect(diff.hasBreakingChanges).toBe(true);
      expect(diff.isBackwardsCompatible).toBe(false);
      const edgeChange = diff.edges.find((c) => c.kind === "dependsOn");
      expect(edgeChange?.severity).toBe("breaking");
      expect(edgeChange?.details).toContain("removed pairs");
    });

    // Finding 3: Removing one target prunes exhausted source entry, retaining surviving pairs
    it("finding 3: removing one target prunes exhausted source entry and retains surviving relationship", async () => {
      const backend = createTestBackend();
      const baseGraph = defineGraph({
        id: "remove_target_test",
        nodes: {},
        edges: {},
      });

      const [store] = await createStoreWithSchema(baseGraph, backend);
      await store.evolve(
        defineGraphExtension({
          nodes: {
            NodeA: { properties: { label: { type: "string" } } },
            NodeB: { properties: { label: { type: "string" } } },
            NodeX: { properties: { label: { type: "string" } } },
            NodeY: { properties: { label: { type: "string" } } },
          },
          edges: {
            rel: {
              from: ["NodeA", "NodeB"],
              to: {
                NodeA: ["NodeX"],
                NodeB: ["NodeY"],
              },
            },
          },
        }),
      );

      // Remove NodeX (only NodeA's target)
      const after = await store.removeKinds(["NodeX"]);

      // Verify NodeA is pruned from rel, but rel SURVIVES with NodeB -> NodeY!
      const relEdge = after.registry.getEdgeType("rel");
      expect(relEdge).toBeDefined();
      expect(relEdge?.from?.map((n) => n.kind)).toEqual(["NodeB"]);
      expect(relEdge?.to).toEqual({
        NodeB: [expect.objectContaining({ kind: "NodeY" })],
      });
    });

    // Finding 4: Existing typed registrations retain endpoint safety
    it("finding 4: EdgeRegistration with 3 type arguments retains endpoint safety", () => {
      const worksAt = defineEdge("worksAt", {
        schema: z.object({ role: z.string() }),
      });

      type TestRegistration = EdgeRegistration<
        typeof worksAt,
        typeof Employee,
        typeof Department
      >;

      type TestCollection = TypedEdgeCollection<TestRegistration>;

      // findTo accepts Department
      expectTypeOf<Parameters<TestCollection["findTo"]>[0]>().toEqualTypeOf<
        NodeRef<typeof Department>
      >();

      // Valid create args
      type CreateArgs = Parameters<TestCollection["create"]>;
      expectTypeOf<CreateArgs[0]>().toEqualTypeOf<NodeRef<typeof Employee>>();
      expectTypeOf<CreateArgs[1]>().toEqualTypeOf<NodeRef<typeof Department>>();
    });

    // Finding 5: Legal __proto__ source kind works safely
    it("finding 5: legal __proto__ source kind normalizes and enforces safely", async () => {
      const PROTO_KEY = "__proto__";
      const ProtoNode = defineNode(PROTO_KEY, {
        schema: z.object({ val: z.string() }),
      });
      const edge = defineEdge("protoEdge", {
        from: [ProtoNode],
        to: {
          [PROTO_KEY]: [ProtoNode],
        },
      });

      expect(isEdgeTargetMap(edge.to)).toBe(true);
      expect(Object.hasOwn(edge.to as object, PROTO_KEY)).toBe(true);

      const protoGraph = defineGraph({
        id: "proto_graph",
        nodes: {
          [PROTO_KEY]: { type: ProtoNode },
          Task: { type: Task },
        },
        edges: { protoEdge: edge },
      });

      const backend = createTestBackend();
      const store = createStore(protoGraph, backend);

      const nodeCollections = store.nodes as Record<string, any>;
      const p1 = await nodeCollections[PROTO_KEY].create({ val: "p1" });
      const p2 = await nodeCollections[PROTO_KEY].create({ val: "p2" });
      const t1 = await store.nodes.Task.create({ title: "t1" });

      const createdEdge = await store.edges.protoEdge.create(p1, p2);
      expect(createdEdge.id).toBeDefined();

      // Unrelated source or target rejected
      await expect(
        // @ts-expect-error invalid endpoint
        store.edges.protoEdge.create(t1, p2),
      ).rejects.toThrow(EndpointError);
    });

    // Finding 6: Compile-time mapped edges during unrelated kind removal
    it("finding 6: compile-time mapped edges do not break unrelated runtime kind removal", async () => {
      const backend = createTestBackend();
      const hostGraph = defineGraph({
        id: "unrelated_remove_test",
        nodes: { Task: { type: Task }, Course: { type: Course } },
        edges: {
          dependsOn: {
            type: defineEdge("dependsOn"),
            from: [Task, Course],
            to: {
              Task: [Task],
              Course: [Course],
            },
          },
        },
      });

      const [store] = await createStoreWithSchema(hostGraph, backend);
      await store.evolve(
        defineGraphExtension({
          nodes: {
            RuntimeExtra: { properties: { label: { type: "string" } } },
          },
        }),
      );

      // Removing RuntimeExtra must not fail on hostGraph's dependsOn mapped edge
      await expect(store.removeKinds(["RuntimeExtra"])).resolves.not.toThrow();
    });

    // Finding 7: Malformed graph-local mappings fail validation
    it("finding 7: malformed graph-local mappings fail validation in defineGraph", () => {
      const baseEdge = defineEdge("dependsOn");
      expect(() =>
        defineGraph({
          id: "malformed_mapping_test",
          nodes: { Task: { type: Task } },
          edges: {
            dependsOn: {
              type: baseEdge,
              from: [Task],
              // @ts-expect-error empty target array
              to: {
                Task: [],
              },
            },
          },
        }),
      ).toThrow(ConfigurationError);
    });
  });
});
