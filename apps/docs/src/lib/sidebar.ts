export type SidebarItem =
  | Readonly<{ label: string; slug: string }>
  | Readonly<{ label: string; items: readonly SidebarItem[] }>;

export const documentationSidebar: readonly SidebarItem[] = [
  {
    label: "Getting Started",
    items: [
      { label: "What is TypeGraph?", slug: "overview" },
      { label: "Quick Start", slug: "getting-started" },
      { label: "Project Structure", slug: "project-structure" },
    ],
  },
  {
    label: "Guides",
    items: [
      { label: "Backend Setup", slug: "backend-setup" },
      { label: "Schemas & Types", slug: "core-concepts" },
      { label: "Ontology & Reasoning", slug: "ontology" },
      { label: "Operational Identity", slug: "identity" },
      { label: "Semantic Search", slug: "semantic-search" },
      { label: "Fulltext Search", slug: "fulltext-search" },
      { label: "Graph Algorithms", slug: "graph-algorithms" },
      { label: "Schema Migrations", slug: "schema-management" },
      { label: "Evolving Schemas", slug: "schema-evolution" },
      { label: "Graph Extensions", slug: "graph-extensions" },
      { label: "Graph Merge", slug: "graph-merge" },
      { label: "Provenance and Retraction", slug: "provenance" },
      { label: "Multiple Graphs", slug: "multiple-graphs" },
      { label: "Import/export", slug: "interchange" },
      { label: "Testing", slug: "testing" },
    ],
  },
  {
    label: "Query Builder",
    items: [
      { label: "Overview", slug: "queries/overview" },
      { label: "Source", slug: "queries/source" },
      { label: "Filter", slug: "queries/filter" },
      { label: "Traverse", slug: "queries/traverse" },
      { label: "Recursive", slug: "queries/recursive" },
      { label: "Shape", slug: "queries/shape" },
      { label: "Expressions", slug: "queries/expressions" },
      { label: "Aggregate", slug: "queries/aggregate" },
      { label: "Order", slug: "queries/order" },
      { label: "Temporal", slug: "queries/temporal" },
      { label: "Compose", slug: "queries/compose" },
      { label: "Combine", slug: "queries/combine" },
      { label: "Relations", slug: "queries/relations" },
      { label: "Execute", slug: "queries/execute" },
      { label: "Subqueries", slug: "queries/advanced" },
      { label: "Predicates", slug: "queries/predicates" },
    ],
  },
  {
    label: "Recipes",
    items: [
      { label: "Common Patterns", slug: "recipes" },
      { label: "Data Sync", slug: "data-sync" },
      { label: "Integration Patterns", slug: "integration" },
      { label: "Materializing Event Logs", slug: "materializing-event-logs" },
    ],
  },
  {
    label: "Examples",
    items: [
      {
        label: "FHIR Graph Merge",
        slug: "examples/fhir-graph-merge",
      },
      {
        label: "Incremental Merge",
        slug: "examples/incremental-merge",
      },
      {
        label: "Agent-Driven Schema",
        slug: "examples/agent-driven-schema",
      },
      {
        label: "Research Copilot",
        slug: "examples/research-copilot",
      },
      {
        label: "Bitemporal Time Travel",
        slug: "examples/bitemporal-time-travel",
      },
      {
        label: "Agent Decision Replay",
        slug: "examples/agent-decision-replay",
      },
      {
        label: "Provenance Retraction",
        slug: "examples/provenance-retraction",
      },
      {
        label: "Breach Forensics",
        slug: "examples/breach-forensics",
      },
      {
        label: "Knowledge Graph for RAG",
        slug: "examples/knowledge-graph-rag",
      },
      {
        label: "Document Management",
        slug: "examples/document-management",
      },
      { label: "Product Catalog", slug: "examples/product-catalog" },
      { label: "Workflow Engine", slug: "examples/workflow-engine" },
      { label: "Audit Trail", slug: "examples/audit-trail" },
      { label: "Multi-Tenant SaaS", slug: "examples/multi-tenant" },
    ],
  },
  {
    label: "Performance",
    items: [
      { label: "Overview", slug: "performance/overview" },
      { label: "Indexes", slug: "performance/indexes" },
      { label: "Query Profiler", slug: "performance/profiler" },
    ],
  },
  {
    label: "Reference",
    items: [
      { label: "Schemas & Stores", slug: "schemas-stores" },
      { label: "Types", slug: "types" },
      { label: "Errors", slug: "errors" },
      { label: "Troubleshooting", slug: "troubleshooting" },
      { label: "Limitations", slug: "limitations" },
      { label: "Architecture", slug: "architecture" },
      { label: "Authoring an engine profile", slug: "backend-authoring" },
      { label: "LLM Support", slug: "llm-support" },
    ],
  },
  {
    label: "Ejecting",
    slug: "ejecting",
  },
  {
    label: "Changelog",
    slug: "changelog",
  },
];
