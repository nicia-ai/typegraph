import { type UniqueKeyForms } from "../src/constraints";

/**
 * The key forms of a kind whose constrained fields are all strings or numbers:
 * such a value keys as it is, whichever form it arrives in. For tests that
 * spell a claim key by hand; a test over a date field asks
 * `uniqueKeyFormsFor` for its kind instead.
 */
export const STRING_FIELD_KEY_FORMS: UniqueKeyForms = {
  isDateField: () => false,
};
