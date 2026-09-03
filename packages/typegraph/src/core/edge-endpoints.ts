/**
 * Helper utilities for edge endpoint domain and range validation.
 *
 * Supports both Cartesian endpoint declarations (array-valued `to`)
 * and source-dependent target declarations (map-valued `to`).
 */
import { ConfigurationError } from "../errors";
import { compareStrings } from "../utils/compare";
import { createDataKeyedBag, hasOwnKey } from "../utils/object";
import {
  type EdgeTargetMap,
  type EdgeTargets,
  isNodeType,
  type NodeType,
} from "./types";

/**
 * Checks if a value is an EdgeTargetMap.
 */
export function isEdgeTargetMap(value: unknown): value is EdgeTargetMap {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every(
      (targets) => Array.isArray(targets) && targets.length > 0,
    )
  );
}

/**
 * Projects all target node types into a deduplicated flat array.
 */
export function projectTargetNodes(to: EdgeTargets): readonly NodeType[] {
  const seen = new Set<string>();
  const result: NodeType[] = [];
  const lists: readonly (readonly NodeType[])[] =
    Array.isArray(to) ? [to] : Object.values(to);
  for (const targets of lists) {
    for (const node of targets) {
      if (!seen.has(node.kind)) {
        seen.add(node.kind);
        result.push(node);
      }
    }
  }
  return result;
}

/**
 * Projects all target kind names into a deduplicated array.
 */
export function projectTargetKinds(to: EdgeTargets): readonly string[] {
  return projectTargetNodes(to).map((node) => node.kind);
}

/**
 * Represents a single directed endpoint pair (fromKind -> toKind).
 */
export type EndpointPair = Readonly<{
  from: string;
  to: string;
}>;

/**
 * Extracts and canonicalizes (deduplicates and sorts) all valid endpoint pairs for an edge.
 */
export function getEdgeEndpointPairs(
  from: readonly NodeType[],
  to: EdgeTargets,
): readonly EndpointPair[] {
  const pairs: EndpointPair[] = [];
  const seen = new Set<string>();

  if (Array.isArray(to)) {
    const toArray: readonly NodeType[] = to;
    for (const fromNode of from) {
      for (const toNode of toArray) {
        const key = `${fromNode.kind}\0${toNode.kind}`;
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push({ from: fromNode.kind, to: toNode.kind });
        }
      }
    }
  } else {
    const toMap: EdgeTargetMap = to as EdgeTargetMap;
    for (const [sourceKind, targets] of Object.entries(toMap)) {
      for (const targetNode of targets) {
        const key = `${sourceKind}\0${targetNode.kind}`;
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push({ from: sourceKind, to: targetNode.kind });
        }
      }
    }
  }

  return pairs.toSorted((a, b) => {
    const cmp = compareStrings(a.from, b.from);
    if (cmp !== 0) return cmp;
    return compareStrings(a.to, b.to);
  });
}

/**
 * Formats a list of endpoint pairs for human-readable error messages.
 */
export function formatEndpointPairs(pairs: readonly EndpointPair[]): string {
  return pairs.map((pair) => `(${pair.from} -> ${pair.to})`).join(", ");
}

/**
 * Normalizes a target map by deduplicating target nodes by kind.
 */
export function normalizeTargetMap(to: EdgeTargetMap): EdgeTargetMap {
  const result = createDataKeyedBag<readonly NodeType[]>();
  for (const [key, targets] of Object.entries(to)) {
    const seen = new Set<string>();
    const uniqueTargets: NodeType[] = [];
    for (const t of targets) {
      if (!seen.has(t.kind)) {
        seen.add(t.kind);
        uniqueTargets.push(t);
      }
    }
    result[key] = Object.freeze(uniqueTargets);
  }
  return Object.freeze({ ...result });
}

/**
 * Validates map-valued target entries against the declared `from` nodes.
 */
export function validateTargetMapEntries(
  name: string,
  from: readonly NodeType[] | undefined,
  to: unknown,
): asserts to is EdgeTargetMap {
  if (!Array.isArray(from) || from.length === 0) {
    throw new ConfigurationError(
      `Edge "${name}" declares source-dependent targets in 'to', but 'from' is missing or empty.`,
      { edgeName: name },
      {
        suggestion: `Declare a non-empty 'from' array of source node types when using a mapping in 'to'.`,
      },
    );
  }

  if (typeof to !== "object" || to === null || Array.isArray(to)) {
    throw new ConfigurationError(
      `Edge "${name}" 'to' mapping must be a plain object mapping source kind names to target node arrays.`,
      { edgeName: name },
    );
  }

  const declaredSourceKinds = new Set<string>(
    from.map((node: NodeType): string => node.kind),
  );
  const declaredSourceList = [...declaredSourceKinds];
  const mapKeys = Object.keys(to);

  // Check for missing keys
  for (const sourceKind of declaredSourceKinds) {
    if (!hasOwnKey(to as Readonly<Record<string, unknown>>, sourceKind)) {
      throw new ConfigurationError(
        `Edge "${name}" is missing target mapping for declared source kind "${sourceKind}".`,
        {
          edgeName: name,
          missingKey: sourceKind,
          declaredSources: declaredSourceList,
        },
        {
          suggestion: `Add an entry for "${sourceKind}" in the 'to' mapping: { ${sourceKind}: [...] }.`,
        },
      );
    }
  }

  // Check for extra keys
  for (const key of mapKeys) {
    if (!declaredSourceKinds.has(key)) {
      throw new ConfigurationError(
        `Edge "${name}" has entry "${key}" in 'to' that is not in declared 'from' kinds: [${declaredSourceList.join(", ")}].`,
        {
          edgeName: name,
          extraKey: key,
          declaredSources: declaredSourceList,
        },
        {
          suggestion: `Remove "${key}" from 'to', or add a node type with kind "${key}" to 'from'. Keys in 'to' must use literal node kind names.`,
        },
      );
    }
  }

  // Validate target arrays for each key
  for (const [key, targets] of Object.entries(to)) {
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new ConfigurationError(
        `Edge "${name}" target array for source kind "${key}" must be a non-empty array of node types.`,
        { edgeName: name, sourceKind: key },
        {
          suggestion: `Provide at least one target node type for source kind "${key}": { ${key}: [TargetNode] }.`,
        },
      );
    }
    for (const target of targets) {
      if (!isNodeType(target)) {
        throw new ConfigurationError(
          `Edge "${name}" target for source kind "${key}" contains an invalid node reference.`,
          { edgeName: name, sourceKind: key, invalidTarget: target },
          {
            suggestion: `Ensure all targets in 'to' are node types created with defineNode.`,
          },
        );
      }
    }
  }
}
