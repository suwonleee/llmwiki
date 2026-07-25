import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../src/engine/frontmatter.ts";

describe("parseFrontmatter", () => {
  test("parses supported scalar and inline-list fields into derived metadata", () => {
    // Given: a complete wiki-page frontmatter block.
    const content = [
      "---",
      "title: Index metadata",
      "description: Index only typed derived metadata.",
      "date: 2026-07-23",
      'tags: [index, "frontmatter", typed]',
      "status: ready",
      "tier: warm",
      "domain: milestone",
      "---",
      "",
      "The body stays source-of-truth markdown.",
    ].join("\n");
    // When: the file boundary is parsed.
    const metadata = parseFrontmatter(content);

    // Then: normalized metadata is typed while raw supported fields remain available to lint.
    expect(metadata.title).toBe("Index metadata");
    expect(metadata.description).toBe("Index only typed derived metadata.");
    expect(metadata.date).toBe("2026-07-23");
    expect(metadata.tags).toEqual(["index", "frontmatter", "typed"]);
    expect(metadata.status).toBe("ready");
    expect(metadata.tier).toBe("warm");
    expect(metadata.fields["domain"]).toBe("milestone");
  });

  test("protects missing or malformed metadata from ageable derived values", () => {
    // Given: unsupported status/tier values and an impossible calendar date.
    const content = [
      "---",
      "title: Untrusted metadata",
      "date: 2026-02-30",
      "tags: [one]",
      "status: pending",
      "tier: L9",
      "---",
      "",
      "Body.",
    ].join("\n");
    // When: the file boundary is parsed.
    const metadata = parseFrontmatter(content);

    // Then: invalid derived values stay absent instead of acquiring unsafe semantics.
    expect(metadata.date).toBeNull();
    expect(metadata.status).toBeNull();
    expect(metadata.tier).toBeNull();
    expect(metadata.tags).toEqual(["one"]);
  });

  test("uses a valid updated field when date is absent", () => {
    // Given: a page that only records its update date.
    const content = "---\ntitle: Updated only\nupdated: 2026-07-24\n---\nbody";

    // When: the file boundary is parsed.
    const metadata = parseFrontmatter(content);

    // Then: the valid date is eligible for derived indexing.
    expect(metadata.date).toBe("2026-07-24");
  });
});
