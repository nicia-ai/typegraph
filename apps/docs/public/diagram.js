(async function () {
  let mermaid;
  try {
    const mod =
      await import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs");
    mermaid = mod.default;
  } catch (e) {
    console.error("[TypeGraph] Failed to load mermaid:", e);
    return;
  }

  mermaid.initialize({
    startOnLoad: false,
    theme:
      document.documentElement.dataset.theme === "dark" ? "dark" : "default",
  });

  function parseDefineGraph(code) {
    const nodes = [];
    const edges = [];
    const ontology = [];

    // Find the defineGraph call
    const defineGraphMatch = code.match(
      /defineGraph\s*\(\s*\{([\s\S]*)\}\s*\)/,
    );
    if (!defineGraphMatch) return null;

    const graphContent = defineGraphMatch[1];

    // Extract nodes by finding all "NodeName: { type:" patterns
    const nodePattern = /(\w+):\s*\{\s*type:\s*(\w+)\s*\}/g;
    let m;
    while ((m = nodePattern.exec(graphContent)) !== null) {
      // Only add if inside nodes section (after "nodes:" and before "edges:")
      const beforeMatch = graphContent.substring(0, m.index);
      if (beforeMatch.includes("nodes:") && !beforeMatch.includes("edges:")) {
        nodes.push(m[1]);
      }
    }

    // Extract edges by finding patterns with from: [...] and to: [...]
    const edgePattern =
      /(\w+):\s*\{[^{}]*type:\s*\w+[^{}]*from:\s*\[([^\]]*)\][^{}]*to:\s*\[([^\]]*)\][^{}]*\}/g;
    while ((m = edgePattern.exec(graphContent)) !== null) {
      const beforeMatch = graphContent.substring(0, m.index);
      if (beforeMatch.includes("edges:")) {
        const fromNodes = m[2]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const toNodes = m[3]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        edges.push({ name: m[1], from: fromNodes, to: toNodes });
      }
    }

    // Extract ontology relationships
    const ontologyMatch = graphContent.match(/ontology:\s*\[([\s\S]*?)\]/);
    if (ontologyMatch) {
      const relPattern =
        /(subClassOf|broader|narrower|partOf|hasPart|implies)\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/g;
      while ((m = relPattern.exec(ontologyMatch[1])) !== null) {
        ontology.push({ type: m[1], subject: m[2], object: m[3] });
      }
    }

    return nodes.length > 0 ? { nodes, edges, ontology } : null;
  }

  function generateMermaid(graph) {
    const lines = ["graph TD"];
    graph.nodes.forEach((n) => lines.push("    " + n + "([" + n + "])"));
    if (graph.edges.length > 0) {
      lines.push("");
      graph.edges.forEach((e) => {
        e.from.forEach((f) => {
          e.to.forEach((t) => {
            // Skip self-referential edges as they render poorly
            if (f === t) return;
            lines.push("    " + f + " -->|" + e.name + "| " + t);
          });
        });
      });
    }
    if (graph.ontology.length > 0) {
      lines.push("");
      const labels = {
        subClassOf: "extends",
        broader: "broader",
        narrower: "narrower",
        partOf: "part of",
        hasPart: "has part",
        implies: "implies",
      };
      graph.ontology.forEach((r) => {
        // Skip self-referential ontology relations
        if (r.subject === r.object) return;
        lines.push(
          "    " +
            r.subject +
            " -.->|" +
            (labels[r.type] || r.type) +
            "| " +
            r.object,
        );
      });
    }
    return lines.join("\n");
  }

  async function renderDiagrams() {
    const codeBlocks = document.querySelectorAll(
      'pre[data-language="typescript"]',
    );

    for (const pre of codeBlocks) {
      const wrapper = pre.closest(".expressive-code");
      if (!wrapper) continue;

      // Skip if diagram already rendered
      if (wrapper.nextElementSibling?.classList.contains("mermaid-diagram"))
        continue;

      const copyBtn = wrapper.querySelector("button[data-code]");
      if (!copyBtn) continue;
      const code = copyBtn.dataset.code;
      if (!code || !code.includes("defineGraph")) continue;

      const graph = parseDefineGraph(code);
      if (!graph) continue;

      const mermaidCode = generateMermaid(graph);

      try {
        const id = "mermaid-" + Math.random().toString(36).slice(2);
        const { svg } = await mermaid.render(id, mermaidCode);
        const container = document.createElement("div");
        container.className = "mermaid-diagram";
        container.innerHTML = svg;
        wrapper.insertAdjacentElement("afterend", container);
      } catch (e) {
        console.error("[TypeGraph] Mermaid render error:", e);
      }
    }
  }

  await renderDiagrams();
  document.addEventListener("astro:after-swap", renderDiagrams);
})();
