/**
 * Types for the flat-config inventory.
 *
 * The inventory itself is plain ESM because `eslint.config.mjs` cannot import
 * TypeScript. This declaration exists so the ratchet test — which consumes the
 * SAME module the config does, rather than a copy of its data — type-checks
 * under `pnpm typecheck`. It declares shapes only; every value still comes
 * from the `.mjs`.
 */

export type WritePipelineExemption = Readonly<{
  path: string;
  reason: string;
  permanent: boolean;
  allowedMembers: readonly string[];
  allowedImports?: readonly string[];
}>;

export type WritePipelineRestriction = Readonly<{
  selector: string;
  message: string;
}>;

export type WritePipelineProfile = Readonly<{
  name: string;
  files: readonly string[];
  ignores?: readonly string[];
  restrictions: readonly WritePipelineRestriction[];
}>;

export type WritePipelineBlock = Readonly<{
  name: string;
  files: readonly string[];
  ignores?: readonly string[];
  rules: Readonly<{
    "no-restricted-syntax": readonly ["error", ...WritePipelineRestriction[]];
  }>;
}>;

export declare const WRITE_MEMBER_NAMES: readonly string[];
export declare const WRITE_PIPELINE_MESSAGE: string;
export declare const WRITE_PIPELINE_RESTRICTIONS: readonly WritePipelineRestriction[];
export declare const WRITE_PIPELINE_INTERNAL_IMPORT_NAMES: readonly string[];
export declare const WRITE_PIPELINE_IMPORT_RESTRICTIONS: readonly WritePipelineRestriction[];
export declare const WRITE_PIPELINE_EXEMPTIONS: readonly WritePipelineExemption[];

export declare function writePipelineMemberRestrictions(
  memberNames: readonly string[],
): readonly WritePipelineRestriction[];

export declare function writePipelineImportRestrictions(
  importNames: readonly string[],
): readonly WritePipelineRestriction[];

export declare function matchesFilePattern(
  filePath: string,
  pattern: string,
): boolean;

export declare function profileCovers(
  filePath: string,
  profile: Readonly<{ files: readonly string[]; ignores?: readonly string[] }>,
): boolean;

export declare function writePipelineBlocks(
  options: Readonly<{
    profiles: readonly WritePipelineProfile[];
    exemptions: readonly WritePipelineExemption[];
  }>,
): readonly WritePipelineBlock[];
