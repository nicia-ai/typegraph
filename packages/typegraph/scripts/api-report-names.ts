/**
 * The one mapping from a package `exports` key to its API Extractor report
 * name (`etc/<name>.api.md`). `scripts/api-report.ts` writes reports under
 * these names and the public-type reachability test reads them back, so both
 * must spell it the same way.
 */
export function reportNameForExport(exportPath: string): string {
  if (exportPath === ".") return "typegraph";
  const suffix = exportPath
    .replace(/^\.\//, "")
    .replaceAll(/[^a-zA-Z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return `typegraph-${suffix}`;
}
