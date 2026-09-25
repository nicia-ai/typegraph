import { ConfigurationError } from "../errors";
import type { GraphBackend } from "./types";

/**
 * Install the revision-change journal on a privileged backend during schema
 * bootstrap or adoption. This is the only runtime API that invokes its DDL.
 */
export async function installRevisionChangesJournal(
  backend: GraphBackend,
): Promise<void> {
  if ((await backend.revisionChangesJournalReady?.()) === true) return;
  const install = backend.ensureRevisionChangesJournal;
  if (install === undefined) {
    throw new ConfigurationError(
      "This backend cannot install the revision-change journal.",
      { code: "REVISION_JOURNAL_INSTALL_UNAVAILABLE" },
    );
  }
  await install();
  await assertRevisionChangesJournalReady(backend);
}

/** Verify journal storage and write triggers without issuing DDL. */
export async function assertRevisionChangesJournalReady(
  backend: GraphBackend,
): Promise<void> {
  if ((await backend.revisionChangesJournalReady?.()) === true) return;
  throw new ConfigurationError(
    "The revision-change journal is missing or incomplete. Install it during privileged schema bootstrap before using journal-backed lineage.",
    { code: "REVISION_JOURNAL_NOT_READY" },
    {
      suggestion:
        "Call installRevisionChangesJournal(backend) with the schema owner role, then retry with the runtime role.",
    },
  );
}
