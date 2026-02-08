---
title: Product Catalog
description: E-commerce catalog with categories, variants, and inventory tracking
---

This example builds a product catalog system with:

- **Category hierarchy** with inheritance
- **Product variants** (size, color, etc.)
- **Inventory tracking** across warehouses
- **Product relationships** (bundles, accessories, alternatives)
- **Price history** using temporal queries

## Schema Definition

```typescript
import { z } from "zod";
import {
  defineNode,
  defineEdge,
  defineGraph,
  embedding,
} from "@nicia-ai/typegraph";

// Category hierarchy
const Category = defineNode("Category", {
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    description: z.string().optional(),
    imageUrl: z.string().url().optional(),
    displayOrder: z.number().default(0),
    isActive: z.boolean().default(true),
  }),
});

// Products
const Product = defineNode("Product", {
  schema: z.object({
    sku: z.string(),
    name: z.string(),
    description: z.string(),
    basePrice: z.number().positive(),
    currency: z.string().default("USD"),
    status: z.enum(["draft", "active", "discontinued"]).default("draft"),
    embedding: embedding(1536).optional(),
  }),
});

// Product variants (specific size/color combinations)
const Variant = defineNode("Variant", {
  schema: z.object({
    sku: z.string(),
    name: z.string(), // "Large / Blue"
    priceModifier: z.number().default(0), // Added to base price
    attributes: z.record(z.string()), // { size: "L", color: "blue" }
    isDefault: z.boolean().default(false),
  }),
});

// Inventory
const Warehouse = defineNode("Warehouse", {
  schema: z.object({
    code: z.string(),
    name: z.string(),
    location: z.string(),
    isActive: z.boolean().default(true),
  }),
});

const Inventory = defineNode("Inventory", {
  schema: z.object({
    quantity: z.number().int().min(0),
    reservedQuantity: z.number().int().min(0).default(0),
    reorderPoint: z.number().int().min(0).default(10),
    lastCountedAt: z.string().datetime().optional(),
  }),
});

// Edges
const parentCategory = defineEdge("parentCategory");
const inCategory = defineEdge("inCategory", {
  schema: z.object({ isPrimary: z.boolean().default(false) }),
});
const hasVariant = defineEdge("hasVariant");
const inventoryFor = defineEdge("inventoryFor");
const atWarehouse = defineEdge("atWarehouse");
const relatedProduct = defineEdge("relatedProduct", {
  schema: z.object({
    type: z.enum(["accessory", "alternative", "bundled", "upsell"]),
    sortOrder: z.number().default(0),
  }),
});

// Graph
const graph = defineGraph({
  id: "product_catalog",
  nodes: {
    Category: { type: Category },
    Product: { type: Product },
    Variant: { type: Variant },
    Warehouse: { type: Warehouse },
    Inventory: { type: Inventory },
  },
  edges: {
    parentCategory: { type: parentCategory, from: [Category], to: [Category] },
    inCategory: { type: inCategory, from: [Product], to: [Category] },
    hasVariant: { type: hasVariant, from: [Product], to: [Variant] },
    inventoryFor: { type: inventoryFor, from: [Inventory], to: [Variant] },
    atWarehouse: { type: atWarehouse, from: [Inventory], to: [Warehouse] },
    relatedProduct: { type: relatedProduct, from: [Product], to: [Product] },
  },
  ontology: [
    // Category hierarchy is modeled via the parentCategory edge, not ontology.
    // Use ontology for type-level constraints, e.g.:
    // disjointWith(Product, Category),
  ],
});
```

## Category Management

### Create Category Tree

```typescript
async function createCategory(
  name: string,
  slug: string,
  parentSlug?: string
): Promise<Node<typeof Category>> {
  const category = await store.nodes.Category.create({
    name,
    slug,
    isActive: true,
  });

  if (parentSlug) {
    const parent = await store
      .query()
      .from("Category", "c")
      .whereNode("c", (c) => c.slug.eq(parentSlug))
      .select((ctx) => ctx.c)
      .first();

    if (parent) {
      await store.edges.parentCategory.create(category, parent, {});
    }
  }

  return category;
}

// Build initial category structure
await createCategory("Electronics", "electronics");
await createCategory("Phones", "phones", "electronics");
await createCategory("Accessories", "accessories", "electronics");
await createCategory("Cases", "cases", "accessories");
await createCategory("Chargers", "chargers", "accessories");
```

### Get Category with Ancestors

```typescript
interface CategoryWithPath {
  id: string;
  name: string;
  slug: string;
  path: Array<{ name: string; slug: string }>;
}

async function getCategoryWithPath(slug: string): Promise<CategoryWithPath | undefined> {
  const category = await store
    .query()
    .from("Category", "c")
    .whereNode("c", (c) => c.slug.eq(slug))
    .select((ctx) => ({
      id: ctx.c.id,
      name: ctx.c.name,
      slug: ctx.c.slug,
    }))
    .first();

  if (!category) return undefined;

  const ancestors = await store
    .query()
    .from("Category", "c")
    .whereNode("c", (c) => c.slug.eq(slug))
    .traverse("parentCategory", "e")
    .recursive()
    .to("Category", "ancestor")
    .select((ctx) => ({
      name: ctx.ancestor.name,
      slug: ctx.ancestor.slug,
    }))
    .execute();

  return {
    ...category,
    path: ancestors.reverse(), // Root first
  };
}
```

### Get Subcategories

```typescript
async function getSubcategories(
  parentSlug: string,
  includeNested = false
): Promise<Array<{ id: string; name: string; slug: string; depth: number }>> {
  let query = store
    .query()
    .from("Category", "parent")
    .whereNode("parent", (c) => c.slug.eq(parentSlug))
    .traverse("parentCategory", "e", { direction: "in" });

  if (includeNested) {
    query = query.recursive().withDepth("depth");
  }

  return query
    .to("Category", "child")
    .whereNode("child", (c) => c.isActive.eq(true))
    .select((ctx) => ({
      id: ctx.child.id,
      name: ctx.child.name,
      slug: ctx.child.slug,
      depth: ctx.depth ?? 1,
    }))
    .orderBy((ctx) => ctx.child.displayOrder, "asc")
    .execute();
}
```

## Product Management

### Create Product with Variants

```typescript
interface ProductInput {
  sku: string;
  name: string;
  description: string;
  basePrice: number;
  categorySlug: string;
  variants: Array<{
    sku: string;
    name: string;
    priceModifier?: number;
    attributes: Record<string, string>;
    isDefault?: boolean;
  }>;
}

async function createProduct(input: ProductInput): Promise<Node<typeof Product>> {
  return store.transaction(async (tx) => {
    // Generate embedding for semantic search
    const embedding = await generateEmbedding(`${input.name} ${input.description}`);

    // Create product
    const product = await tx.nodes.Product.create({
      sku: input.sku,
      name: input.name,
      description: input.description,
      basePrice: input.basePrice,
      status: "draft",
      embedding,
    });

    // Link to category
    const category = await tx
      .query()
      .from("Category", "c")
      .whereNode("c", (c) => c.slug.eq(input.categorySlug))
      .select((ctx) => ctx.c)
      .first();

    if (category) {
      await tx.edges.inCategory.create(product, category, { isPrimary: true });
    }

    // Create variants
    for (const v of input.variants) {
      const variant = await tx.nodes.Variant.create({
        sku: v.sku,
        name: v.name,
        priceModifier: v.priceModifier ?? 0,
        attributes: v.attributes,
        isDefault: v.isDefault ?? false,
      });

      await tx.edges.hasVariant.create(product, variant, {});
    }

    return product;
  });
}
```

### Get Product Details

```typescript
interface ProductDetails {
  id: string;
  sku: string;
  name: string;
  description: string;
  basePrice: number;
  status: string;
  categories: Array<{ name: string; slug: string; isPrimary: boolean }>;
  variants: Array<{
    id: string;
    sku: string;
    name: string;
    price: number;
    attributes: Record<string, string>;
    inventory: number;
  }>;
  related: Array<{ id: string; name: string; type: string }>;
}

async function getProductDetails(sku: string): Promise<ProductDetails | undefined> {
  const product = await store
    .query()
    .from("Product", "p")
    .whereNode("p", (p) => p.sku.eq(sku))
    .select((ctx) => ctx.p)
    .first();

  if (!product) return undefined;

  // Get categories
  const categories = await store
    .query()
    .from("Product", "p")
    .whereNode("p", (p) => p.id.eq(product.id))
    .traverse("inCategory", "e")
    .to("Category", "c")
    .select((ctx) => ({
      name: ctx.c.name,
      slug: ctx.c.slug,
      isPrimary: ctx.e.isPrimary,
    }))
    .execute();

  // Get variants with inventory
  const variants = await store
    .query()
    .from("Product", "p")
    .whereNode("p", (p) => p.id.eq(product.id))
    .traverse("hasVariant", "e")
    .to("Variant", "v")
    .optionalTraverse("inventoryFor", "inv", { direction: "in" })
    .to("Inventory", "i")
    .select((ctx) => ({
      id: ctx.v.id,
      sku: ctx.v.sku,
      name: ctx.v.name,
      priceModifier: ctx.v.priceModifier,
      attributes: ctx.v.attributes,
      quantity: ctx.i?.quantity ?? 0,
      reservedQuantity: ctx.i?.reservedQuantity ?? 0,
    }))
    .execute();

  // Get related products
  const related = await store
    .query()
    .from("Product", "p")
    .whereNode("p", (p) => p.id.eq(product.id))
    .traverse("relatedProduct", "e")
    .to("Product", "r")
    .select((ctx) => ({
      id: ctx.r.id,
      name: ctx.r.name,
      type: ctx.e.type,
    }))
    .orderBy((ctx) => ctx.e.sortOrder, "asc")
    .execute();

  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.description,
    basePrice: product.basePrice,
    status: product.status,
    categories,
    variants: variants.map((v) => ({
      ...v,
      price: product.basePrice + v.priceModifier,
      inventory: v.quantity - v.reservedQuantity,
    })),
    related,
  };
}
```

## Inventory Management

### Update Inventory

```typescript
async function updateInventory(
  variantSku: string,
  warehouseCode: string,
  quantity: number
): Promise<void> {
  const variant = await store
    .query()
    .from("Variant", "v")
    .whereNode("v", (v) => v.sku.eq(variantSku))
    .select((ctx) => ctx.v)
    .first();

  const warehouse = await store
    .query()
    .from("Warehouse", "w")
    .whereNode("w", (w) => w.code.eq(warehouseCode))
    .select((ctx) => ctx.w)
    .first();

  if (!variant || !warehouse) {
    throw new Error("Variant or warehouse not found");
  }

  // Find existing inventory record
  const existingInventory = await store
    .query()
    .from("Inventory", "i")
    .traverse("inventoryFor", "e1")
    .to("Variant", "v")
    .whereNode("v", (v) => v.id.eq(variant.id))
    .traverse("atWarehouse", "e2", { direction: "in" })
    .to("Warehouse", "w")
    .whereNode("w", (w) => w.id.eq(warehouse.id))
    .select((ctx) => ctx.i)
    .first();

  if (existingInventory) {
    await store.nodes.Inventory.update(existingInventory.id, {
      quantity,
      lastCountedAt: new Date().toISOString(),
    });
  } else {
    const inventory = await store.nodes.Inventory.create({
      quantity,
      reservedQuantity: 0,
      lastCountedAt: new Date().toISOString(),
    });

    await store.edges.inventoryFor.create(inventory, variant, {});
    await store.edges.atWarehouse.create(inventory, warehouse, {});
  }
}
```

### Reserve Inventory

```typescript
async function reserveInventory(
  variantSku: string,
  quantity: number
): Promise<{ success: boolean; warehouseCode?: string }> {
  const inventories = await store
    .query()
    .from("Variant", "v")
    .whereNode("v", (v) => v.sku.eq(variantSku))
    .traverse("inventoryFor", "e", { direction: "in" })
    .to("Inventory", "i")
    .traverse("atWarehouse", "e2")
    .to("Warehouse", "w")
    .whereNode("w", (w) => w.isActive.eq(true))
    .select((ctx) => ({
      inventoryId: ctx.i.id,
      warehouseCode: ctx.w.code,
      available: ctx.i.quantity - ctx.i.reservedQuantity,
      reservedQuantity: ctx.i.reservedQuantity,
    }))
    .execute();

  // Find warehouse with enough inventory
  const available = inventories.find((i) => i.available >= quantity);

  if (!available) {
    return { success: false };
  }

  await store.nodes.Inventory.update(available.inventoryId, {
    reservedQuantity: available.reservedQuantity + quantity,
  });

  return { success: true, warehouseCode: available.warehouseCode };
}
```

### Low Stock Report

```typescript
import { field, sum, havingLt } from "@nicia-ai/typegraph";

interface LowStockItem {
  productName: string;
  variantSku: string;
  variantName: string;
  totalQuantity: number;
  reorderPoint: number;
}

async function getLowStockItems(): Promise<LowStockItem[]> {
  return store
    .query()
    .from("Product", "p")
    .traverse("hasVariant", "e1")
    .to("Variant", "v")
    .traverse("inventoryFor", "e2", { direction: "in" })
    .to("Inventory", "i")
    .groupByNode("v")
    .having(havingLt(sum("i", "quantity"), field("i", "reorderPoint")))
    .selectAggregate({
      productName: field("p", "name"),
      variantSku: field("v", "sku"),
      variantName: field("v", "name"),
      totalQuantity: sum("i", "quantity"),
      reorderPoint: field("i", "reorderPoint"),
    })
    .execute();
}
```

## Search and Discovery

### Semantic Product Search

```typescript
async function searchProducts(
  query: string,
  options: {
    categorySlug?: string;
    minPrice?: number;
    maxPrice?: number;
    limit?: number;
  } = {}
): Promise<Array<{ product: ProductProps; score: number }>> {
  const { categorySlug, minPrice, maxPrice, limit = 20 } = options;

  const queryEmbedding = await generateEmbedding(query);

  let queryBuilder = store
    .query()
    .from("Product", "p")
    .whereNode("p", (p) => {
      let pred = p.embedding
        .similarTo(queryEmbedding, limit, { metric: "cosine", minScore: 0.6 })
        .and(p.status.eq("active"));

      if (minPrice !== undefined) {
        pred = pred.and(p.basePrice.gte(minPrice));
      }
      if (maxPrice !== undefined) {
        pred = pred.and(p.basePrice.lte(maxPrice));
      }

      return pred;
    });

  // Filter by category if specified
  if (categorySlug) {
    // Get category and all subcategories
    const categoryIds = await store
      .query()
      .from("Category", "c")
      .whereNode("c", (c) => c.slug.eq(categorySlug))
      .traverse("parentCategory", "e", { direction: "in" })
      .recursive()
      .to("Category", "sub")
      .select((ctx) => ctx.sub.id)
      .execute();

    queryBuilder = queryBuilder
      .traverse("inCategory", "e")
      .to("Category", "c")
      .whereNode("c", (c) => c.id.in([...categoryIds, categorySlug]));
  }

  return queryBuilder
    .select((ctx) => ({
      product: ctx.p,
      score: ctx.p.embedding.similarity(queryEmbedding),
    }))
    .execute();
}
```

### Get Products in Category

```typescript
async function getProductsInCategory(
  categorySlug: string,
  options: {
    includeSubcategories?: boolean;
    page?: number;
    pageSize?: number;
    sortBy?: "name" | "price" | "newest";
  } = {}
): Promise<{ products: ProductProps[]; total: number }> {
  const { includeSubcategories = true, page = 1, pageSize = 20, sortBy = "name" } = options;

  // Build category ID list
  let categoryIds: string[] = [];

  const rootCategory = await store
    .query()
    .from("Category", "c")
    .whereNode("c", (c) => c.slug.eq(categorySlug))
    .select((ctx) => ctx.c.id)
    .first();

  if (!rootCategory) return { products: [], total: 0 };

  categoryIds.push(rootCategory);

  if (includeSubcategories) {
    const subIds = await store
      .query()
      .from("Category", "c")
      .whereNode("c", (c) => c.slug.eq(categorySlug))
      .traverse("parentCategory", "e", { direction: "in" })
      .recursive()
      .to("Category", "sub")
      .select((ctx) => ctx.sub.id)
      .execute();

    categoryIds = [...categoryIds, ...subIds];
  }

  const query = store
    .query()
    .from("Product", "p")
    .whereNode("p", (p) => p.status.eq("active"))
    .traverse("inCategory", "e")
    .to("Category", "c")
    .whereNode("c", (c) => c.id.in(categoryIds))
    .select((ctx) => ctx.p);

  // Apply sorting
  const sortedQuery =
    sortBy === "price"
      ? query.orderBy((ctx) => ctx.p.basePrice, "asc")
      : sortBy === "newest"
        ? query.orderBy((ctx) => ctx.p.createdAt, "desc")
        : query.orderBy((ctx) => ctx.p.name, "asc");

  const products = await sortedQuery
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();

  const total = await store
    .query()
    .from("Product", "p")
    .whereNode("p", (p) => p.status.eq("active"))
    .traverse("inCategory", "e")
    .to("Category", "c")
    .whereNode("c", (c) => c.id.in(categoryIds))
    .count();

  return { products, total };
}
```

## Price History

### Track Price Changes

TypeGraph's temporal model automatically tracks all changes:

```typescript
async function getPriceHistory(
  sku: string
): Promise<Array<{ price: number; validFrom: string; validTo: string | undefined }>> {
  return store
    .query()
    .from("Product", "p")
    .temporal("includeEnded")
    .whereNode("p", (p) => p.sku.eq(sku))
    .orderBy((ctx) => ctx.p.validFrom, "desc")
    .select((ctx) => ({
      price: ctx.p.basePrice,
      validFrom: ctx.p.validFrom,
      validTo: ctx.p.validTo,
    }))
    .execute();
}
```

### Price at Point in Time

```typescript
async function getPriceAsOf(sku: string, date: Date): Promise<number | undefined> {
  const product = await store
    .query()
    .from("Product", "p")
    .temporal("asOf", date.toISOString())
    .whereNode("p", (p) => p.sku.eq(sku))
    .select((ctx) => ctx.p.basePrice)
    .first();

  return product;
}
```

## Next Steps

- [Document Management](/examples/document-management) - CMS with semantic search
- [Workflow Engine](/examples/workflow-engine) - State machines with approvals
- [Audit Trail](/examples/audit-trail) - Complete change tracking
