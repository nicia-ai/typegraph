/**
 * Example 04: Disjoint Constraints
 *
 * This example demonstrates using disjointWith to prevent ID conflicts:
 * - Preventing the same ID from being used for incompatible kinds
 * - Multi-kind nodes (same ID, different compatible kinds)
 * - Error handling for disjointness violations
 */
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  DisjointError,
  disjointWith,
  subClassOf,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Scenario: Entity Management System
// ============================================================

// In some systems, you might have entities that can be both
// a Person AND an Employee (same ID, different facets).
// But a Person can never be a Robot - they are disjoint.

const Entity = defineNode("Entity", {
  schema: z.object({
    createdBy: z.string().optional(),
  }),
});

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    dateOfBirth: z.string().optional(),
  }),
});

const Employee = defineNode("Employee", {
  schema: z.object({
    employeeId: z.string(),
    department: z.string(),
    hireDate: z.string(),
  }),
});

const Robot = defineNode("Robot", {
  schema: z.object({
    model: z.string(),
    serialNumber: z.string(),
    manufacturer: z.string(),
  }),
});

const Vehicle = defineNode("Vehicle", {
  schema: z.object({
    make: z.string(),
    model: z.string(),
    vin: z.string(),
  }),
});

// ============================================================
// Define Graph with Disjoint Constraints
// ============================================================

const graph = defineGraph({
  id: "entity_system",
  nodes: {
    Entity: { type: Entity },
    Person: { type: Person },
    Employee: { type: Employee },
    Robot: { type: Robot },
    Vehicle: { type: Vehicle },
  },
  edges: {},
  ontology: [
    // Both Person and Robot are subclasses of Entity
    subClassOf(Person, Entity),
    subClassOf(Robot, Entity),
    subClassOf(Employee, Entity),
    subClassOf(Vehicle, Entity),

    // But Person and Robot are disjoint - an entity cannot be both!
    disjointWith(Person, Robot),

    // Similarly, Vehicle is disjoint from Person and Robot
    disjointWith(Vehicle, Person),
    disjointWith(Vehicle, Robot),

    // Note: Person and Employee are NOT disjoint
    // So the same ID can be used for both (multi-faceted entity)
  ],
});

// ============================================================
// Demonstrate Disjoint Constraints
// ============================================================

export async function main() {
  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  console.log("=== Disjoint Constraints Examples ===\n");

  // 1. Create a Person
  console.log("1. Creating a Person with ID 'entity-alice'...");
  const alice = await store.nodes.Person.create(
    { name: "Alice Smith", dateOfBirth: "1990-05-15" },
    { id: "entity-alice" },
  );
  console.log("   Created Person:", alice.name);

  // 2. Same ID can be used for Employee (not disjoint with Person)
  console.log("\n2. Creating Employee with same ID 'entity-alice'...");
  const aliceEmployee = await store.nodes.Employee.create(
    {
      employeeId: "EMP-001",
      department: "Engineering",
      hireDate: "2020-01-15",
    },
    { id: "entity-alice" },
  );
  console.log("   Created Employee:", aliceEmployee.employeeId);
  console.log("   Same entity is now both Person AND Employee!");

  // 3. Try to create Robot with same ID - should FAIL
  console.log("\n3. Trying to create Robot with ID 'entity-alice'...");
  try {
    await store.nodes.Robot.create(
      {
        model: "RX-78",
        serialNumber: "001",
        manufacturer: "Anaheim Electronics",
      },
      { id: "entity-alice" },
    );
    console.log("   ERROR: This should have failed!");
  } catch (error) {
    if (error instanceof DisjointError) {
      console.log("   Disjoint constraint enforced!");
      console.log(`   Error: ${error.message}`);
    } else {
      throw error;
    }
  }

  // 4. Create a Robot with different ID - works fine
  console.log("\n4. Creating Robot with different ID 'robot-1'...");
  const robot = await store.nodes.Robot.create(
    {
      model: "T-800",
      serialNumber: "101",
      manufacturer: "Cyberdyne",
    },
    { id: "robot-1" },
  );
  console.log("   Created Robot:", robot.model);

  // 5. Try Vehicle with robot ID - should FAIL (Vehicle disjoint with Robot)
  console.log("\n5. Trying to create Vehicle with ID 'robot-1'...");
  try {
    await store.nodes.Vehicle.create(
      {
        make: "Tesla",
        model: "Model S",
        vin: "5YJ3E1EA1JF000001",
      },
      { id: "robot-1" },
    );
    console.log("   ERROR: This should have failed!");
  } catch (error) {
    if (error instanceof DisjointError) {
      console.log("   Disjoint constraint enforced!");
      console.log(`   Error: ${error.message}`);
    } else {
      throw error;
    }
  }

  // 6. Check which kinds are disjoint
  console.log("\n=== Checking Disjoint Relationships ===\n");
  const registry = store.registry;

  const pairs = [
    ["Person", "Robot"],
    ["Person", "Employee"],
    ["Person", "Vehicle"],
    ["Robot", "Vehicle"],
    ["Employee", "Robot"],
  ];

  for (const [a, b] of pairs) {
    const areDisjoint = registry.areDisjoint(a!, b!);
    console.log(`  ${a} and ${b}: ${areDisjoint ? "DISJOINT" : "compatible"}`);
  }

  // 7. Delete person, then create robot with that ID
  console.log("\n7. Delete Person 'entity-alice', then create Robot with that ID...");
  await store.nodes.Person.delete(alice.id);
  await store.nodes.Employee.delete(aliceEmployee.id); // Also delete Employee facet
  console.log("   Deleted Person and Employee with ID 'entity-alice'");

  const robotAlice = await store.nodes.Robot.create(
    {
      model: "Android",
      serialNumber: "A-001",
      manufacturer: "Detroit",
    },
    { id: "entity-alice" },
  );
  console.log("   Created Robot with previously used ID:", robotAlice.model);

  console.log("\n=== Disjoint constraints example complete ===");

  await backend.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
