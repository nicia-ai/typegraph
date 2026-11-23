/**
 * The checker-backed scans behind `tests/operation-scope-ratchet.test.ts`.
 *
 * One implementation serves both the repository and the fixtures: a fixture is
 * a virtual module placed inside `src/store` of the SAME program the
 * repository is scanned in, and the test runs the same exported functions
 * over it. There is no second walk to drift from this one.
 *
 * Both scans are keyed on types, not names. The forge scan identifies the
 * operation brand by its property — the module-private unique symbol declared
 * in `src/store/operation-scope.ts` — so every spelling of a branded type (an
 * alias, a qualified name, an `import("…")` type, `ReturnType<typeof mint>`,
 * `Parameters<typeof consumer>[n]`, an indexed access) resolves to the same
 * check, and so does a spelling that names no brand at all (`as never`,
 * `as any`, a generic instantiated from its return context).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { GRAPH_BACKEND_MEMBER_CLASSES } from "../../src/backend/member-classes";

export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SOURCE_ROOT = path.join(PACKAGE_ROOT, "src");
const STORE_ROOT = path.join(SOURCE_ROOT, "store");
export const MINT_MODULE = "src/store/operation-scope.ts";

/** The transitional whole-transaction shim, counted by its own ratchet. */
export const LEGACY_SHIM_NAME = "legacyTransactionOperation";

/** The module-private unique symbol that keys the brand property. */
const BRAND_KEY_NAME = "OPERATION_SCOPED";

/** The module-private unique symbol that keys the Store transaction's engine phantom. */
const ENGINE_PHANTOM_KEY_NAME = "ENGINE_TRANSACTION";

function relativeToPackage(file: string): string {
  return path.relative(PACKAGE_ROOT, file).replaceAll(path.sep, "/");
}

// ---------------------------------------------------------------------------
// The program
// ---------------------------------------------------------------------------

export type ScanProgram = Readonly<{
  program: ts.Program;
  checker: ts.TypeChecker;
  /** Every `src` module from tsconfig, absolute paths, fixtures excluded. */
  sourceFiles: readonly string[];
}>;

/**
 * A program over every `src` module in tsconfig plus `virtualFiles` (paths
 * relative to the package root, contents in memory). The virtual files are
 * fixtures: they resolve imports exactly as a real module at that path would.
 */
export function createScanProgram(
  virtualFiles: Readonly<Record<string, string>>,
): ScanProgram {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(PACKAGE_ROOT, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  if (parsed === undefined) throw new Error("tsconfig.json did not parse");
  const sourceFiles = parsed.fileNames
    .map((file) => path.resolve(file))
    .filter((file) => file.startsWith(SOURCE_ROOT + path.sep));

  const virtual = new Map(
    Object.entries(virtualFiles).map(([relative, text]) => [
      path.join(PACKAGE_ROOT, relative),
      text,
    ]),
  );
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => virtual.get(path.resolve(file)) ?? readFile(file);
  host.fileExists = (file) =>
    virtual.has(path.resolve(file)) || fileExists(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) => {
    const text = virtual.get(path.resolve(file));
    return text === undefined ?
        getSourceFile(file, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(file, text, languageVersion, true);
  };

  const program = ts.createProgram({
    rootNames: [...sourceFiles, ...virtual.keys()],
    options,
    host,
  });
  return { program, checker: program.getTypeChecker(), sourceFiles };
}

function requireSourceFile(scan: ScanProgram, relative: string): ts.SourceFile {
  const source = scan.program.getSourceFile(path.join(PACKAGE_ROOT, relative));
  if (source === undefined) throw new Error(`${relative} is not in program`);
  return source;
}

/** Error diagnostics in `relative`, as `[line, code]` pairs (1-based lines). */
export function errorDiagnostics(
  scan: ScanProgram,
  relative: string,
): readonly (readonly [number, number])[] {
  const source = requireSourceFile(scan, relative);
  return [
    ...scan.program.getSyntacticDiagnostics(source),
    ...scan.program.getSemanticDiagnostics(source),
  ]
    .filter(
      (diagnostic) =>
        diagnostic.category === ts.DiagnosticCategory.Error &&
        diagnostic.start !== undefined,
    )
    .map(
      (diagnostic) =>
        [
          source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
          diagnostic.code,
        ] as const,
    );
}

/** The name of the function declaration enclosing `position`, or `<module>`. */
function functionAtPosition(source: ts.SourceFile, position: number): string {
  let name = "<module>";
  const visit = (node: ts.Node): void => {
    if (position < node.getStart(source) || position >= node.getEnd()) return;
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      name = node.name.text;
    }
    ts.forEachChild(node, visit);
  };
  // A comment before a function's first token belongs to that function.
  ts.forEachChild(source, (statement) => {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      position >= statement.getFullStart() &&
      position < statement.getStart(source)
    ) {
      name = statement.name.text;
    }
  });
  visit(source);
  return name;
}

// ---------------------------------------------------------------------------
// The brand, by its property
// ---------------------------------------------------------------------------

/**
 * Where the brand key is declared, and how: the brand is unforgeable by
 * construction against every route that would have to SPELL its key (an
 * object literal, a computed property, `satisfies`), which holds only while
 * the key is declared-only (no runtime value) and not exported.
 */
export function brandKeyDeclaration(scan: ScanProgram): Readonly<{
  declaredOnly: boolean;
  exported: boolean;
}> {
  const mint = requireSourceFile(scan, MINT_MODULE);
  const statement = mint.statements.find(
    (candidate): candidate is ts.VariableStatement =>
      ts.isVariableStatement(candidate) &&
      candidate.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === BRAND_KEY_NAME,
      ),
  );
  if (statement === undefined) {
    throw new Error(`${BRAND_KEY_NAME} is not declared in ${MINT_MODULE}`);
  }
  // Judged from the module's own syntax: a module augmentation elsewhere
  // that tries to re-export the key is a type error, but the checker still
  // lists the name among the module's exports.
  const modifiers = ts.getModifiers(statement) ?? [];
  const reExported = mint.statements.some(
    (candidate) =>
      ts.isExportAssignment(candidate) ||
      (ts.isExportDeclaration(candidate) &&
        (candidate.exportClause === undefined ||
          ts.isNamespaceExport(candidate.exportClause) ||
          candidate.exportClause.elements.some(
            (element) =>
              (element.propertyName ?? element.name).getText(mint) ===
              BRAND_KEY_NAME,
          ))),
  );
  return {
    declaredOnly: modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
    ),
    exported:
      reExported ||
      modifiers.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ),
  };
}

/** The escaped property name the brand key produces on a branded type. */
function brandPropertyName(scan: ScanProgram): ts.__String {
  const mint = requireSourceFile(scan, MINT_MODULE);
  const alias = mint.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "OperationScoped",
  );
  if (alias === undefined) throw new Error("OperationScoped not found");
  const brandType = scan.checker.getTypeFromTypeNode(alias.type);
  const brand = scan.checker
    .getPropertiesOfType(brandType)
    .find(
      (property) =>
        property.declarations?.some(
          (declaration) =>
            declaration.getSourceFile() === mint &&
            ts.isPropertySignature(declaration) &&
            ts.isComputedPropertyName(declaration.name) &&
            ts.isIdentifier(declaration.name.expression) &&
            declaration.name.expression.text === BRAND_KEY_NAME,
        ) ?? false,
    );
  if (brand === undefined) {
    throw new Error(`OperationScoped carries no ${BRAND_KEY_NAME} property`);
  }
  return brand.escapedName;
}

/** How deep a type's structure is searched for the brand. */
const STRUCTURE_DEPTH = 2;

type BrandAnalysis = Readonly<{
  /** The type itself (or a union/intersection constituent) has the brand. */
  hasBrand: (type: ts.Type) => boolean;
  /** The brand reaches a reader: itself, a property, a return, a type argument. */
  carries: (type: ts.Type) => boolean;
  /** A value of the first type reaching the second loses a brand demand. */
  widens: (source: ts.Type, target: ts.Type) => boolean;
  /** The signature returns the brand or hands it to a callback. */
  handsOutBrand: (signature: ts.Signature) => boolean;
}>;

/** A member declared with an ECMAScript private name (`#name`). */
function isPrivateNamed(property: ts.Symbol): boolean {
  return (property.declarations ?? []).some(
    (declaration) =>
      (ts.isMethodDeclaration(declaration) ||
        ts.isPropertyDeclaration(declaration) ||
        ts.isGetAccessorDeclaration(declaration) ||
        ts.isSetAccessorDeclaration(declaration)) &&
      ts.isPrivateIdentifier(declaration.name),
  );
}

function brandAnalysis(scan: ScanProgram): BrandAnalysis {
  const { checker } = scan;
  const brandName = brandPropertyName(scan);

  function resolved(type: ts.Type): ts.Type {
    return (type.flags & ts.TypeFlags.Instantiable) === 0 ?
        type
      : (checker.getBaseConstraintOfType(type) ?? type);
  }

  function hasBrand(type: ts.Type): boolean {
    const target = resolved(type);
    if (target.isUnion()) {
      return target.types.some((constituent) => hasBrand(constituent));
    }
    return checker
      .getPropertiesOfType(target)
      .some((property) => property.escapedName === brandName);
  }

  function typeArguments(type: ts.Type): readonly ts.Type[] {
    return (
        (type.flags & ts.TypeFlags.Object) !== 0 &&
          ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
      ) ?
        checker.getTypeArguments(type as ts.TypeReference)
      : [];
  }

  /**
   * The properties searched for a nested brand: those of a type declared in
   * `src` (or a mapped type over one). A library or driver type cannot
   * declare a branded member, and walking one (a query builder, a
   * connection) costs gigabytes; such a type is still searched through its
   * type arguments and signatures, so `Promise<StatementBackend>` and a
   * library callback typed `(target: StatementBackend) => void` count.
   *
   * An ECMAScript private member (`#name`) is not searched: no code outside
   * its class body can read or call it, so a brand it carries or demands
   * never reaches a reader of the type, and every use inside the body is
   * scanned where it is written. A TypeScript `private` member is still
   * searched — bracket access reaches it.
   */
  function structuralProperties(type: ts.Type): readonly ts.Symbol[] {
    const isMapped =
      (type.flags & ts.TypeFlags.Object) !== 0 &&
      ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0;
    const declarations = [
      ...(type.aliasSymbol?.declarations ?? []),
      ...(type.getSymbol()?.declarations ?? []),
    ];
    const declaredInSource = declarations.some((declaration) =>
      path
        .resolve(declaration.getSourceFile().fileName)
        .startsWith(SOURCE_ROOT + path.sep),
    );
    return isMapped || declaredInSource ?
        checker
          .getPropertiesOfType(type)
          .filter((property) => !isPrivateNamed(property))
      : [];
  }

  function signatures(type: ts.Type): readonly ts.Signature[] {
    return [...type.getCallSignatures(), ...type.getConstructSignatures()];
  }

  const carriesAt = (
    type: ts.Type,
    depth: number,
    seen: Set<ts.Type>,
  ): boolean => {
    const target = resolved(type);
    if (hasBrand(target)) return true;
    if (target.isUnionOrIntersection()) {
      return target.types.some((constituent) =>
        carriesAt(constituent, depth, seen),
      );
    }
    if (depth === 0 || seen.has(target)) return false;
    seen.add(target);
    const result =
      signatures(target).some((signature) =>
        carriesAt(signature.getReturnType(), depth - 1, seen),
      ) ||
      typeArguments(target).some((argument) =>
        carriesAt(argument, depth - 1, seen),
      ) ||
      structuralProperties(target).some((property) =>
        carriesAt(checker.getTypeOfSymbol(property), depth - 1, seen),
      );
    seen.delete(target);
    return result;
  };
  const carriesCache = new Map<ts.Type, boolean>();
  function carries(type: ts.Type): boolean {
    const cached = carriesCache.get(type);
    if (cached !== undefined) return cached;
    const result = carriesAt(type, STRUCTURE_DEPTH, new Set());
    carriesCache.set(type, result);
    return result;
  }

  const consumesAt = (
    type: ts.Type,
    depth: number,
    seen: Set<ts.Type>,
  ): boolean => {
    const target = resolved(type);
    if (target.isUnionOrIntersection()) {
      return target.types.some((constituent) =>
        consumesAt(constituent, depth, seen),
      );
    }
    if (seen.has(target)) return false;
    seen.add(target);
    const result =
      signatures(target).some(
        (signature) =>
          demandsBrand(signature) ||
          (depth > 0 && consumesAt(signature.getReturnType(), depth - 1, seen)),
      ) ||
      (depth > 0 &&
        (typeArguments(target).some((argument) =>
          consumesAt(argument, depth - 1, seen),
        ) ||
          structuralProperties(target).some((property) =>
            consumesAt(checker.getTypeOfSymbol(property), depth - 1, seen),
          )));
    seen.delete(target);
    return result;
  };
  const consumesCache = new Map<number, Map<ts.Type, boolean>>();
  function consumes(type: ts.Type, depth = STRUCTURE_DEPTH): boolean {
    const cache = consumesCache.get(depth) ?? new Map<ts.Type, boolean>();
    consumesCache.set(depth, cache);
    const cached = cache.get(type);
    if (cached !== undefined) return cached;
    const result = consumesAt(type, depth, new Set());
    cache.set(type, result);
    return result;
  }

  /** A parameter of this signature demands a branded argument. */
  function demandsBrand(signature: ts.Signature): boolean {
    return signature.parameters.some((parameter) =>
      carries(checker.getTypeOfSymbol(parameter)),
    );
  }

  /**
   * A type no value can be called or read through without a further
   * assertion, or the library \`Function\`, which can be applied untyped
   * (\`Reflect.apply\`).
   */
  function isOpaque(type: ts.Type): boolean {
    const symbol = type.getSymbol();
    if (
      symbol?.getName() === "Function" &&
      (symbol.declarations ?? []).some((declaration) =>
        scan.program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
      )
    ) {
      return true;
    }
    return (
      (type.flags &
        (ts.TypeFlags.Unknown |
          ts.TypeFlags.Never |
          ts.TypeFlags.NonPrimitive)) !==
        0 ||
      ((type.flags & ts.TypeFlags.Object) !== 0 &&
        checker.getPropertiesOfType(type).length === 0 &&
        signatures(type).length === 0 &&
        checker.getIndexInfosOfType(type).length === 0)
    );
  }

  const widensAt = (
    source: ts.Type,
    target: ts.Type,
    depth: number,
    seen: Set<ts.Type>,
  ): boolean => {
    const from = resolved(source);
    const to = resolved(target);
    if ((to.flags & ts.TypeFlags.Any) !== 0) return consumes(from);
    if (isOpaque(to)) return consumes(from, 1);
    if (!consumes(from)) return false;
    if (from.isUnion()) {
      return from.types.some((constituent) =>
        widensAt(constituent, to, depth, seen),
      );
    }
    if (to.isUnion()) {
      return to.types.some((constituent) =>
        widensAt(from, constituent, depth, seen),
      );
    }
    if (seen.has(from)) return false;
    seen.add(from);
    const weakened = signatures(from).some((demanding) =>
      demanding.parameters.some(
        (parameter, index) =>
          carries(checker.getTypeOfSymbol(parameter)) &&
          signatures(to).some((accepting) => {
            const counterpart =
              accepting.parameters[index] ??
              (accepting.parameters.length > 0 ?
                accepting.parameters.at(-1)
              : undefined);
            return (
              counterpart !== undefined &&
              !carries(checker.getTypeOfSymbol(counterpart))
            );
          }),
      ),
    );
    const result =
      weakened ||
      (depth > 0 &&
        structuralProperties(from).some((property) => {
          const counterpart = to.getProperty(property.name);
          return (
            counterpart !== undefined &&
            widensAt(
              checker.getTypeOfSymbol(property),
              checker.getTypeOfSymbol(counterpart),
              depth - 1,
              seen,
            )
          );
        }));
    seen.delete(from);
    return result;
  };

  /**
   * Whether a value of `source` reaching `target` loses a brand demand: the
   * target is `any` (callable with anything), an opaque top type a function
   * value that demands the brand is hidden in, or a structure that keeps a
   * brand-demanding callable at the same path with an unbranded parameter.
   * A target that simply does not expose the member is not a widening.
   */
  function widens(source: ts.Type, target: ts.Type): boolean {
    return widensAt(source, target, STRUCTURE_DEPTH, new Set());
  }

  /** A callback parameter of this signature is handed a branded value. */
  function handsOutBrand(signature: ts.Signature): boolean {
    return (
      carries(signature.getReturnType()) ||
      signature.parameters.some((parameter) =>
        signatures(resolved(checker.getTypeOfSymbol(parameter))).some(
          (callback) => demandsBrand(callback),
        ),
      )
    );
  }

  return { hasBrand, carries, widens, handsOutBrand };
}

// ---------------------------------------------------------------------------
// The forge scan
// ---------------------------------------------------------------------------

/**
 * How a value can come to carry the operation brand, or a brand-demanding
 * function can come to accept an unbranded value, without passing a mint.
 */
export type ForgeRoute =
  /** `x as T` / `<T>x` producing the brand (by `T` or by context) from an unbranded operand. */
  | "assertion"
  /** An assertion that drops a parameter's brand demand (`consumer as (…) => …`). */
  | "consumer-widening"
  /** An `any`-typed value flowing into a branded position. */
  | "any-flow"
  /** A brand-demanding function value flowing into a position that does not demand it. */
  | "consumer-flow"
  /** A generic call whose instantiation, not its arguments, introduces the brand. */
  | "generic-instantiation"
  /** `x is T` / `asserts x is T` with a branded `T`. */
  | "type-predicate"
  /** A bodiless signature (overload, `declare`) promising the brand from unbranded parameters. */
  | "unverified-signature"
  /** `declare` or definite-assignment (`!`) of a branded binding: a value no code produced. */
  | "unverified-binding"
  /** A spread or `Object.assign` whose result carries the brand on a new or mutated object. */
  | "branded-copy"
  /** A `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` directive, which hides any of the above from the checker. */
  | "suppression";

export type ForgeSite = Readonly<{
  file: string;
  function: string;
  route: ForgeRoute;
  /** 1-based line of the site, for a failure message. */
  line: number;
}>;

const SUPPRESSION_DIRECTIVE =
  /(?:\/\/|\/\*)\s*@ts-(?:ignore|expect-error|nocheck)\b/g;

function isFlowPosition(node: ts.Expression): boolean {
  const parent = node.parent;
  return (
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      (parent.arguments?.includes(node) ?? false)) ||
    (ts.isVariableDeclaration(parent) &&
      parent.initializer === node &&
      ts.isIdentifier(parent.name)) ||
    (ts.isPropertyDeclaration(parent) && parent.initializer === node) ||
    (ts.isParameter(parent) && parent.initializer === node) ||
    ts.isReturnStatement(parent) ||
    (ts.isArrowFunction(parent) && parent.body === node) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === node) ||
    ts.isArrayLiteralExpression(parent) ||
    (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === node)
  );
}

type Assertion = ts.AsExpression | ts.TypeAssertion;

function isAssertion(node: ts.Node): node is Assertion {
  return (
    (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
    !ts.isConstTypeReference(node.type)
  );
}

function skipOuterParentheses(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return current;
}

/** The operand under every assertion, `satisfies`, `!` and parenthesis. */
function innermostOperand(node: Assertion): ts.Expression {
  let current: ts.Expression = node.expression;
  for (;;) {
    if (
      isAssertion(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

/**
 * Declared without a value: under a `declare` modifier on the node or an
 * ancestor (`declare const`, a `declare` class field, anything in a
 * `declare` namespace), or in a declaration file.
 */
function isAmbient(node: ts.Node): boolean {
  return (
    ts.findAncestor(node, (current) =>
      hasModifier(current, ts.SyntaxKind.DeclareKeyword),
    ) !== undefined || node.getSourceFile().isDeclarationFile
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
  );
}

/**
 * Every forge site in `files` (absolute paths). The mint module is scanned
 * like any other: its two assertions are the expected sites.
 */
export function forgeSites(
  scan: ScanProgram,
  files: readonly string[],
): readonly ForgeSite[] {
  const { checker } = scan;
  const brand = brandAnalysis(scan);
  const sites: ForgeSite[] = [];

  function typeOfTypeNode(node: ts.TypeNode): ts.Type {
    return checker.getTypeFromTypeNode(node);
  }

  function routesAt(node: ts.Node): readonly ForgeRoute[] {
    const routes: ForgeRoute[] = [];

    // An assertion chain (`x as unknown as T`) is judged once, at its
    // outermost link, from the innermost operand to the asserted type and to
    // the position the result flows into.
    if (isAssertion(node) && !isAssertion(skipOuterParentheses(node).parent)) {
      const asserted = typeOfTypeNode(node.type);
      const operand = checker.getTypeAtLocation(innermostOperand(node));
      const context = checker.getContextualType(node);
      if (
        (brand.carries(asserted) ||
          (context !== undefined && brand.carries(context))) &&
        !brand.carries(operand)
      ) {
        routes.push("assertion");
      }
      if (
        brand.widens(operand, asserted) ||
        (context !== undefined && brand.widens(operand, context))
      ) {
        routes.push("consumer-widening");
      }
    }

    if (ts.isExpression(node) && !isAssertion(node) && isFlowPosition(node)) {
      const context = checker.getContextualType(node);
      if (context !== undefined) {
        const own = checker.getTypeAtLocation(node);
        if ((own.flags & ts.TypeFlags.Any) !== 0 && brand.carries(context)) {
          routes.push("any-flow");
        }
        if (brand.widens(own, context)) routes.push("consumer-flow");
      }
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const resolvedSignature = checker.getResolvedSignature(node);
      const declaration = resolvedSignature?.getDeclaration();
      if (resolvedSignature !== undefined && declaration !== undefined) {
        const declared = checker.getSignatureFromDeclaration(declaration);
        const receiver =
          (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression)
          ) ?
            [node.expression.expression]
          : [];
        const inputs = [...receiver, ...(node.arguments ?? [])];
        // An argument-less construction of a library type (`new WeakMap<K,
        // V>()`) builds an empty container: no value exists for the
        // instantiation to have branded, and every value later put in is
        // checked against the instantiated type where it is put.
        const emptyLibraryConstruction =
          ts.isNewExpression(node) &&
          inputs.length === 0 &&
          scan.program.isSourceFileDefaultLibrary(declaration.getSourceFile());
        if (
          !emptyLibraryConstruction &&
          brand.handsOutBrand(resolvedSignature) &&
          (declared === undefined || !brand.handsOutBrand(declared)) &&
          !inputs.some((input) =>
            brand.carries(checker.getTypeAtLocation(input)),
          )
        ) {
          routes.push("generic-instantiation");
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.getText() === "Object.assign" &&
        brand.hasBrand(checker.getTypeAtLocation(node))
      ) {
        routes.push("branded-copy");
      }
    }

    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some((property) => ts.isSpreadAssignment(property)) &&
      brand.hasBrand(checker.getTypeAtLocation(node))
    ) {
      routes.push("branded-copy");
    }

    if (
      ts.isTypePredicateNode(node) &&
      node.type !== undefined &&
      brand.carries(typeOfTypeNode(node.type))
    ) {
      routes.push("type-predicate");
    }

    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.body === undefined
    ) {
      const signature = checker.getSignatureFromDeclaration(node);
      if (
        signature !== undefined &&
        brand.carries(signature.getReturnType()) &&
        !signature.parameters.some((parameter) =>
          brand.carries(checker.getTypeOfSymbol(parameter)),
        )
      ) {
        routes.push("unverified-signature");
      }
    }

    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      (isAmbient(node) || node.exclamationToken !== undefined) &&
      brand.carries(checker.getTypeAtLocation(node.name))
    ) {
      routes.push("unverified-binding");
    }

    return routes;
  }

  for (const file of files) {
    const source = scan.program.getSourceFile(file);
    if (source === undefined) throw new Error(`${file} is not in program`);
    const relative = relativeToPackage(file);

    for (const match of source.text.matchAll(SUPPRESSION_DIRECTIVE)) {
      sites.push({
        file: relative,
        function: functionAtPosition(source, match.index),
        route: "suppression",
        line: source.getLineAndCharacterOfPosition(match.index).line + 1,
      });
    }

    const visit = (node: ts.Node): void => {
      for (const route of routesAt(node)) {
        sites.push({
          file: relative,
          function: functionAtPosition(source, node.getStart(source)),
          route,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

// ---------------------------------------------------------------------------
// The raw statement-target ratchet
// ---------------------------------------------------------------------------

/**
 * Store families, matched in order against the path relative to `src/store`;
 * the last entry catches every remaining store module.
 */
const STORE_FAMILIES = [
  { family: "operations/edge", pattern: /^operations\/edge-/ },
  { family: "operations/node", pattern: /^operations\/node-/ },
  { family: "operations/composition", pattern: /^operations\/composition-/ },
  { family: "operations/write", pattern: /^operations\// },
  { family: "recorded-capture", pattern: /^recorded-capture(\.ts$|\/)/ },
  { family: "claims", pattern: /^claims\// },
  { family: "search-sync", pattern: /^(embedding-sync|fulltext-)/ },
  {
    family: "collections",
    pattern: /^(collection-factory\.ts$|collections\/)/,
  },
  { family: "store", pattern: /^/ },
] as const;

export type StoreFamily = (typeof STORE_FAMILIES)[number]["family"];

function storeFamilyOf(file: string): StoreFamily {
  const relative = path.relative(STORE_ROOT, file).replaceAll(path.sep, "/");
  const match = STORE_FAMILIES.find((entry) => entry.pattern.test(relative));
  if (match === undefined) throw new Error(`no store family for ${relative}`);
  return match.family;
}

export function storeModules(scan: ScanProgram): readonly string[] {
  return scan.sourceFiles.filter(
    (file) =>
      file.startsWith(STORE_ROOT + path.sep) &&
      relativeToPackage(file) !== MINT_MODULE,
  );
}

/** Backend members that issue a statement: every class but `identity`. */
const STATEMENT_MEMBER_NAMES: ReadonlySet<string> = new Set(
  Object.entries(GRAPH_BACKEND_MEMBER_CLASSES)
    .filter(([memberClass]) => memberClass !== "identity")
    .flatMap(([, members]) => [...members]),
);

export type RawStatementTarget = Readonly<{
  family: StoreFamily;
  file: string;
  function: string;
}>;

/** How deep into a parameter's properties a backend-carrying member is sought. */
const MEMBER_DEPTH = 4;

/**
 * Exported functions in `files` with a parameter that accepts a raw
 * `TransactionBackend` and exposes a statement-issuing member — directly, as a
 * union constituent, through a type parameter's constraint, or through a
 * property (to {@link MEMBER_DEPTH}) or array element that does. `unknown`,
 * `any` and an unconstrained generic expose no member, so they never count;
 * a union with a primitive (`Reader | number`) counts through its backend
 * constituent.
 */
export function rawStatementTargets(
  scan: ScanProgram,
  files: readonly string[],
): readonly RawStatementTarget[] {
  const { checker, program } = scan;
  const backendTypes = program.getSourceFile(
    path.join(SOURCE_ROOT, "backend", "types.ts"),
  );
  const backendModule =
    backendTypes === undefined ? undefined : (
      checker.getSymbolAtLocation(backendTypes)
    );
  const transactionBackendSymbol =
    backendModule === undefined ? undefined : (
      checker
        .getExportsOfModule(backendModule)
        .find((symbol) => symbol.name === "TransactionBackend")
    );
  if (transactionBackendSymbol === undefined) {
    throw new Error("TransactionBackend not found in src/backend/types.ts");
  }
  const rawTransaction = checker.getDeclaredTypeOfSymbol(
    transactionBackendSymbol,
  );

  function resolved(type: ts.Type): ts.Type {
    return checker.getBaseConstraintOfType(type) ?? type;
  }

  function acceptsDirectly(type: ts.Type): boolean {
    if (!checker.isTypeAssignableTo(rawTransaction, type)) return false;
    return checker
      .getPropertiesOfType(checker.getNonNullableType(type))
      .some((property) => STATEMENT_MEMBER_NAMES.has(property.name));
  }

  /** Where a parameter can carry a backend: its properties and array element. */
  function memberTypes(type: ts.Type): readonly ts.Type[] {
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    return [
      ...checker
        .getPropertiesOfType(type)
        .map((property) => checker.getTypeOfSymbol(property)),
      ...(element === undefined ? [] : [element]),
    ];
  }

  function accepts(type: ts.Type, depth: number, seen: Set<ts.Type>): boolean {
    const target = resolved(type);
    if (seen.has(target)) return false;
    if (acceptsDirectly(target)) return true;
    seen.add(target);
    const nonNullable = checker.getNonNullableType(target);
    const result =
      (nonNullable.isUnion() &&
        nonNullable.types.some((constituent) =>
          accepts(constituent, depth, seen),
        )) ||
      (depth > 0 &&
        memberTypes(nonNullable).some((member) =>
          accepts(member, depth - 1, seen),
        ));
    seen.delete(target);
    return result;
  }

  function exportedFunctions(source: ts.SourceFile): readonly Readonly<{
    name: string;
    parameters: readonly ts.ParameterDeclaration[];
  }>[] {
    const functions: {
      name: string;
      parameters: readonly ts.ParameterDeclaration[];
    }[] = [];
    for (const statement of source.statements) {
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name !== undefined &&
        statement.body !== undefined
      ) {
        functions.push({
          name: statement.name.text,
          parameters: statement.parameters,
        });
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const initializer = declaration.initializer;
          if (
            ts.isIdentifier(declaration.name) &&
            initializer !== undefined &&
            (ts.isArrowFunction(initializer) ||
              ts.isFunctionExpression(initializer))
          ) {
            functions.push({
              name: declaration.name.text,
              parameters: initializer.parameters,
            });
          }
        }
      }
    }
    return functions;
  }

  const found: RawStatementTarget[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (source === undefined) throw new Error(`${file} is not in program`);
    for (const exported of exportedFunctions(source)) {
      if (
        exported.parameters.some((parameter) =>
          accepts(
            checker.getTypeAtLocation(parameter),
            MEMBER_DEPTH,
            new Set(),
          ),
        )
      ) {
        found.push({
          family: storeFamilyOf(file),
          file: relativeToPackage(file),
          function: exported.name,
        });
      }
    }
  }
  return found;
}

export function countByFamily(
  targets: readonly RawStatementTarget[],
): Record<StoreFamily, number> {
  const counts = Object.fromEntries(
    STORE_FAMILIES.map((entry) => [entry.family, 0]),
  ) as Record<StoreFamily, number>;
  for (const target of targets) counts[target.family] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Raw engine transactions outside the engine
// ---------------------------------------------------------------------------

/**
 * How a raw engine transaction — a value of the public, full
 * `TransactionBackend` type, or a subtype of it, that carries no operation
 * brand — appears in Store-facing code.
 */
export type RawTransactionRoute =
  /** A parameter, variable, binding or property declared or inferred with the raw type. */
  | "declaration"
  /** An expression that produces the raw type: a call, a property read, an `await`. */
  | "value"
  /** An assertion that produces the raw type from an operand that is not raw. */
  | "assertion";

export type RawTransactionSite = Readonly<{
  file: string;
  /** The enclosing named function, method or variable, or `<module>`. */
  function: string;
  route: RawTransactionRoute;
  /** 1-based line of the site, for a failure message. */
  line: number;
  /** The site's source text, for a failure message. */
  text: string;
}>;

/**
 * The modules that receive the Store-facing transaction type: every `src`
 * module outside `src/backend` (the engine, which keeps the full type) and
 * the mint module (which converts between the two).
 */
export function storeFacingModules(scan: ScanProgram): readonly string[] {
  const backendRoot = path.join(SOURCE_ROOT, "backend") + path.sep;
  return scan.sourceFiles.filter(
    (file) =>
      !file.startsWith(backendRoot) && relativeToPackage(file) !== MINT_MODULE,
  );
}

function backendTypesExport(scan: ScanProgram, name: string): ts.Type {
  const { checker, program } = scan;
  const source = program.getSourceFile(
    path.join(SOURCE_ROOT, "backend", "types.ts"),
  );
  const moduleSymbol =
    source === undefined ? undefined : checker.getSymbolAtLocation(source);
  const symbol =
    moduleSymbol === undefined ? undefined : (
      checker
        .getExportsOfModule(moduleSymbol)
        .find((candidate) => candidate.name === name)
    );
  if (symbol === undefined) {
    throw new Error(`${name} not found in src/backend/types.ts`);
  }
  return checker.getDeclaredTypeOfSymbol(symbol);
}

function mintModuleExport(scan: ScanProgram, name: string): ts.Type {
  const { checker } = scan;
  const moduleSymbol = checker.getSymbolAtLocation(
    requireSourceFile(scan, MINT_MODULE),
  );
  const symbol =
    moduleSymbol === undefined ? undefined : (
      checker
        .getExportsOfModule(moduleSymbol)
        .find((candidate) => candidate.name === name)
    );
  if (symbol === undefined)
    throw new Error(`${name} not found in ${MINT_MODULE}`);
  return checker.getDeclaredTypeOfSymbol(symbol);
}

function isCallee(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression === node
  );
}

/** The name a site is reported under: its nearest named function, method or variable. */
function enclosingName(node: ts.Node): string {
  for (
    let current: ts.Node = node.parent;
    !ts.isSourceFile(current);
    current = current.parent
  ) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isPropertyDeclaration(current)) &&
      current.name !== undefined
    ) {
      const owner =
        ts.isClassLike(current.parent) && current.parent.name !== undefined ?
          `${current.parent.name.text}.`
        : "";
      return `${owner}${current.name.getText()}`;
    }
    if (ts.isConstructorDeclaration(current)) {
      return `${current.parent.name?.text ?? "<class>"}.constructor`;
    }
    if (
      (ts.isVariableDeclaration(current) ||
        ts.isTypeAliasDeclaration(current) ||
        ts.isInterfaceDeclaration(current)) &&
      ts.isIdentifier(current.name) &&
      ts.isSourceFile(
        ts.isVariableDeclaration(current) ?
          current.parent.parent.parent
        : current.parent,
      )
    ) {
      return current.name.text;
    }
  }
  return "<module>";
}

/**
 * Every place in `files` (absolute paths) where Store-facing code holds or
 * produces a raw engine transaction. Store code receives a transaction as
 * `StoreTransactionBackend` (no statement member) and issues statements
 * only through an operation handle, so a raw transaction here is a statement
 * surface the type checker does not see: a callback parameter left to infer
 * the engine type, a public signature that must keep it, or an assertion.
 */
export function rawTransactionSites(
  scan: ScanProgram,
  files: readonly string[],
): readonly RawTransactionSite[] {
  const { checker } = scan;
  const brand = brandAnalysis(scan);
  const engineTransaction = backendTypesExport(scan, "TransactionBackend");
  const rootBackend = backendTypesExport(scan, "GraphBackend");
  const storeFacingType = mintModuleExport(scan, "StoreTransactionBackend");
  const storeFacingMembers: ReadonlySet<string> = new Set(
    checker
      .getPropertiesOfType(storeFacingType)
      .map((property) => property.name),
  );
  const enginePhantom = checker
    .getPropertiesOfType(storeFacingType)
    .find(
      (property) =>
        property.declarations?.some(
          (declaration) =>
            ts.isPropertySignature(declaration) &&
            ts.isComputedPropertyName(declaration.name) &&
            ts.isIdentifier(declaration.name.expression) &&
            declaration.name.expression.text === ENGINE_PHANTOM_KEY_NAME,
        ) ?? false,
    )?.escapedName;
  if (enginePhantom === undefined) {
    throw new Error(
      `StoreTransactionBackend carries no ${ENGINE_PHANTOM_KEY_NAME} property`,
    );
  }

  function isRawConstituent(type: ts.Type): boolean {
    const target =
      (type.flags & ts.TypeFlags.Instantiable) === 0 ?
        type
      : (checker.getBaseConstraintOfType(type) ?? type);
    if (
      (target.flags &
        (ts.TypeFlags.Any |
          ts.TypeFlags.Unknown |
          ts.TypeFlags.Never |
          ts.TypeFlags.Instantiable)) !==
      0
    ) {
      return false;
    }
    return (
      checker.isTypeAssignableTo(target, engineTransaction) &&
      !checker.isTypeAssignableTo(target, rootBackend) &&
      !brand.hasBrand(target)
    );
  }

  /**
   * The type records an engine transaction type in the
   * `StoreTransactionBackend` phantom, which a mint turns back into that
   * engine type's handle — so asserting INTO it forges the engine type as
   * surely as asserting to the engine type itself.
   */
  function recordsEngine(type: ts.Type): boolean {
    const target = checker.getNonNullableType(type);
    return (target.isUnion() ? target.types : [target]).some((constituent) =>
      checker
        .getPropertiesOfType(constituent)
        .some((property) => property.escapedName === enginePhantom),
    );
  }

  function holdsRaw(type: ts.Type): boolean {
    const target = checker.getNonNullableType(type);
    return target.isUnion() ?
        target.types.some((constituent) => isRawConstituent(constituent))
      : isRawConstituent(target);
  }

  /** `node` is the argument of a call to the transitional shim, which consumes it. */
  function isShimArgument(node: ts.Node): boolean {
    const argument = skipOuterParentheses(node);
    const call = argument.parent;
    if (
      !ts.isCallExpression(call) ||
      !call.arguments.includes(argument as ts.Expression)
    ) {
      return false;
    }
    const declaration = checker.getResolvedSignature(call)?.getDeclaration();
    return (
      declaration !== undefined &&
      ts.isFunctionDeclaration(declaration) &&
      declaration.name?.text === LEGACY_SHIM_NAME &&
      relativeToPackage(declaration.getSourceFile().fileName) === MINT_MODULE
    );
  }

  /**
   * `node` is only the receiver of a member the Store-facing transaction type
   * carries (`ctx.backend.dialect`, `ctx.backend.compileSql`): reading what
   * `StoreTransactionBackend` allows is not a statement surface.
   */
  function readsOnlyIdentity(node: ts.Node): boolean {
    const receiver = skipOuterParentheses(node);
    const read = receiver.parent;
    return (
      ts.isPropertyAccessExpression(read) &&
      read.expression === receiver &&
      storeFacingMembers.has(read.name.text)
    );
  }

  /**
   * `node` flows straight into a position whose type has no statement member
   * — a return typed `StoreTransactionBackend`, an identity-keyed registry's
   * `object` key — so the raw type does not survive its arrival. A position
   * typed as a statement fragment (`Pick<TransactionBackend, "execute">`)
   * does not qualify: that is a statement surface by another name.
   */
  function narrowedOnArrival(node: ts.Node): boolean {
    if (
      !ts.isExpression(node) ||
      !isFlowPosition(skipOuterParentheses(node) as ts.Expression)
    ) {
      return false;
    }
    const context = checker.getContextualType(node);
    if (context === undefined) return false;
    const target = checker.getNonNullableType(context);
    if ((target.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      return false;
    }
    const constituents = target.isUnion() ? target.types : [target];
    return constituents.every(
      (constituent) =>
        (constituent.flags &
          (ts.TypeFlags.Object |
            ts.TypeFlags.NonPrimitive |
            ts.TypeFlags.Intersection)) !==
          0 &&
        checker
          .getPropertiesOfType(constituent)
          .every(
            (property) =>
              !STATEMENT_MEMBER_NAMES.has(property.name) ||
              storeFacingMembers.has(property.name),
          ),
    );
  }

  function routeAt(node: ts.Node): RawTransactionRoute | undefined {
    if (
      (ts.isParameter(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isBindingElement(node) ||
        ts.isPropertySignature(node) ||
        ts.isPropertyDeclaration(node)) &&
      holdsRaw(checker.getTypeAtLocation(node.name))
    ) {
      return "declaration";
    }
    if (isAssertion(node) && !isAssertion(skipOuterParentheses(node).parent)) {
      const operand = checker.getTypeAtLocation(innermostOperand(node));
      const context = checker.getContextualType(node);
      const into = [
        checker.getTypeFromTypeNode(node.type),
        ...(context === undefined ? [] : [context]),
      ];
      return (
          into.some(
            (target) =>
              (holdsRaw(target) || recordsEngine(target)) &&
              !checker.isTypeAssignableTo(operand, target),
          )
        ) ?
          "assertion"
        : undefined;
    }
    if (
      (ts.isCallExpression(node) ||
        ts.isAwaitExpression(node) ||
        ts.isElementAccessExpression(node) ||
        (ts.isPropertyAccessExpression(node) && !isCallee(node))) &&
      !isShimArgument(node) &&
      !readsOnlyIdentity(node) &&
      !narrowedOnArrival(node) &&
      holdsRaw(checker.getTypeAtLocation(node))
    ) {
      return "value";
    }
    return undefined;
  }

  const sites: RawTransactionSite[] = [];
  for (const file of files) {
    const source = scan.program.getSourceFile(file);
    if (source === undefined) throw new Error(`${file} is not in program`);
    const relative = relativeToPackage(file);
    const visit = (node: ts.Node): void => {
      const route = routeAt(node);
      if (route !== undefined) {
        sites.push({
          file: relative,
          function: enclosingName(node),
          route,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          text: ((
            ts.isParameter(node) ||
            ts.isVariableDeclaration(node) ||
            ts.isBindingElement(node) ||
            ts.isPropertySignature(node) ||
            ts.isPropertyDeclaration(node)
          ) ?
            node.name
          : node
          ).getText(source),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

// ---------------------------------------------------------------------------
// The transitional shim's call sites
// ---------------------------------------------------------------------------

export type LegacyShimSite = Readonly<{
  file: string;
  /** The enclosing named function, method or variable, or `<module>`. */
  function: string;
  /** 1-based line of the site, for a failure message. */
  line: number;
  /** A direct call; anything else (an alias, a re-export, a value read) is not. */
  call: boolean;
}>;

/**
 * Every reference in `files` to the transitional shim
 * `legacyTransactionOperation`, resolved by symbol rather than by name, so a
 * renamed import, a re-export or a stored reference is found as surely as a
 * call. The mint module's own declaration is excluded.
 */
export function legacyShimSites(
  scan: ScanProgram,
  files: readonly string[],
): readonly LegacyShimSite[] {
  const { checker } = scan;
  const mint = requireSourceFile(scan, MINT_MODULE);
  const moduleSymbol = checker.getSymbolAtLocation(mint);
  const shim =
    moduleSymbol === undefined ? undefined : (
      checker
        .getExportsOfModule(moduleSymbol)
        .find((symbol) => symbol.name === LEGACY_SHIM_NAME)
    );
  if (shim === undefined) {
    throw new Error(`${LEGACY_SHIM_NAME} is not exported from ${MINT_MODULE}`);
  }

  function resolvesToShim(identifier: ts.Identifier): boolean {
    const symbol = checker.getSymbolAtLocation(identifier);
    if (symbol === undefined) return false;
    const target =
      (symbol.flags & ts.SymbolFlags.Alias) === 0 ?
        symbol
      : checker.getAliasedSymbol(symbol);
    return target === shim;
  }

  const sites: LegacyShimSite[] = [];
  for (const file of files) {
    const source = scan.program.getSourceFile(file);
    if (source === undefined) throw new Error(`${file} is not in program`);
    const relative = relativeToPackage(file);
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        node.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        // An import binding is a declaration, not a use; a renamed one is not
        // a call either, and is counted below wherever it is referenced.
        return;
      }
      if (
        ts.isIdentifier(node) &&
        !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node) &&
        resolvesToShim(node)
      ) {
        sites.push({
          file: relative,
          function: enclosingName(node),
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          call: isCallee(node),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}
