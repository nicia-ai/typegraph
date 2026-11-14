/** Physical retention metadata column shared by schema adoption and allocation-log SQL. */
export const RECORDED_ANCHOR_RETENTION_COLUMN = "anchor_retention";

/** Maximum queued wait for the additive recorded-clock migration. */
export const RECORDED_ANCHOR_ADOPTION_WAIT_BUDGET_MS = 1000;
