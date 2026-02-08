/**
 * Transitive closure computation for ontology relationships.
 *
 * Uses Warshall's algorithm for efficient closure computation.
 */

/**
 * Computes the transitive closure of a set of directed relations.
 *
 * Given relations like [A→B, B→C], computes all transitive paths [A→B, A→C, B→C].
 *
 * @param relations - Array of [from, to] pairs representing direct relationships
 * @returns Map from each 'from' to the set of all reachable 'to' values
 */
export function computeTransitiveClosure(
  relations: readonly (readonly [string, string])[],
): ReadonlyMap<string, ReadonlySet<string>> {
  // Build mutable map for computation
  const closure = new Map<string, Set<string>>();

  // Collect all nodes
  const allNodes = new Set<string>();
  for (const [from, to] of relations) {
    allNodes.add(from);
    allNodes.add(to);
  }

  // Initialize empty sets for all nodes
  for (const node of allNodes) {
    closure.set(node, new Set());
  }

  // Add direct relationships
  for (const [from, to] of relations) {
    closure.get(from)?.add(to);
  }

  // Warshall's algorithm for transitive closure
  // For each intermediate node k, check if i→k and k→j implies i→j
  for (const k of allNodes) {
    for (const index of allNodes) {
      const indexReaches = closure.get(index);
      if (!indexReaches?.has(k)) continue;

      const kReaches = closure.get(k);
      if (!kReaches) continue;

      for (const index of kReaches) {
        indexReaches.add(index);
      }
    }
  }

  return closure;
}

/**
 * Computes the inverse of a transitive closure map.
 *
 * Given A→{B, C}, returns B→{A}, C→{A}.
 */
export function invertClosure(
  closure: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>();

  for (const [from, tos] of closure) {
    for (const to of tos) {
      const existing = result.get(to) ?? new Set();
      existing.add(from);
      result.set(to, existing);
    }
  }

  return result;
}

/**
 * Checks if there's a path from source to target in the closure.
 */
export function isReachable(
  closure: ReadonlyMap<string, ReadonlySet<string>>,
  source: string,
  target: string,
): boolean {
  return closure.get(source)?.has(target) ?? false;
}
