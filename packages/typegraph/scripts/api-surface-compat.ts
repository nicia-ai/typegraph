/**
 * The external-consumer API-surface compatibility check.
 *
 * Compares the current (head) `etc/*.api.md` snapshots against the snapshots
 * committed at the last published tag (`@nicia-ai/typegraph@*`, highest by
 * `git`'s own version sort) and fails CI on a breaking change reachable by an
 * external consumer: a required member added to a contravariantly-reachable
 * (input) type, any member removed, or an optional member tightened to
 * required. A required member added to a type that is only ever reached in a
 * return (output) position is reported, not failed — it grows the surface
 * without breaking an existing caller.
 *
 * The comparison never passes vacuously: if no published tag resolves, or the
 * resolved tag has no snapshot for a given entrypoint, the checker refuses
 * (non-zero exit, remediation text) rather than silently comparing nothing.
 *
 * ## The one stated limitation
 *
 * An optional-but-effectively-required member — `foo?: X` whose *absence*
 * throws a typed error at runtime — is invisible to this snapshot differ,
 * and it is exactly the "optional at the boundary, required after
 * resolution" shim this checker's own failure text recommends as the
 * remediation for a genuine required-member addition. The sanctioned
 * remediation is therefore also the sanctioned evasion: nothing here can
 * distinguish "actually optional" from "optional in the type, required by a
 * runtime assertion." Two mitigations exist, both partial:
 *
 * 1. An `etc/api-surface-exceptions.json` entry MAY carry a `refusal` field
 *    naming the typed error code the shimmed member's absence produces, which
 *    at least makes the shim discoverable and lands it in the error-catalog
 *    matrix. `resolveRecursiveTraversal` (see `src/backend/capabilities`) is
 *    the worked example this checker's failure text points at: capability
 *    verdicts are threaded as optional-at-the-type-boundary,
 *    required-after-resolution values precisely so a backend author gets a
 *    compile error only where the resolved verdict is actually consumed.
 * 2. Ledger entries are audited both directions (`validateExceptionsLedger`),
 *    so a shim that stops being needed cannot silently linger.
 *
 * The residue — a shim introduced *without* a ledger entry, because nothing
 * here hard-fails on an optional member — is an accepted limitation of this
 * check, not a gap this module attempts to close.
 *
 * ## Two further approximations
 *
 * - **Type-argument polarity.** A type reference's type arguments (e.g. the
 *   `T` in `Promise<T>` or `Partial<T>`) inherit the polarity of the
 *   reference itself rather than being resolved per the referenced type's
 *   actual generic variance. This over-approximates in the safe direction
 *   (more things end up contravariant, not fewer).
 * - **`Pick<>` / `Omit<>` / other type-reference bodies are not inventoried.**
 *   A type alias whose entire body is a reference to another type
 *   (`type X = Pick<Y, "a">`) contributes no members of its own — only
 *   `TypeLiteral`, `Readonly<>`, `Partial<>`, `Required<>`, intersections,
 *   and unions are expanded structurally. A declaration whose entire body is
 *   such a reference can disappear from a snapshot without tripping the
 *   member-removed predicate, since it never had members to lose.
 *
 * ## Contravariant reachability is gated, not just polarity-tracked
 *
 * A declaration reached at contravariant (input) polarity only "hard"
 * (fail-eligible) if the chain of members/parameters leading to it is itself
 * mandatory: every field/parameter along the way is required (`Partial<>` /
 * `Required<>` forced-optionality is honored the same way it is for member
 * optionality), AND — for a chain rooted at a callable declaration (a
 * top-level function, an interface method, a class method, or a class
 * constructor) — that *specific callable* already existed at the base ref.
 * A brand-new type reached only through an optional field (e.g.
 * `capabilities.recursiveTraversal?: RecursiveTraversalCapability`), only
 * through a brand-new exported function's parameter (e.g. a new
 * `assertFooSupported(verdict: FooVerdict)`), or only through a brand-new
 * method or constructor on a new-or-existing interface/class (e.g.
 * `NewQueryBuilder.from`,
 * or `ExistingBuilder.newMethod`) is therefore reported, not failed: no
 * existing external caller is forced to construct it, because they can omit
 * the optional field or simply never call the new function/method. This is
 * the SAME gating predicate `collectInlineLiteralEntries` applies to inline
 * parameter object literals — the two paths share the callable-newness set
 * (`collectExistingCallableKeys`) and the per-parameter mandatory test
 * (owning callable existed at base AND the parameter itself carries no `?`)
 * rather than each re-deriving it, so they cannot drift the way an inline
 * literal's parameter and a named type's parameter once did (the inline
 * path used to hard-fail unconditionally, gating on neither axis). A
 * declaration reached through an *existing* (present-at-base) mandatory
 * chain remains hard-contravariant even when its own referenced type is
 * brand new — swapping an existing required field's value type for a new,
 * differently-shaped type is exactly the kind of change this check exists
 * to catch, and the new type's own member diff (relative to its absence at
 * base) is how that surfaces.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export type MemberOptionality = "required" | "optional";
export type DeclarationKind = "type" | "interface" | "class" | "inline-literal";

export type DeclarationRecord = Readonly<{
  name: string;
  kind: DeclarationKind;
  contravariant: boolean;
  members: ReadonlyMap<string, MemberOptionality>;
}>;

export type SurfaceInventory = ReadonlyMap<string, DeclarationRecord>;

export type FindingKind =
  "required-member-added" | "member-removed" | "optionality-tightened";

export type FindingSeverity = "fail" | "report" | "exempted";

export type SurfaceFinding = Readonly<{
  entrypoint: string;
  declaration: string;
  member: string;
  kind: FindingKind;
  severity: FindingSeverity;
  message: string;
}>;

export type ExceptionEntry = Readonly<{
  entrypoint: string;
  declaration: string;
  member: string;
  kind: FindingKind;
  reason: string;
  issue: string;
  refusal?: string;
}>;

export type LedgerIssue = Readonly<{ entry: ExceptionEntry; problem: string }>;

export type CompatRunResult = Readonly<{
  findings: readonly SurfaceFinding[];
  reportLines: readonly string[];
  failed: boolean;
}>;

export const BASE_TAG_PATTERN = "@nicia-ai/typegraph@*";
export const EXCEPTIONS_LEDGER_RELATIVE_PATH =
  "etc/api-surface-exceptions.json";

export class ApiSurfaceParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiSurfaceParseError";
  }
}

export class ApiSurfaceLedgerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiSurfaceLedgerError";
  }
}

export class UnresolvableBaseRefError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnresolvableBaseRefError";
  }
}

const FENCE_OPEN = "```ts\n";
const FENCE_CLOSE = "\n```";

/**
 * Extracts the TypeScript body between the report's two ```ts fences.
 * Throws if either fence is missing — a fence-format change in
 * api-extractor's output is a tripwire, not something to parse around.
 */
export function extractApiReportBody(source: string): string {
  const openIndex = source.indexOf(FENCE_OPEN);
  if (openIndex === -1) {
    throw new ApiSurfaceParseError(
      "API report is missing its opening ```ts fence; the report format has changed.",
    );
  }
  const bodyStart = openIndex + FENCE_OPEN.length;
  const closeIndex = source.indexOf(FENCE_CLOSE, bodyStart);
  if (closeIndex === -1) {
    throw new ApiSurfaceParseError(
      "API report is missing its closing ``` fence; the report format has changed.",
    );
  }
  return source.slice(bodyStart, closeIndex);
}

type ForcedOptionalityMode = "optional" | "required";

type NamedDeclarationEntry =
  | Readonly<{ kind: "type"; typeNode: ts.TypeNode }>
  | Readonly<{ kind: "interface"; members: ts.NodeArray<ts.TypeElement> }>
  | Readonly<{ kind: "class"; members: ts.NodeArray<ts.ClassElement> }>;

function getMemberName(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isPrivateIdentifier(name)) return undefined;
  if (ts.isComputedPropertyName(name)) return `[${name.expression.getText()}]`;
  return undefined;
}

function hasPrivateModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return (
    modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
    ) ?? false
  );
}

/**
 * Peels `ParenthesizedType`, `Readonly<X>`, `Partial<X>`, `Required<X>`
 * wrappers off a type node. `Partial`/`Required` record a forced-optionality
 * mode applied only to the direct members found once peeling stops —
 * matching TypeScript's own shallow semantics for those utility types.
 */
function peelWrappers(
  typeNode: ts.TypeNode,
  initialForcedMode: ForcedOptionalityMode | undefined,
): Readonly<{
  node: ts.TypeNode;
  forcedMode: ForcedOptionalityMode | undefined;
}> {
  let current = typeNode;
  let forcedMode = initialForcedMode;
  for (;;) {
    if (ts.isParenthesizedTypeNode(current)) {
      current = current.type;
      continue;
    }
    if (ts.isTypeReferenceNode(current) && ts.isIdentifier(current.typeName)) {
      const referenceName = current.typeName.text;
      const [firstTypeArgument] = current.typeArguments ?? [];
      if (referenceName === "Readonly" && firstTypeArgument !== undefined) {
        current = firstTypeArgument;
        continue;
      }
      if (referenceName === "Partial" && firstTypeArgument !== undefined) {
        current = firstTypeArgument;
        forcedMode = "optional";
        continue;
      }
      if (referenceName === "Required" && firstTypeArgument !== undefined) {
        current = firstTypeArgument;
        forcedMode = "required";
        continue;
      }
    }
    break;
  }
  return { node: current, forcedMode };
}

/** Required if required in EVERY constituent that has the key (union semantics: absence counts as optional). */
function mergeUnion(
  maps: readonly ReadonlyMap<string, boolean>[],
): Map<string, boolean> {
  const allKeys = new Set<string>();
  for (const map of maps) for (const key of map.keys()) allKeys.add(key);
  const result = new Map<string, boolean>();
  for (const key of allKeys) {
    const optional = maps.some((map) => map.get(key) ?? true);
    result.set(key, optional);
  }
  return result;
}

/** Required if required in ANY constituent (intersection semantics: all constraints apply simultaneously). */
function mergeIntersection(
  maps: readonly ReadonlyMap<string, boolean>[],
): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const map of maps) {
    for (const [key, optional] of map) {
      const existing = result.get(key);
      result.set(key, existing === undefined ? optional : existing && optional);
    }
  }
  return result;
}

/**
 * Required only if required in EVERY overload that declares the key at all;
 * overloads that don't declare an inline literal for this key are not
 * counted against it (unlike `mergeUnion`, which penalizes absence).
 */
function mergeOverloadAggregate(
  maps: readonly ReadonlyMap<string, boolean>[],
): Map<string, boolean> {
  const allKeys = new Set<string>();
  for (const map of maps) for (const key of map.keys()) allKeys.add(key);
  const result = new Map<string, boolean>();
  for (const key of allKeys) {
    const optional = maps.some((map) => map.has(key) && map.get(key) === true);
    result.set(key, optional);
  }
  return result;
}

function collectTypeElementMembers(
  elements: readonly ts.TypeElement[],
  forcedMode: ForcedOptionalityMode | undefined,
): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const element of elements) {
    if (ts.isIndexSignatureDeclaration(element)) {
      result.set("[index]", true);
      continue;
    }
    if (!ts.isPropertySignature(element) && !ts.isMethodSignature(element))
      continue;
    const name = getMemberName(element.name);
    if (name === undefined) continue;
    const localOptional = element.questionToken !== undefined;
    const ownOptional =
      forcedMode === "optional" ? true
      : forcedMode === "required" ? false
      : localOptional;
    result.set(name, ownOptional);
    const valueType =
      ts.isPropertySignature(element) ? element.type : undefined;
    if (valueType !== undefined) {
      const nested = resolveLocalMembers(valueType);
      for (const [childName, childOptional] of nested) {
        result.set(`${name}.${childName}`, ownOptional || childOptional);
      }
    }
  }
  return result;
}

function collectClassMembers(
  elements: readonly ts.ClassElement[],
): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const element of elements) {
    if (ts.isConstructorDeclaration(element)) continue;
    if (element.name !== undefined && ts.isPrivateIdentifier(element.name))
      continue;
    if (hasPrivateModifier(element)) continue;

    if (ts.isPropertyDeclaration(element)) {
      const name = getMemberName(element.name);
      if (name === undefined) continue;
      const localOptional = element.questionToken !== undefined;
      result.set(name, localOptional);
      if (element.type !== undefined) {
        const nested = resolveLocalMembers(element.type);
        for (const [childName, childOptional] of nested) {
          result.set(`${name}.${childName}`, localOptional || childOptional);
        }
      }
      continue;
    }
    if (
      ts.isGetAccessorDeclaration(element) ||
      ts.isSetAccessorDeclaration(element) ||
      ts.isMethodDeclaration(element)
    ) {
      const name = getMemberName(element.name);
      if (name === undefined) continue;
      const localOptional =
        ts.isMethodDeclaration(element) && element.questionToken !== undefined;
      result.set(name, localOptional);
    }
  }
  return result;
}

/**
 * Resolves the flattened (dotted-path) local member shape of a type node,
 * with NO ancestor context applied — the caller combines this with any
 * enclosing optionality. Returns an empty map for anything that isn't a
 * `TypeLiteral`, mapped type, intersection, or union (a plain reference such
 * as `Pick<X, "a">` contributes reference edges only, by design).
 */
function resolveLocalMembers(
  typeNode: ts.TypeNode,
): ReadonlyMap<string, boolean> {
  const { node: peeled, forcedMode } = peelWrappers(typeNode, undefined);
  if (ts.isTypeLiteralNode(peeled))
    return collectTypeElementMembers(peeled.members, forcedMode);
  if (ts.isMappedTypeNode(peeled)) return new Map([["[index]", true]]);
  if (ts.isIntersectionTypeNode(peeled)) {
    return mergeIntersection(
      peeled.types.map((constituent) => resolveLocalMembers(constituent)),
    );
  }
  if (ts.isUnionTypeNode(peeled)) {
    return mergeUnion(
      peeled.types.map((constituent) => resolveLocalMembers(constituent)),
    );
  }
  return new Map();
}

function toOptionalityMap(
  source: ReadonlyMap<string, boolean>,
): ReadonlyMap<string, MemberOptionality> {
  const result = new Map<string, MemberOptionality>();
  for (const [key, optional] of source)
    result.set(key, optional ? "optional" : "required");
  return result;
}

type Polarity = 1 | -1;

function flip(polarity: Polarity): Polarity {
  return polarity === 1 ? -1 : 1;
}

/**
 * Standard variance composition seeded at `+` (read) for every top-level
 * declaration and for every top-level function declaration's own boundary;
 * function/method parameter positions flip polarity, return positions keep
 * it; a type reference's type arguments inherit the current polarity
 * (documented approximation, §module doc). A declaration is HARD
 * contravariant — fail-eligible for `required-member-added` — iff reached at
 * `-` by at least one MANDATORY path: every field/parameter on that path is
 * required (honoring `Partial<>`/`Required<>` forced optionality the same
 * way member-optionality resolution does), and, where the path is rooted at
 * a top-level function declaration, an interface/class method, or a class
 * constructor, that callable itself is present in `existingCallableKeys`
 * (omit the argument, e.g. when walking the base snapshot itself, to treat
 * every callable as pre-existing — there is no "before" to gate against). A
 * declaration reached only through an optional field or only through a
 * brand-new function/method/constructor's parameter is walked
 * (so it can still surface further nested contravariant reachability) but
 * never added to the hard set, matching §module doc's gating note.
 */
function computeContravariantNames(
  namedDeclarations: ReadonlyMap<string, NamedDeclarationEntry>,
  functionDeclarations: readonly ts.FunctionDeclaration[],
  existingCallableKeys?: ReadonlySet<string>,
): ReadonlySet<string> {
  const contravariant = new Set<string>();
  const visited = new Set<string>();

  function markReachable(
    name: string,
    polarity: Polarity,
    mandatory: boolean,
  ): void {
    const visitKey = `${name}\0${polarity}\0${mandatory}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    if (polarity === -1 && mandatory) contravariant.add(name);
    const entry = namedDeclarations.get(name);
    if (entry === undefined) return;
    if (entry.kind === "type")
      walkTypeNode(entry.typeNode, polarity, mandatory);
    else if (entry.kind === "interface")
      walkTypeElements(entry.members, polarity, mandatory, undefined, name);
    else walkClassMembers(entry.members, polarity, mandatory, name);
  }

  function walkTypeNode(
    typeNode: ts.TypeNode,
    polarity: Polarity,
    mandatory: boolean,
  ): void {
    const { node: peeled, forcedMode } = peelWrappers(typeNode, undefined);
    if (ts.isTypeReferenceNode(peeled) && ts.isIdentifier(peeled.typeName)) {
      markReachable(peeled.typeName.text, polarity, mandatory);
      for (const typeArgument of peeled.typeArguments ?? []) {
        walkTypeNode(typeArgument, polarity, mandatory);
      }
      return;
    }
    if (ts.isTypeLiteralNode(peeled)) {
      walkTypeElements(peeled.members, polarity, mandatory, forcedMode);
      return;
    }
    if (ts.isFunctionTypeNode(peeled) || ts.isConstructorTypeNode(peeled)) {
      for (const parameter of peeled.parameters) {
        if (parameter.type !== undefined) {
          const parameterMandatory =
            mandatory && parameter.questionToken === undefined;
          walkTypeNode(parameter.type, flip(polarity), parameterMandatory);
        }
      }
      walkTypeNode(peeled.type, polarity, mandatory);
      return;
    }
    if (ts.isIntersectionTypeNode(peeled) || ts.isUnionTypeNode(peeled)) {
      for (const constituent of peeled.types)
        walkTypeNode(constituent, polarity, mandatory);
      return;
    }
    if (ts.isArrayTypeNode(peeled)) {
      walkTypeNode(peeled.elementType, polarity, mandatory);
      return;
    }
    if (ts.isTupleTypeNode(peeled)) {
      for (const element of peeled.elements) {
        walkTypeNode(
          ts.isNamedTupleMember(element) ? element.type : element,
          polarity,
          mandatory,
        );
      }
      return;
    }
    if (ts.isMappedTypeNode(peeled) && peeled.type !== undefined) {
      walkTypeNode(peeled.type, polarity, mandatory);
    }
  }

  /**
   * Resolves a member's own optionality, honoring an enclosing
   * `Partial<>`/`Required<>` override, then folds it into the incoming
   * mandatory chain (a member is only mandatory if it is itself required
   * AND everything above it on the path was mandatory too).
   */
  function memberMandatory(
    mandatory: boolean,
    forcedMode: ForcedOptionalityMode | undefined,
    questionToken: ts.QuestionToken | undefined,
  ): boolean {
    const optional =
      forcedMode === "optional" ? true
      : forcedMode === "required" ? false
      : questionToken !== undefined;
    return mandatory && !optional;
  }

  /**
   * A method/constructor parameter chain is only mandatory if the owning
   * callable (`ownerName.memberName`) already existed at the base ref —
   * `ownerName` is `undefined` for anonymous type literals (no callable to
   * gate on, so nothing is gated) and `existingCallableKeys` is `undefined`
   * when there is no "before" to gate against (building the base snapshot's
   * own inventory), matching the top-level-function gate below.
   */
  function calleeExisted(
    ownerName: string | undefined,
    memberName: string | undefined,
  ): boolean {
    return (
      existingCallableKeys === undefined ||
      ownerName === undefined ||
      memberName === undefined ||
      existingCallableKeys.has(`${ownerName}.${memberName}`)
    );
  }

  function walkTypeElements(
    elements: readonly ts.TypeElement[],
    polarity: Polarity,
    mandatory: boolean,
    forcedMode: ForcedOptionalityMode | undefined,
    ownerName?: string,
  ): void {
    for (const element of elements) {
      if (ts.isIndexSignatureDeclaration(element)) {
        walkTypeNode(element.type, polarity, mandatory);
        continue;
      }
      if (ts.isPropertySignature(element) && element.type !== undefined) {
        const childMandatory = memberMandatory(
          mandatory,
          forcedMode,
          element.questionToken,
        );
        walkTypeNode(element.type, polarity, childMandatory);
        continue;
      }
      if (ts.isMethodSignature(element)) {
        const childMandatory = memberMandatory(
          mandatory,
          forcedMode,
          element.questionToken,
        );
        const methodExisted = calleeExisted(
          ownerName,
          getMemberName(element.name),
        );
        for (const parameter of element.parameters) {
          if (parameter.type !== undefined) {
            const parameterMandatory =
              childMandatory &&
              methodExisted &&
              parameter.questionToken === undefined;
            walkTypeNode(parameter.type, flip(polarity), parameterMandatory);
          }
        }
        if (element.type !== undefined)
          walkTypeNode(element.type, polarity, childMandatory);
      }
    }
  }

  function walkClassMembers(
    members: readonly ts.ClassElement[],
    polarity: Polarity,
    mandatory: boolean,
    ownerName?: string,
  ): void {
    for (const member of members) {
      if (member.name !== undefined && ts.isPrivateIdentifier(member.name))
        continue;
      if (hasPrivateModifier(member)) continue;
      if (
        (ts.isPropertyDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)) &&
        member.type !== undefined
      ) {
        const memberOptional =
          ts.isPropertyDeclaration(member) &&
          member.questionToken !== undefined;
        walkTypeNode(member.type, polarity, mandatory && !memberOptional);
        continue;
      }
      if (ts.isConstructorDeclaration(member)) {
        const constructorExisted = calleeExisted(ownerName, "constructor");
        for (const parameter of member.parameters) {
          if (parameter.type !== undefined) {
            const parameterMandatory =
              mandatory &&
              constructorExisted &&
              parameter.questionToken === undefined;
            walkTypeNode(parameter.type, flip(polarity), parameterMandatory);
          }
        }
        continue;
      }
      if (ts.isMethodDeclaration(member)) {
        const childMandatory = mandatory && member.questionToken === undefined;
        const methodExisted = calleeExisted(
          ownerName,
          getMemberName(member.name),
        );
        for (const parameter of member.parameters) {
          if (parameter.type !== undefined) {
            const parameterMandatory =
              childMandatory &&
              methodExisted &&
              parameter.questionToken === undefined;
            walkTypeNode(parameter.type, flip(polarity), parameterMandatory);
          }
        }
        if (member.type !== undefined)
          walkTypeNode(member.type, polarity, childMandatory);
      }
    }
  }

  for (const name of namedDeclarations.keys()) markReachable(name, 1, true);
  for (const functionDeclaration of functionDeclarations) {
    const functionExisted =
      existingCallableKeys === undefined ||
      (functionDeclaration.name !== undefined &&
        existingCallableKeys.has(functionDeclaration.name.text));
    for (const parameter of functionDeclaration.parameters) {
      if (parameter.type !== undefined) {
        const parameterMandatory =
          functionExisted && parameter.questionToken === undefined;
        walkTypeNode(parameter.type, -1, parameterMandatory);
      }
    }
    if (functionDeclaration.type !== undefined)
      walkTypeNode(functionDeclaration.type, 1, true);
  }

  return contravariant;
}

function parameterKey(
  parameter: ts.ParameterDeclaration,
  index: number,
): string {
  return ts.isIdentifier(parameter.name) ? parameter.name.text : `arg${index}`;
}

/**
 * A callable signature shape common to top-level functions, interface method
 * signatures, class methods, and constructors — the only three members this
 * module needs from any of them.
 */
type CallableSignature = Readonly<{
  parameters: ts.NodeArray<ts.ParameterDeclaration>;
  returnType: ts.TypeNode | undefined;
}>;

/**
 * Inline object literals in parameter and return positions become their own
 * declaration entries, keyed `Name(paramName)` / `Name(=>)`. Overloads
 * sharing a key are aggregated into one entry (order-independent), so
 * api-extractor's per-overload rendering cannot forge a spurious removal or
 * duplicate-key collision. `callableGroups` covers top-level functions
 * (`funcName`), interface/class methods (`Owner.methodName`), and
 * constructors (`Owner.constructor`) uniformly — a required member added to
 * any of their inline parameter literals is inventoried the same way.
 *
 * A parameter-position entry is HARD contravariant under the same predicate
 * `computeContravariantNames` applies to named types (§module doc's gating
 * note): the owning callable must already exist in `existingCallableKeys`
 * (its key — a bare function name, or `Owner.method` / `Owner.constructor` —
 * present at the base ref), AND at least one overload carries the parameter
 * without a `?`. A brand-new function/method (its key entirely absent from
 * `existingCallableKeys`) or a brand-new optional parameter on an existing
 * one is therefore reported, not failed: no existing external caller can be
 * forced to construct a literal they were never required to pass in the
 * first place. `existingCallableKeys` is `undefined` when there is no
 * "before" to gate against (building the base snapshot's own inventory),
 * matching every other call site of this gate.
 */
function collectInlineLiteralEntries(
  callableGroups: ReadonlyMap<string, readonly CallableSignature[]>,
  existingCallableKeys?: ReadonlySet<string>,
): Map<string, DeclarationRecord> {
  const entries = new Map<string, DeclarationRecord>();

  for (const [callableName, overloads] of callableGroups) {
    const callableExisted =
      existingCallableKeys === undefined ||
      existingCallableKeys.has(callableName);
    const parameterMaps = new Map<
      string,
      {
        readonly members: ReadonlyMap<string, boolean>;
        readonly mandatory: boolean;
      }[]
    >();
    const returnMaps: ReadonlyMap<string, boolean>[] = [];

    for (const overload of overloads) {
      overload.parameters.forEach((parameter, index) => {
        if (parameter.type === undefined) return;
        const localMembers = resolveLocalMembers(parameter.type);
        if (localMembers.size === 0) return;
        const key = parameterKey(parameter, index);
        const existing = parameterMaps.get(key) ?? [];
        existing.push({
          members: localMembers,
          mandatory: callableExisted && parameter.questionToken === undefined,
        });
        parameterMaps.set(key, existing);
      });
      if (overload.returnType !== undefined) {
        const localMembers = resolveLocalMembers(overload.returnType);
        if (localMembers.size > 0) returnMaps.push(localMembers);
      }
    }

    for (const [parameterName, occurrences] of parameterMaps) {
      const maps = occurrences.map((occurrence) => occurrence.members);
      const merged = mergeOverloadAggregate(maps);
      if (merged.size === 0) continue;
      const key = `${callableName}(${parameterName})`;
      entries.set(key, {
        name: key,
        kind: "inline-literal",
        contravariant: occurrences.some((occurrence) => occurrence.mandatory),
        members: toOptionalityMap(merged),
      });
    }
    if (returnMaps.length > 0) {
      const merged = mergeOverloadAggregate(returnMaps);
      if (merged.size > 0) {
        const key = `${callableName}(=>)`;
        entries.set(key, {
          name: key,
          kind: "inline-literal",
          contravariant: false,
          members: toOptionalityMap(merged),
        });
      }
    }
  }

  return entries;
}

function pushCallableSignature(
  groups: Map<string, CallableSignature[]>,
  key: string,
  signature: CallableSignature,
): void {
  const existing = groups.get(key) ?? [];
  existing.push(signature);
  groups.set(key, existing);
}

/**
 * Groups every interface method signature by `${interfaceName}.${methodName}`
 * so overloads aggregate the same way top-level function overloads do.
 */
function collectInterfaceMethodCallables(
  namedDeclarations: ReadonlyMap<string, NamedDeclarationEntry>,
): Map<string, CallableSignature[]> {
  const groups = new Map<string, CallableSignature[]>();
  for (const [declarationName, entry] of namedDeclarations) {
    if (entry.kind !== "interface") continue;
    for (const member of entry.members) {
      if (!ts.isMethodSignature(member)) continue;
      const methodName = getMemberName(member.name);
      if (methodName === undefined) continue;
      pushCallableSignature(groups, `${declarationName}.${methodName}`, {
        parameters: member.parameters,
        returnType: member.type,
      });
    }
  }
  return groups;
}

/**
 * Groups every class method and constructor by `${className}.${methodName}`
 * / `${className}.constructor`, excluding private members exactly as
 * `collectClassMembers` does.
 */
function collectClassMethodCallables(
  namedDeclarations: ReadonlyMap<string, NamedDeclarationEntry>,
): Map<string, CallableSignature[]> {
  const groups = new Map<string, CallableSignature[]>();
  for (const [declarationName, entry] of namedDeclarations) {
    if (entry.kind !== "class") continue;
    for (const member of entry.members) {
      if (member.name !== undefined && ts.isPrivateIdentifier(member.name))
        continue;
      if (hasPrivateModifier(member)) continue;
      if (ts.isConstructorDeclaration(member)) {
        pushCallableSignature(groups, `${declarationName}.constructor`, {
          parameters: member.parameters,
          returnType: undefined,
        });
        continue;
      }
      if (!ts.isMethodDeclaration(member)) continue;
      const methodName = getMemberName(member.name);
      if (methodName === undefined) continue;
      pushCallableSignature(groups, `${declarationName}.${methodName}`, {
        parameters: member.parameters,
        returnType: member.type,
      });
    }
  }
  return groups;
}

type ParsedDeclarations = Readonly<{
  namedDeclarations: ReadonlyMap<string, NamedDeclarationEntry>;
  functionDeclarations: readonly ts.FunctionDeclaration[];
}>;

/**
 * The one place a report body's statements are sorted into named
 * declarations (type/interface/class) versus top-level function
 * declarations. Both `buildSurfaceInventory` and
 * `collectExistingCallableKeys` consume this single parse rather than each
 * re-walking `sourceFile.statements`, so the two can never disagree about
 * what counts as a declaration.
 */
function parseDeclarations(sourceFile: ts.SourceFile): ParsedDeclarations {
  const namedDeclarations = new Map<string, NamedDeclarationEntry>();
  const functionDeclarations: ts.FunctionDeclaration[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      namedDeclarations.set(statement.name.text, {
        kind: "type",
        typeNode: statement.type,
      });
    } else if (ts.isInterfaceDeclaration(statement)) {
      namedDeclarations.set(statement.name.text, {
        kind: "interface",
        members: statement.members,
      });
    } else if (
      ts.isClassDeclaration(statement) &&
      statement.name !== undefined
    ) {
      namedDeclarations.set(statement.name.text, {
        kind: "class",
        members: statement.members,
      });
    } else if (
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined
    ) {
      functionDeclarations.push(statement);
    }
  }

  return { namedDeclarations, functionDeclarations };
}

function parseReportSource(body: string, entrypoint: string): ts.SourceFile {
  return ts.createSourceFile(
    `${entrypoint}.ts`,
    body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/**
 * Resolves every callable KEY that already exists in a report body — a bare
 * function name for a top-level function, `Owner.method` for an interface or
 * class method, `Owner.constructor` for a class constructor — the exact key
 * space `collectInterfaceMethodCallables`/`collectClassMethodCallables`/the
 * top-level `functionCallables` map use. Used to resolve, from the BASE
 * snapshot, which callables already existed BEFORE building the head
 * inventory, so a brand-new function/method's mandatory parameter never
 * contributes HARD contravariant reachability whether that parameter is a
 * named type or an inline object literal (§module doc's gating note; this is
 * the one predicate both `computeContravariantNames` and
 * `collectInlineLiteralEntries` consume, rather than each re-deriving its own
 * notion of "callable existed at base"). Supersedes the narrower
 * function-name-only `collectTopLevelFunctionNames`.
 */
export function collectExistingCallableKeys(
  body: string,
  entrypoint: string,
): ReadonlySet<string> {
  const { namedDeclarations, functionDeclarations } = parseDeclarations(
    parseReportSource(body, entrypoint),
  );
  const keys = new Set<string>();
  for (const functionDeclaration of functionDeclarations) {
    if (functionDeclaration.name !== undefined) {
      keys.add(functionDeclaration.name.text);
    }
  }
  for (const key of collectInterfaceMethodCallables(namedDeclarations).keys())
    keys.add(key);
  for (const key of collectClassMethodCallables(namedDeclarations).keys())
    keys.add(key);
  return keys;
}

/**
 * Builds the canonical `(declaration → member path → optional?)` inventory
 * for one report body. Walks `TypeAliasDeclaration`, `InterfaceDeclaration`,
 * and `ClassDeclaration` statements — INCLUDING unexported ones, since
 * api-extractor renders forgotten exports without `export` when a published
 * type references them. Refuses if the body yields zero declarations, which
 * is the fence-format-change tripwire. `existingCallableKeys`, when given,
 * gates HARD contravariant reachability — for both named-type parameters
 * (`computeContravariantNames`) and inline-literal parameters
 * (`collectInlineLiteralEntries`) — to only those callables present in it
 * (§module doc); omit it when there is no "before" to gate against (e.g.
 * building the base snapshot's own inventory).
 */
export function buildSurfaceInventory(
  body: string,
  entrypoint: string,
  existingCallableKeys?: ReadonlySet<string>,
): SurfaceInventory {
  const sourceFile = parseReportSource(body, entrypoint);
  const { namedDeclarations, functionDeclarations } =
    parseDeclarations(sourceFile);
  const functionCallables = new Map<string, CallableSignature[]>();
  for (const functionDeclaration of functionDeclarations) {
    if (functionDeclaration.name === undefined) continue;
    pushCallableSignature(functionCallables, functionDeclaration.name.text, {
      parameters: functionDeclaration.parameters,
      returnType: functionDeclaration.type,
    });
  }

  const contravariantNames = computeContravariantNames(
    namedDeclarations,
    functionDeclarations,
    existingCallableKeys,
  );

  const inventory = new Map<string, DeclarationRecord>();
  for (const [name, entry] of namedDeclarations) {
    const localMembers =
      entry.kind === "type" ? resolveLocalMembers(entry.typeNode)
      : entry.kind === "interface" ?
        collectTypeElementMembers(entry.members, undefined)
      : collectClassMembers(entry.members);
    inventory.set(name, {
      name,
      kind: entry.kind,
      contravariant: contravariantNames.has(name),
      members: toOptionalityMap(localMembers),
    });
  }

  const callableGroups = new Map<string, CallableSignature[]>([
    ...functionCallables,
    ...collectInterfaceMethodCallables(namedDeclarations),
    ...collectClassMethodCallables(namedDeclarations),
  ]);
  for (const [key, record] of collectInlineLiteralEntries(
    callableGroups,
    existingCallableKeys,
  )) {
    inventory.set(key, record);
  }

  if (inventory.size === 0) {
    throw new ApiSurfaceParseError(
      `API report body for ${entrypoint} yielded zero declarations; the report format may have changed.`,
    );
  }

  return inventory;
}

function requiredMemberAddedMessage(
  entrypoint: string,
  declaration: string,
  member: string,
): string {
  return (
    `etc/${entrypoint}: ${declaration} gained REQUIRED member \`${member}\`. ` +
    "External consumers author this type, so this is a breaking change. Make it " +
    "optional at the boundary and required after resolution (see `resolveRecursiveTraversal`), " +
    "or add an entry to etc/api-surface-exceptions.json with a reason and an issue."
  );
}

function requiredMemberAddedReportMessage(
  entrypoint: string,
  declaration: string,
  member: string,
): string {
  return (
    `report: etc/${entrypoint}: ${declaration} gained REQUIRED member \`${member}\` ` +
    "in a return-only position (not breaking)."
  );
}

function memberRemovedMessage(
  entrypoint: string,
  declaration: string,
  member: string,
): string {
  return (
    `etc/${entrypoint}: ${declaration} lost member \`${member}\`. Consumers read this ` +
    "declaration, so this is a breaking change. Restore the member, or add an entry to " +
    "etc/api-surface-exceptions.json with a reason and an issue."
  );
}

function optionalityTightenedMessage(
  entrypoint: string,
  declaration: string,
  member: string,
): string {
  return (
    `etc/${entrypoint}: ${declaration} tightened member \`${member}\` from optional to REQUIRED. ` +
    "External consumers author this type, so this is a breaking change. Make it " +
    "optional at the boundary and required after resolution (see `resolveRecursiveTraversal`), " +
    "or add an entry to etc/api-surface-exceptions.json with a reason and an issue."
  );
}

/**
 * The three I10/I11 breaking-change predicates, and only three (ruling OQ4):
 * required-member-added (contravariant-gated fail, otherwise a report),
 * member-removed (fails on any declaration), and optionality-tightened
 * (always fails). A declaration absent at head has every base member
 * reported as removed.
 */
export function compareSurfaceInventories(
  args: Readonly<{
    entrypoint: string;
    base: SurfaceInventory;
    head: SurfaceInventory;
  }>,
): readonly SurfaceFinding[] {
  const { entrypoint, base, head } = args;
  const findings: SurfaceFinding[] = [];
  const declarationNames = new Set<string>([...base.keys(), ...head.keys()]);

  for (const declarationName of declarationNames) {
    const baseDeclaration = base.get(declarationName);
    const headDeclaration = head.get(declarationName);

    if (headDeclaration === undefined) {
      if (baseDeclaration !== undefined) {
        for (const member of baseDeclaration.members.keys()) {
          findings.push({
            entrypoint,
            declaration: declarationName,
            member,
            kind: "member-removed",
            severity: "fail",
            message: memberRemovedMessage(entrypoint, declarationName, member),
          });
        }
      }
      continue;
    }

    const baseMembers =
      baseDeclaration?.members ?? new Map<string, MemberOptionality>();

    for (const [member, headOptionality] of headDeclaration.members) {
      if (headOptionality !== "required") continue;
      const baseOptionality = baseMembers.get(member);
      if (baseOptionality === "optional") {
        findings.push({
          entrypoint,
          declaration: declarationName,
          member,
          kind: "optionality-tightened",
          severity: "fail",
          message: optionalityTightenedMessage(
            entrypoint,
            declarationName,
            member,
          ),
        });
      } else if (baseOptionality === undefined) {
        const severity: FindingSeverity =
          headDeclaration.contravariant ? "fail" : "report";
        findings.push({
          entrypoint,
          declaration: declarationName,
          member,
          kind: "required-member-added",
          severity,
          message:
            severity === "fail" ?
              requiredMemberAddedMessage(entrypoint, declarationName, member)
            : requiredMemberAddedReportMessage(
                entrypoint,
                declarationName,
                member,
              ),
        });
      }
    }

    for (const member of baseMembers.keys()) {
      if (!headDeclaration.members.has(member)) {
        findings.push({
          entrypoint,
          declaration: declarationName,
          member,
          kind: "member-removed",
          severity: "fail",
          message: memberRemovedMessage(entrypoint, declarationName, member),
        });
      }
    }
  }

  return findings;
}

const FINDING_KINDS: ReadonlySet<FindingKind> = new Set<FindingKind>([
  "required-member-added",
  "member-removed",
  "optionality-tightened",
]);
const ISSUE_PATTERN =
  /^(#\d+|https:\/\/github\.com\/nicia-ai\/typegraph\/issues\/\d+)$/;
const REFUSAL_PATTERN = /^[A-Z][A-Z0-9_]+$/;
const REQUIRED_EXCEPTION_ENTRY_FIELDS = [
  "entrypoint",
  "declaration",
  "member",
  "kind",
  "reason",
  "issue",
] as const;
const EXCEPTION_ENTRY_FIELDS = new Set<string>([
  ...REQUIRED_EXCEPTION_ENTRY_FIELDS,
  "refusal",
]);

function assertNonEmptyTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ApiSurfaceLedgerError(`Ledger ${label} must not be empty.`);
  }
  return trimmed;
}

/**
 * Parses `etc/api-surface-exceptions.json`. Rejects a non-array root; any
 * unknown or missing field; a `kind` outside the three predicate literals;
 * an empty-after-trim `entrypoint`/`declaration`/`member`/`reason`; a
 * blanket `member: "*"` (or any `member` containing `*`) — exemptions must
 * name one member, never a type or a file; a malformed `issue` or
 * `refusal`; and a duplicate `(entrypoint, declaration, member, kind)`
 * tuple.
 */
export function parseExceptionsLedger(
  source: string,
): readonly ExceptionEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ApiSurfaceLedgerError(
      "etc/api-surface-exceptions.json is not valid JSON.",
      {
        cause: error,
      },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ApiSurfaceLedgerError(
      "etc/api-surface-exceptions.json must have an array root.",
    );
  }

  const entries: ExceptionEntry[] = [];
  const seenTuples = new Set<string>();

  for (const [index, rawEntry] of parsed.entries()) {
    if (
      typeof rawEntry !== "object" ||
      rawEntry === null ||
      Array.isArray(rawEntry)
    ) {
      throw new ApiSurfaceLedgerError(
        `Ledger entry ${index} must be an object.`,
      );
    }
    const record = rawEntry as Record<string, unknown>;

    for (const key of Object.keys(record)) {
      if (!EXCEPTION_ENTRY_FIELDS.has(key)) {
        throw new ApiSurfaceLedgerError(
          `Ledger entry ${index} has an unknown field "${key}".`,
        );
      }
    }
    for (const field of REQUIRED_EXCEPTION_ENTRY_FIELDS) {
      if (typeof record[field] !== "string") {
        throw new ApiSurfaceLedgerError(
          `Ledger entry ${index} is missing field "${field}".`,
        );
      }
    }

    const entrypoint = assertNonEmptyTrimmed(
      record["entrypoint"] as string,
      `entry ${index} field "entrypoint"`,
    );
    const declaration = assertNonEmptyTrimmed(
      record["declaration"] as string,
      `entry ${index} field "declaration"`,
    );
    const member = assertNonEmptyTrimmed(
      record["member"] as string,
      `entry ${index} field "member"`,
    );
    const reason = assertNonEmptyTrimmed(
      record["reason"] as string,
      `entry ${index} field "reason"`,
    );
    const issue = record["issue"] as string;
    const kind = record["kind"] as string;
    const refusal = record["refusal"];

    if (!FINDING_KINDS.has(kind as FindingKind)) {
      throw new ApiSurfaceLedgerError(
        `Ledger entry ${index} has an unsupported "kind" value "${kind}".`,
      );
    }
    if (member === "*" || member.includes("*")) {
      throw new ApiSurfaceLedgerError(
        `Ledger entry ${index} has a blanket exemption in "member" ("${member}"); ` +
          "an exemption must name exactly one member.",
      );
    }
    if (!ISSUE_PATTERN.test(issue)) {
      throw new ApiSurfaceLedgerError(
        `Ledger entry ${index} has a malformed "issue" value "${issue}".`,
      );
    }
    if (
      refusal !== undefined &&
      (typeof refusal !== "string" || !REFUSAL_PATTERN.test(refusal))
    ) {
      throw new ApiSurfaceLedgerError(
        `Ledger entry ${index} has a malformed "refusal" code "${JSON.stringify(refusal)}".`,
      );
    }

    const tupleKey = `${entrypoint}\0${declaration}\0${member}\0${kind}`;
    if (seenTuples.has(tupleKey)) {
      throw new ApiSurfaceLedgerError(
        `Ledger has a duplicate entry for (${entrypoint}, ${declaration}, ${member}, ${kind}).`,
      );
    }
    seenTuples.add(tupleKey);

    entries.push({
      entrypoint,
      declaration,
      member,
      kind: kind as FindingKind,
      reason,
      issue,
      ...(typeof refusal === "string" ? { refusal } : {}),
    });
  }

  return entries;
}

/**
 * Checks the ledger BOTH directions against the current head snapshots: a
 * `required-member-added` / `optionality-tightened` entry must name a
 * member that exists in head and is required there; a `member-removed`
 * entry must name a member absent from head; an unknown entrypoint or
 * declaration is itself an issue. A stale entry is a refusal, not a
 * silently-ignored no-op.
 */
export function validateExceptionsLedger(
  entries: readonly ExceptionEntry[],
  inventories: ReadonlyMap<string, SurfaceInventory>,
): readonly LedgerIssue[] {
  const issues: LedgerIssue[] = [];
  for (const entry of entries) {
    const inventory = inventories.get(entry.entrypoint);
    if (inventory === undefined) {
      issues.push({
        entry,
        problem: `Unknown entrypoint "${entry.entrypoint}".`,
      });
      continue;
    }
    const declaration = inventory.get(entry.declaration);
    if (declaration === undefined) {
      issues.push({
        entry,
        problem: `Unknown declaration "${entry.declaration}" in ${entry.entrypoint}.`,
      });
      continue;
    }
    if (entry.kind === "member-removed") {
      if (declaration.members.has(entry.member)) {
        issues.push({
          entry,
          problem: `Member \`${entry.member}\` is still present on ${entry.declaration}; it was not removed.`,
        });
      }
      continue;
    }
    const optionality = declaration.members.get(entry.member);
    if (optionality !== "required") {
      issues.push({
        entry,
        problem: `Member \`${entry.member}\` on ${entry.declaration} is not required in the current head snapshot.`,
      });
    }
  }
  return issues;
}

/**
 * Resolves the last published tag matching `tagPattern`, using git's own
 * version sort (never a shell `sort -V`, which is absent on BSD `sort` and
 * would be a second, competing owner of the ordering). Refuses — never
 * passes vacuously — when no tag matches.
 */
export function resolveBaseTag(repoRoot: string, tagPattern: string): string {
  const output = execFileSync(
    "git",
    ["-C", repoRoot, "tag", "--list", tagPattern, "--sort=-v:refname"],
    { encoding: "utf8" },
  );
  const firstTag = output.split("\n").find((line) => line.trim().length > 0);
  if (firstTag === undefined) {
    throw new UnresolvableBaseRefError(
      `Cannot resolve an API-surface base ref: no tag matches ${tagPattern}. Fetch the ` +
        `published tags (git fetch --no-tags --depth=1 origin '+refs/tags/${tagPattern}:refs/tags/${tagPattern}') ` +
        "and re-run; this check never passes without a base.",
    );
  }
  return firstTag;
}

function readGitBlob(
  repoRoot: string,
  ref: string,
  relativePath: string,
): string | undefined {
  try {
    return execFileSync(
      "git",
      ["-C", repoRoot, "show", `${ref}:${relativePath}`],
      {
        encoding: "utf8",
      },
    );
  } catch {
    return undefined;
  }
}

function toPosixRelativePath(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

/**
 * The pull-request leg: additionally compares head against
 * `git merge-base HEAD origin/<GITHUB_BASE_REF>` and prints `merge-base
 * report: …` lines. Never affects `failed` — an unresolvable merge-base
 * prints a note and returns rather than refusing.
 */
function appendMergeBaseReport(
  repoRoot: string,
  relativeEtcDir: string,
  headReportFiles: readonly string[],
  headInventories: ReadonlyMap<string, SurfaceInventory>,
  env: NodeJS.ProcessEnv,
  reportLines: string[],
): void {
  if (env["GITHUB_EVENT_NAME"] !== "pull_request") return;
  const baseRef = env["GITHUB_BASE_REF"];
  if (baseRef === undefined || baseRef.trim().length === 0) return;

  let mergeBaseSha: string;
  try {
    mergeBaseSha = execFileSync(
      "git",
      ["-C", repoRoot, "merge-base", "HEAD", `origin/${baseRef}`],
      { encoding: "utf8" },
    ).trim();
  } catch {
    reportLines.push(
      `merge-base report: unable to resolve a merge-base with origin/${baseRef}; skipping the pull-request comparison.`,
    );
    return;
  }

  for (const reportFile of headReportFiles) {
    const mergeBaseSource = readGitBlob(
      repoRoot,
      mergeBaseSha,
      `${relativeEtcDir}/${reportFile}`,
    );
    if (mergeBaseSource === undefined) continue;
    const headInventory = headInventories.get(reportFile);
    if (headInventory === undefined) continue;
    const mergeBaseInventory = buildSurfaceInventory(
      extractApiReportBody(mergeBaseSource),
      reportFile,
    );
    const findings = compareSurfaceInventories({
      entrypoint: reportFile,
      base: mergeBaseInventory,
      head: headInventory,
    });
    for (const finding of findings) {
      reportLines.push(`merge-base report: ${finding.message}`);
    }
  }
}

/**
 * Runs the full check: resolves the base tag, compares every
 * `etc/*.api.md` snapshot found under `<packageDir>/etc` against the base
 * tag's snapshot, applies the exceptions ledger, and (on the pull-request
 * leg) reports the merge-base diff. Throws `UnresolvableBaseRefError` /
 * `ApiSurfaceParseError` / `ApiSurfaceLedgerError` on any condition that
 * would otherwise let the check pass without a real comparison.
 */
export function runApiSurfaceCompat(
  options: Readonly<{ packageDir: string; env?: NodeJS.ProcessEnv }>,
): CompatRunResult {
  const packageDir = path.resolve(options.packageDir);
  const env = options.env ?? process.env;
  const repoRoot = execFileSync(
    "git",
    ["-C", packageDir, "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
    },
  ).trim();
  const etcDir = path.join(packageDir, "etc");
  const relativeEtcDir = toPosixRelativePath(repoRoot, etcDir);

  const headReportFiles = readdirSync(etcDir)
    .filter((file) => file.endsWith(".api.md"))
    .toSorted();
  if (headReportFiles.length === 0) {
    throw new ApiSurfaceParseError(
      `No API report snapshots found in ${etcDir}. Run pnpm test:api-report first.`,
    );
  }

  const baseTag = resolveBaseTag(repoRoot, BASE_TAG_PATTERN);

  const headInventories = new Map<string, SurfaceInventory>();
  const allFindings: SurfaceFinding[] = [];
  const reportLines: string[] = [];
  let anyBaseSnapshotResolved = false;

  for (const reportFile of headReportFiles) {
    const headSource = readFileSync(path.join(etcDir, reportFile), "utf8");
    const baseSource = readGitBlob(
      repoRoot,
      baseTag,
      `${relativeEtcDir}/${reportFile}`,
    );

    // Resolve which callables (top-level functions, interface/class methods,
    // constructors) already existed at the base ref BEFORE building the head
    // inventory, so a brand-new callable's mandatory parameter never
    // contributes HARD contravariant reachability (§module doc's gating
    // note) — a new entrypoint has no base snapshot at all, so every head
    // callable is new by definition.
    const existingCallableKeys =
      baseSource === undefined ?
        new Set<string>()
      : collectExistingCallableKeys(
          extractApiReportBody(baseSource),
          reportFile,
        );
    const headInventory = buildSurfaceInventory(
      extractApiReportBody(headSource),
      reportFile,
      existingCallableKeys,
    );
    headInventories.set(reportFile, headInventory);

    if (baseSource === undefined) {
      reportLines.push(
        `report: etc/${reportFile}: new entrypoint (no snapshot at ${baseTag}); surface not compared.`,
      );
      continue;
    }
    anyBaseSnapshotResolved = true;
    const baseInventory = buildSurfaceInventory(
      extractApiReportBody(baseSource),
      reportFile,
    );
    const findings = compareSurfaceInventories({
      entrypoint: reportFile,
      base: baseInventory,
      head: headInventory,
    });
    allFindings.push(...findings);
  }

  if (!anyBaseSnapshotResolved) {
    throw new ApiSurfaceParseError(
      `Base ref ${baseTag} has no API report snapshots at ${baseTag}:${relativeEtcDir}.`,
    );
  }

  const ledgerPath = path.join(packageDir, EXCEPTIONS_LEDGER_RELATIVE_PATH);
  const ledgerEntries = parseExceptionsLedger(readFileSync(ledgerPath, "utf8"));
  const ledgerIssues = validateExceptionsLedger(ledgerEntries, headInventories);
  if (ledgerIssues.length > 0) {
    const details = ledgerIssues
      .map(
        (issue) =>
          `(${issue.entry.entrypoint}, ${issue.entry.declaration}, ${issue.entry.member}, ${issue.entry.kind}): ${issue.problem}`,
      )
      .join("; ");
    throw new ApiSurfaceLedgerError(
      `etc/api-surface-exceptions.json has stale entries that no longer match the API surface: ${details}`,
    );
  }

  const resolvedFindings = allFindings.map((finding) => {
    if (finding.severity !== "fail") return finding;
    const exception = ledgerEntries.find(
      (entry) =>
        entry.entrypoint === finding.entrypoint &&
        entry.declaration === finding.declaration &&
        entry.member === finding.member &&
        entry.kind === finding.kind,
    );
    if (exception === undefined) return finding;
    const exempted: SurfaceFinding = {
      ...finding,
      severity: "exempted",
      message: `exempted: ${finding.message} (etc/api-surface-exceptions.json: ${exception.reason} ${exception.issue})`,
    };
    return exempted;
  });

  for (const finding of resolvedFindings) {
    if (finding.severity === "report" || finding.severity === "exempted") {
      reportLines.push(finding.message);
    }
  }

  appendMergeBaseReport(
    repoRoot,
    relativeEtcDir,
    headReportFiles,
    headInventories,
    env,
    reportLines,
  );

  const failed = resolvedFindings.some(
    (finding) => finding.severity === "fail",
  );
  return { findings: resolvedFindings, reportLines, failed };
}

function parsePackageDirArgument(argv: readonly string[]): string | undefined {
  const flagIndex = argv.indexOf("--package-dir");
  if (flagIndex === -1) return undefined;
  return argv[flagIndex + 1];
}

function main(): void {
  const packageDirArgument = parsePackageDirArgument(process.argv.slice(2));
  const packageDir =
    packageDirArgument === undefined ?
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    : path.resolve(packageDirArgument);

  try {
    const result = runApiSurfaceCompat({ packageDir, env: process.env });
    for (const finding of result.findings) {
      if (finding.severity === "fail") console.error(finding.message);
    }
    for (const line of result.reportLines) console.log(line);
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
