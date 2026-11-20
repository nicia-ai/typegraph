/**
 * The type-aware scan of `tests/**` for backend derivations, and the
 * selector-visibility probe that runs the REAL lint selectors over the same
 * sites.
 *
 * Two nets, deliberately kept apart:
 *
 * - {@link scanTestBackendDerivations} resolves the CHECKER's type at every
 *   object spread and every rest-destructure initializer and tests it for the
 *   whole-backend marker property set. It sees the derivations a name-based
 *   ESLint selector cannot — a spread of `result`, of `real`, of `base`, of a
 *   generic parameter — which is the population the conversion ratchet counts.
 * - {@link scanSelectorVisibleLines} runs `BACKEND_CONSTRUCTION_RESTRICTIONS`,
 *   imported from `eslint.config.mjs` itself, over the same files. It is not a
 *   second implementation of that decision: it is the same selector array the
 *   config installs, so the two cannot drift.
 *
 * The scan is the shipped form of the measurement the design was baselined on,
 * so the numbers a ratchet asserts are emitted here rather than transcribed.
 */
import path from "node:path";

import { ESLint, Linter } from "eslint";
import * as ts from "typescript";

import { BACKEND_CONSTRUCTION_RESTRICTIONS } from "../eslint.config.mjs";

/** The three members every whole-backend type in this tree carries. */
const BACKEND_MARKER_PROPERTIES = ["dialect", "capabilities", "getNode"];

/**
 * The members that distinguish a root backend — the kind a factory audits —
 * from a transaction-scoped one.
 */
const AUDIT_RELEVANT_PROPERTIES = ["transaction", "close"];

/**
 * Whether the derivation copies a backend a factory audits, or a
 * transaction-scoped backend that is unaudited by construction.
 */
export type BackendDerivationClass = "audit-relevant" | "transaction-scoped";

/** How the new object is built. Internal to the scanner's own site records. */
type BackendDerivationKind = "spread" | "rest-omission";

export type BackendDerivationSite = Readonly<{
  /** Package-relative, POSIX-separated. */
  file: string;
  /** 1-indexed line of the spread element or rest element. */
  line: number;
  /**
   * The offending source line, trimmed. Exemption entries are keyed by this
   * rather than by line number so unrelated edits above a site do not
   * invalidate them — the same identification the data-keyed-bag ratchet uses.
   */
  text: string;
  kind: BackendDerivationKind;
  derivationClass: BackendDerivationClass;
}>;

export type BackendDerivationScan = Readonly<{
  /** Every derivation the marker test accepts, in file order. */
  sites: readonly BackendDerivationSite[];
  /**
   * Spreads whose source type has `getNode` but fails the marker test — a
   * members fragment, or a generic helper whose constraint is narrower than
   * the backends it is really called with. Reported, never asserted: a new
   * near miss is a site a human must classify.
   */
  nearMisses: readonly Omit<BackendDerivationSite, "derivationClass">[];
}>;

const packageRoot = path.resolve(import.meta.dirname, "..");

function toRelativePosixPath(fileName: string): string {
  return path.relative(packageRoot, fileName).split(path.sep).join("/");
}

function createPackageProgram(): ts.Program {
  const configPath = path.join(packageRoot, "tsconfig.json");
  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  if (read.error !== undefined) {
    throw new Error(
      `Could not read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    packageRoot,
  );
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
}

/**
 * Rule 1 of the classifier: a type parameter stands for its constraint, which
 * is what makes a derivation inside a generic helper visible at all.
 */
function resolveApparentType(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  if ((type.flags & ts.TypeFlags.TypeParameter) === 0) return type;
  return checker.getBaseConstraintOfType(type) ?? type;
}

function typeConstituents(
  checker: ts.TypeChecker,
  type: ts.Type,
): readonly ts.Type[] {
  const resolved = resolveApparentType(checker, type);
  if (!resolved.isUnion()) return [resolved];
  return resolved.types.map((member) => resolveApparentType(checker, member));
}

function hasProperty(
  checker: ts.TypeChecker,
  type: ts.Type,
  property: string,
): boolean {
  return checker.getPropertyOfType(type, property) !== undefined;
}

/**
 * The expression a candidate node derives from, or `undefined` when the node
 * is not a derivation-shaped construction.
 */
function derivationSource(
  node: ts.Node,
):
  Readonly<{ source: ts.Expression; kind: BackendDerivationKind }> | undefined {
  if (ts.isSpreadAssignment(node)) {
    return { source: node.expression, kind: "spread" };
  }
  if (
    ts.isBindingElement(node) &&
    node.dotDotDotToken !== undefined &&
    ts.isObjectBindingPattern(node.parent) &&
    ts.isVariableDeclaration(node.parent.parent) &&
    node.parent.parent.initializer !== undefined
  ) {
    return { source: node.parent.parent.initializer, kind: "rest-omission" };
  }
  return undefined;
}

let cachedScan: BackendDerivationScan | undefined;

/**
 * Every backend derivation under `tests/**`, classified.
 *
 * Memoized: building the package program costs a couple of seconds and both
 * ratchets read the same answer.
 */
export function scanTestBackendDerivations(): BackendDerivationScan {
  if (cachedScan !== undefined) return cachedScan;

  const program = createPackageProgram();
  const checker = program.getTypeChecker();
  const testsRoot = `${path.join(packageRoot, "tests")}${path.sep}`;

  const sites: BackendDerivationSite[] = [];
  const nearMisses: Omit<BackendDerivationSite, "derivationClass">[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!sourceFile.fileName.startsWith(testsRoot.split(path.sep).join("/"))) {
      continue;
    }
    const file = toRelativePosixPath(sourceFile.fileName);

    const visit = (node: ts.Node): void => {
      const candidate = derivationSource(node);
      if (candidate !== undefined) {
        const constituents = typeConstituents(
          checker,
          checker.getTypeAtLocation(candidate.source),
        );
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const text = (sourceFile.text.split("\n")[line - 1] ?? "").trim();
        // Marker test, UNIVERSAL: a union with one non-backend arm is not a
        // backend derivation.
        const isBackend = constituents.every((constituent) =>
          BACKEND_MARKER_PROPERTIES.every((property) =>
            hasProperty(checker, constituent, property),
          ),
        );
        if (isBackend) {
          // Audit-relevance, EXISTENTIAL: the conservative direction, because a
          // helper constrained over both shapes really is called with an
          // audited root backend somewhere in this tree.
          const auditRelevant = constituents.some((constituent) =>
            AUDIT_RELEVANT_PROPERTIES.some((property) =>
              hasProperty(checker, constituent, property),
            ),
          );
          sites.push({
            file,
            line,
            text,
            kind: candidate.kind,
            derivationClass:
              auditRelevant ? "audit-relevant" : "transaction-scoped",
          });
        } else if (
          constituents.every((constituent) =>
            hasProperty(checker, constituent, "getNode"),
          )
        ) {
          nearMisses.push({ file, line, text, kind: candidate.kind });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }

  cachedScan = { sites, nearMisses };
  return cachedScan;
}

/** The sites of one class, in file order. */
export function sitesOfClass(
  scan: BackendDerivationScan,
  derivationClass: BackendDerivationClass,
): readonly BackendDerivationSite[] {
  return scan.sites.filter((site) => site.derivationClass === derivationClass);
}

/**
 * The lines `BACKEND_CONSTRUCTION_RESTRICTIONS` reports in each named file,
 * keyed by package-relative path.
 *
 * The selectors are purely syntactic, so this runs the parser WITHOUT the
 * project service: the answer is identical and it costs milliseconds instead of
 * a full type-check per file. The parser and language options are taken from
 * the package's own resolved ESLint config, so the fixture is parsed exactly as
 * `pnpm lint` parses it.
 */
export async function scanSelectorVisibleLines(
  files: readonly string[],
): Promise<ReadonlyMap<string, ReadonlySet<number>>> {
  const eslint = new ESLint({ cwd: packageRoot });
  // `calculateConfigForFile` is typed `Promise<any>` by ESLint; narrow it to
  // the one member this function reads.
  const resolved = (await eslint.calculateConfigForFile(
    "src/backend/derive-backend.ts",
  )) as Readonly<{ languageOptions?: Linter.LanguageOptions }>;
  const { parserOptions, ...languageOptions } = resolved.languageOptions ?? {};
  const {
    projectService: _projectService,
    project: _project,
    ...syntacticParserOptions
  } = parserOptions ?? {};

  const linter = new Linter();
  const visible = new Map<string, ReadonlySet<number>>();
  for (const file of files) {
    const messages = linter.verify(
      ts.sys.readFile(path.join(packageRoot, file)) ?? "",
      {
        files: ["**/*.ts"],
        languageOptions: {
          ...languageOptions,
          parserOptions: syntacticParserOptions,
        },
        rules: {
          "no-restricted-syntax": [
            "error",
            ...BACKEND_CONSTRUCTION_RESTRICTIONS,
          ],
        },
      },
      file,
    );
    visible.set(file, new Set(messages.map((message) => message.line)));
  }
  return visible;
}
