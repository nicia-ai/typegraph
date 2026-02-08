/**
 * Tests for SQL identifier validation.
 *
 * Covers validateSqlIdentifier which prevents SQL injection in query aliases.
 * Uses representative samples rather than exhaustive keyword testing.
 */
import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/errors";
import { validateSqlIdentifier } from "../src/query/builder/validation";

describe("validateSqlIdentifier", () => {
  describe("valid identifiers", () => {
    it("accepts simple lowercase aliases", () => {
      expect(() => {
        validateSqlIdentifier("u");
      }).not.toThrow();
      expect(() => {
        validateSqlIdentifier("user");
      }).not.toThrow();
      expect(() => {
        validateSqlIdentifier("person");
      }).not.toThrow();
    });

    it("accepts aliases with underscores", () => {
      expect(() => {
        validateSqlIdentifier("my_alias");
      }).not.toThrow();
      expect(() => {
        validateSqlIdentifier("user_node");
      }).not.toThrow();
      expect(() => {
        validateSqlIdentifier("_private");
      }).not.toThrow();
    });

    it("accepts aliases with digits after first character", () => {
      expect(() => {
        validateSqlIdentifier("node1");
      }).not.toThrow();
      expect(() => {
        validateSqlIdentifier("user123");
      }).not.toThrow();
      expect(() => {
        validateSqlIdentifier("p2p_edge");
      }).not.toThrow();
    });

    it("accepts uppercase and mixed case", () => {
      expect(() => {
        validateSqlIdentifier("User");
      }).not.toThrow();
      expect(() => {
        validateSqlIdentifier("MyAlias");
      }).not.toThrow();
      expect(() => {
        validateSqlIdentifier("userNode");
      }).not.toThrow();
    });

    it("accepts maximum length identifiers (63 chars)", () => {
      const maxLength = "a".repeat(63);
      expect(() => {
        validateSqlIdentifier(maxLength);
      }).not.toThrow();
    });
  });

  describe("invalid identifier format", () => {
    it("rejects identifiers starting with a digit", () => {
      expect(() => {
        validateSqlIdentifier("1user");
      }).toThrow(ValidationError);
      expect(() => {
        validateSqlIdentifier("123");
      }).toThrow(ValidationError);
    });

    it("rejects identifiers with spaces", () => {
      expect(() => {
        validateSqlIdentifier("my alias");
      }).toThrow(ValidationError);
    });

    it("rejects identifiers with hyphens", () => {
      expect(() => {
        validateSqlIdentifier("my-alias");
      }).toThrow(ValidationError);
    });

    it("rejects identifiers with special characters", () => {
      expect(() => {
        validateSqlIdentifier("user@node");
      }).toThrow(ValidationError);
      expect(() => {
        validateSqlIdentifier("user.node");
      }).toThrow(ValidationError);
      expect(() => {
        validateSqlIdentifier("user$");
      }).toThrow(ValidationError);
    });

    it("rejects identifiers exceeding 63 characters", () => {
      const tooLong = "a".repeat(64);
      expect(() => {
        validateSqlIdentifier(tooLong);
      }).toThrow(ValidationError);
    });

    it("rejects empty string", () => {
      expect(() => {
        validateSqlIdentifier("");
      }).toThrow(ValidationError);
    });

    it("provides helpful error message for invalid format", () => {
      expect(() => {
        validateSqlIdentifier("123invalid");
      }).toThrow(/must start with a letter or underscore/);
    });
  });

  describe("reserved SQL keywords (representative samples)", () => {
    it("rejects SELECT keyword", () => {
      expect(() => {
        validateSqlIdentifier("select");
      }).toThrow(ValidationError);
      expect(() => {
        validateSqlIdentifier("SELECT");
      }).toThrow(ValidationError);
    });

    it("rejects FROM keyword", () => {
      expect(() => {
        validateSqlIdentifier("from");
      }).toThrow(ValidationError);
      expect(() => {
        validateSqlIdentifier("FROM");
      }).toThrow(ValidationError);
    });

    it("rejects WHERE keyword", () => {
      expect(() => {
        validateSqlIdentifier("where");
      }).toThrow(ValidationError);
    });

    it("rejects JOIN keywords", () => {
      expect(() => {
        validateSqlIdentifier("join");
      }).toThrow(ValidationError);
      expect(() => {
        validateSqlIdentifier("left");
      }).toThrow(ValidationError);
      expect(() => {
        validateSqlIdentifier("inner");
      }).toThrow(ValidationError);
    });

    it("rejects DDL keywords", () => {
      expect(() => {
        validateSqlIdentifier("create");
      }).toThrow(ValidationError);
      expect(() => {
        validateSqlIdentifier("drop");
      }).toThrow(ValidationError);
      expect(() => {
        validateSqlIdentifier("table");
      }).toThrow(ValidationError);
    });

    it("rejects DML keywords", () => {
      expect(() => {
        validateSqlIdentifier("insert");
      }).toThrow(ValidationError);
      expect(() => {
        validateSqlIdentifier("update");
      }).toThrow(ValidationError);
      expect(() => {
        validateSqlIdentifier("delete");
      }).toThrow(ValidationError);
    });

    it("provides helpful error message for reserved keywords", () => {
      expect(() => {
        validateSqlIdentifier("select");
      }).toThrow(/reserved SQL keyword/);
    });
  });

  describe("SQL injection prevention", () => {
    it("rejects semicolon injection attempts", () => {
      expect(() => {
        validateSqlIdentifier("user;DROP");
      }).toThrow(ValidationError);
    });

    it("rejects quote injection attempts", () => {
      expect(() => {
        validateSqlIdentifier('user"--');
      }).toThrow(ValidationError);
      expect(() => {
        validateSqlIdentifier("user'--");
      }).toThrow(ValidationError);
    });

    it("rejects comment injection attempts", () => {
      expect(() => {
        validateSqlIdentifier("user--comment");
      }).toThrow(ValidationError);
    });
  });
});
