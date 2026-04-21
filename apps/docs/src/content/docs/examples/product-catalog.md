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
  searchable,
} from "@nicia-ai/typegraph";

// Category hierarchy
const Category = defineNode("Category", {
  schema: z.object({
    name: searchable({ language: "english" }),
    slug: z.string(),
    description: searchable({ language: "english" }).optional(),
    imageUrl: z.string().url().optional(),
    displayOrder: z.number().default(0),
    isActive: z.boolean().default(true),
  }),
});

// Products
const Product = defineNode("Product", {
  schema: z.object({
    sku: z.string(),
    // `searchable()` enables BM25 fulltext matching on name + description.
    // Combined with the `embedding` field below this supports hybrid
    // retrieval — SKU-style exact matches that embeddings miss, plus
    // conceptual matches that keyword search alone miss.
    name: searchable({ language: "english" }),
    description: searchable({ language: "english" }),
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
    // "Large / Blue" — variant names contain the exact tokens shoppers
    // type ("blue", "xl"), so indexing them enables keyword retrieval
    // that complements the product-level embedding.
    name: searchable({ language: "english" }),
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
    Category: {
      type: Category,
      unique: [
        {
          name: "category_slug",
          fields: ["slug"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Product: {
      type: Product,
      unique: [
        {
          name: "product_sku",
          fields: ["sku"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Variant: {
      type: Variant,
      unique: [
        {
          name: "variant_sku",
          fields: ["sku"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Warehouse: {
      type: Warehouse,
      unique: [
        {
          name: "warehouse_code",
          fields: ["code"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
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
  const result = await store.nodes.Category.getOrCreateByConstraint(
    "category_slug",
    { name, slug, isActive: true },
  );

  if (result.action === "created" && parentSlug) {
    const parent = await store.nodes.Category.findByConstraint(
      "category_slug",
      { slug: parentSlug },
    );
    if (parent) {
      await store.edges.parentCategory.create(result.node, parent, {});
    }
  }

  return result.node;
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
  const category = await store.nodes.Category.findByConstraint(
    "category_slug",
    { slug },
  );
  if (!category) return undefined;

  // Walk `parentCategory` edges up to the root. `reachable` returns each
  // ancestor with its depth from the starting node — sort by depth desc
  // so the root comes first.
  const ancestorIds = (
    await store.algorithms.reachable(category.id, {
      edges: ["parentCategory"],
      excludeSource: true,
    })
  )
    .toSorted((a, b) => b.depth - a.depth)
    .map((node) => node.id);

  const ancestors = await store.nodes.Category.getByIds(ancestorIds);

  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    path: ancestors
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map((c) => ({ name: c.name, slug: c.slug })),
  };
}
```

### Get Subcategories

```typescript
async function getSubcategories(
  parentSlug: string,
  includeNested = false
): Promise<Array<{ id: string; name: string; slug: string; depth: number }>> {
  const parent = await store.nodes.Category.findByConstraint(
    "category_slug",
    { slug: parentSlug },
  );
  if (!parent) return [];

  // `reachable` returns descendants tagged with their depth. Cap at 1 for
  // immediate children only, or let it run to the configured default
  // (10 hops) for the full subtree.
  const descendants = await store.algorithms.reachable(parent.id, {
    edges: ["parentCategory"],
    direction: "in",
    excludeSource: true,
    maxHops: includeNested ? undefined : 1,
  });

  const children = (await store.nodes.Category.getByIds(
    descendants.map((node) => node.id),
  )).filter(
    (category): category is NonNullable<typeof category> =>
      category !== undefined && category.isActive,
  );

  const depthById = new Map(descendants.map((row) => [row.id, row.depth]));
  return children
    .map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      depth: depthById.get(category.id) ?? 1,
    }))
    .toSorted((a, b) => a.depth - b.depth);
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
  const product = await store.nodes.Product.findByConstraint(
    "product_sku",
    { sku },
  );
  if (!product) return undefined;

  // `store.batch()` runs all three queries over a single connection with
  // snapshot consistency — no interleaved writes between the category,
  // variant, and related reads.
  const [categories, variants, related] = await store.batch(
    store
      .query()
      .from("Product", "p")
      .whereNode("p", (p) => p.id.eq(product.id))
      .traverse("inCategory", "e")
      .to("Category", "c")
      .select((ctx) => ({
        name: ctx.c.name,
        slug: ctx.c.slug,
        isPrimary: ctx.e.isPrimary,
      })),
    store
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
      })),
    store
      .query()
      .from("Product", "p")
      .whereNode("p", (p) => p.id.eq(product.id))
      .traverse("relatedProduct", "e")
      .to("Product", "r")
      .orderBy("e", "sortOrder", "asc")
      .select((ctx) => ({
        id: ctx.r.id,
        name: ctx.r.name,
        type: ctx.e.type,
      })),
  );

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
    .aggregate({
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

Product search is a textbook hybrid-search problem: users type SKUs,
brand names, and category jargon that embeddings blur together, and
conceptual queries ("warm winter jacket") that exact keyword matching
misses. TypeGraph supports both in one query.

### Fulltext-only search (SKU / keyword hits)

`store.search.fulltext()` runs a ranked BM25 query across every
`searchable()` field on the node. Good for search-box autocomplete and
SKU lookups where the query is a bag of keywords rather than a
description:

```typescript
const hits = await store.search.fulltext("Product", {
  query: "waterproof jacket",
  limit: 20,
  includeSnippets: true,
});

for (const hit of hits) {
  console.log(hit.node.sku, hit.node.name, hit.score, hit.snippet);
}
```

### Hybrid product search (fulltext + semantic, fused)

For a production product-search feature, fuse fulltext and vector
retrieval with Reciprocal Rank Fusion. RRF is rank-based, so it handles
the score-scale mismatch between BM25 and cosine automatically:

```typescript
async function searchProducts(
  query: string,
  options: {
    categorySlug?: string;
    minPrice?: number;
    maxPrice?: number;
    limit?: number;
  } = {}
): Promise<Array<{ product: ProductProps; score: number; snippet?: string }>> {
  const { categorySlug, minPrice, maxPrice, limit = 20 } = options;
  const queryEmbedding = await generateEmbedding(query);

  // Limit category scope (if requested) to a set of IDs we can pass in
  // as an equality filter. Applying this ahead of RRF shrinks the
  // candidate pool before fusion — better latency and ranking quality.
  let categoryIds: readonly string[] | undefined;
  if (categorySlug) {
    const root = await store.nodes.Category.findByConstraint(
      "category_slug",
      { slug: categorySlug },
    );
    if (!root) return [];
    const subtree = await store.algorithms.reachable(root.id, {
      edges: ["parentCategory"],
      direction: "in",
    });
    categoryIds = subtree.map((node) => node.id);
  }

  const hits = await store.search.hybrid("Product", {
    limit,
    vector: {
      fieldPath: "embedding",
      queryEmbedding,
      metric: "cosine",
      k: limit * 4,
    },
    fulltext: {
      query,
      k: limit * 4,
      includeSnippets: true,
    },
    // Exact-name matches matter in commerce search — boost fulltext.
    fusion: { method: "rrf", k: 60, weights: { vector: 1, fulltext: 1.5 } },
  });

  // Post-filter by status / price / category. The hybrid API does not
  // compose with the query builder's predicates, so apply these after
  // fusion. For heavier filtering, switch to the query-builder path
  // below and filter inside the same SQL statement.
  const filtered = hits.filter((hit) => {
    if (hit.node.status !== "active") return false;
    if (minPrice !== undefined && hit.node.basePrice < minPrice) return false;
    if (maxPrice !== undefined && hit.node.basePrice > maxPrice) return false;
    return true;
  });

  if (categoryIds === undefined) {
    return filtered.map((hit) => ({
      product: hit.node,
      score: hit.score,
      snippet: hit.fulltext?.snippet,
    }));
  }

  // Category membership is a graph edge — check with a single batch query.
  const categoryIdSet = new Set(categoryIds);
  const productToCategories = new Map<string, Set<string>>();
  const memberships = await store
    .query()
    .from("Product", "p")
    .whereNode("p", (p) => p.id.in(filtered.map((hit) => hit.node.id)))
    .traverse("inCategory", "e")
    .to("Category", "c")
    .select((ctx) => ({ productId: ctx.p.id, categoryId: ctx.c.id }))
    .execute();
  for (const row of memberships) {
    const cats = productToCategories.get(row.productId) ?? new Set();
    cats.add(row.categoryId);
    productToCategories.set(row.productId, cats);
  }

  return filtered
    .filter((hit) => {
      const cats = productToCategories.get(hit.node.id) ?? new Set();
      return [...cats].some((id) => categoryIdSet.has(id));
    })
    .map((hit) => ({
      product: hit.node,
      score: hit.score,
      snippet: hit.fulltext?.snippet,
    }));
}
```

### Hybrid search composed with graph traversal (query builder)

When you need tighter composition with predicates and traversals — for
example, "only products in these categories, active, in stock" — use the
query builder. `$fulltext.matches()` and `.similarTo()` in the same
`whereNode()` compile to a two-CTE SQL statement with RRF at the
ORDER BY:

```typescript
const hits = await store
  .query()
  .from("Product", "p")
  .whereNode("p", (p) =>
    p.$fulltext
      .matches(query, limit * 4)
      .and(p.embedding.similarTo(queryEmbedding, limit * 4))
      .and(p.status.eq("active")),
  )
  .traverse("inCategory", "e")
  .to("Category", "c")
  .whereNode("c", (c) => c.id.in([...categoryIdSet]))
  .fuseWith({ k: 60, weights: { vector: 1, fulltext: 1.5 } })
  .select((ctx) => ctx.p)
  .limit(limit)
  .execute();
```

Results come back already ranked by the fused RRF score. The traversal
filter is applied inside the same SQL statement, before the final
`LIMIT`, so recall is not sacrificed for composition.

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

  const root = await store.nodes.Category.findByConstraint(
    "category_slug",
    { slug: categorySlug },
  );
  if (!root) return { products: [], total: 0 };

  const categoryIds = includeSubcategories
    ? (
        await store.algorithms.reachable(root.id, {
          edges: ["parentCategory"],
          direction: "in",
        })
      ).map((node) => node.id)
    : [root.id];

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
