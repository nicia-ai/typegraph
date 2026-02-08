/**
 * Example 02: Schema Validation
 *
 * This example demonstrates how TypeGraph uses Zod schemas to:
 * - Validate node and edge properties at creation time
 * - Provide type safety at compile time
 * - Handle validation errors gracefully
 */
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineEdge,
  defineNode,
  ValidationError,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Define Rich Schemas with Zod
// ============================================================

// User with various validation rules
const User = defineNode("User", {
  schema: z.object({
    username: z
      .string()
      .min(3, "Username must be at least 3 characters")
      .max(20, "Username must be at most 20 characters")
      .regex(/^[a-z0-9_]+$/, "Username can only contain lowercase letters, numbers, and underscores"),
    email: z.string().email("Invalid email format"),
    age: z
      .number()
      .int("Age must be an integer")
      .min(0, "Age cannot be negative")
      .max(150, "Age seems unrealistic")
      .optional(),
    role: z.enum(["admin", "user", "guest"]).default("user"),
    tags: z.array(z.string()).default([]),
    metadata: z
      .record(z.string(), z.unknown())
      .optional(),
  }),
});

// Product with strict validation
const Product = defineNode("Product", {
  schema: z.object({
    sku: z.string().regex(/^[A-Z]{2,4}-\d{4,8}$/, "SKU must be like 'ABC-12345'"),
    name: z.string().min(1, "Product name is required"),
    price: z.number().positive("Price must be positive"),
    currency: z.enum(["USD", "EUR", "GBP"]).default("USD"),
    inStock: z.boolean().default(true),
    categories: z.array(z.string()).min(1, "At least one category required"),
  }),
});

// Purchase edge with validation
const purchased = defineEdge("purchased", {
  schema: z.object({
    quantity: z.number().int().positive("Quantity must be a positive integer"),
    priceAtPurchase: z.number().positive(),
    purchasedAt: z.string().datetime("Must be ISO datetime"),
  }),
});

// ============================================================
// Define Graph
// ============================================================

const graph = defineGraph({
  id: "validation_example",
  nodes: {
    User: { type: User },
    Product: { type: Product },
  },
  edges: {
    purchased: { type: purchased, from: [User], to: [Product] },
  },
  ontology: [],
});

// ============================================================
// Demonstrate Validation
// ============================================================

export async function main() {
  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  console.log("=== Schema Validation Examples ===\n");

  // 1. Valid node creation
  console.log("1. Creating valid user...");
  const user = await store.nodes.User.create({
    username: "alice_dev",
    email: "alice@example.com",
    age: 28,
    role: "admin",
    tags: ["developer", "team-lead"],
  });
  console.log("   Created user:", user.username);

  // 2. Invalid username - too short
  console.log("\n2. Trying invalid username (too short)...");
  try {
    await store.nodes.User.create({
      username: "ab", // Too short!
      email: "ab@example.com",
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      console.log("   Validation failed:", error.message);
    }
  }

  // 3. Invalid email format
  console.log("\n3. Trying invalid email...");
  try {
    await store.nodes.User.create({
      username: "bob_test",
      email: "not-an-email", // Invalid!
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      console.log("   Validation failed:", error.message);
    }
  }

  // 4. Invalid SKU format
  console.log("\n4. Trying invalid product SKU...");
  try {
    await store.nodes.Product.create({
      sku: "invalid-sku", // Doesn't match pattern!
      name: "Widget",
      price: 9.99,
      categories: ["widgets"],
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      console.log("   Validation failed:", error.message);
    }
  }

  // 5. Valid product
  console.log("\n5. Creating valid product...");
  const product = await store.nodes.Product.create({
    sku: "WDG-12345",
    name: "Super Widget",
    price: 29.99,
    currency: "USD",
    categories: ["widgets", "tools"],
  });
  console.log("   Created product:", product.name);

  // 6. Invalid edge - negative quantity
  // Note: Edges can be created using either:
  // - Node objects directly: store.edges.purchased.create(user, product, {...})
  // - NodeRef objects: store.edges.purchased.create({ kind: "User", id: user.id }, ...)
  // Both forms are equivalent. NodeRef is useful when you only have the ID.
  console.log("\n6. Trying invalid purchase (negative quantity)...");
  try {
    await store.edges.purchased.create(
      { kind: "User", id: user.id },
      { kind: "Product", id: product.id },
      {
        quantity: -5, // Invalid!
        priceAtPurchase: 29.99,
        purchasedAt: new Date().toISOString(),
      },
    );
  } catch (error) {
    if (error instanceof ValidationError) {
      console.log("   Validation failed:", error.message);
    }
  }

  // 7. Valid edge
  console.log("\n7. Creating valid purchase...");
  const purchase = await store.edges.purchased.create(
    { kind: "User", id: user.id },
    { kind: "Product", id: product.id },
    {
      quantity: 2,
      priceAtPurchase: 29.99,
      purchasedAt: new Date().toISOString(),
    },
  );
  console.log("   Created purchase, quantity:", purchase.quantity);

  // 8. Demonstrate default values
  console.log("\n8. Creating user with defaults...");
  const guestUser = await store.nodes.User.create({
    username: "guest_user",
    email: "guest@example.com",
    // role defaults to "user"
    // tags defaults to []
  });
  console.log("   User role (defaulted):", guestUser.role);
  console.log("   User tags (defaulted):", guestUser.tags);

  console.log("\n=== All validation examples complete ===");

  await backend.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
