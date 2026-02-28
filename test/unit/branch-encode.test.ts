import { describe, expect, it } from "vitest";
import { decodeBranch, encodeBranch } from "../../src/core/branch-encode.js";

describe("encodeBranch", () => {
  it("leaves simple branch names unchanged", () => {
    expect(encodeBranch("main")).toBe("main");
    expect(encodeBranch("my-branch")).toBe("my-branch");
  });

  it("replaces / with --", () => {
    expect(encodeBranch("feature/my-branch")).toBe("feature--my-branch");
  });

  it("replaces nested / correctly", () => {
    expect(encodeBranch("feature/nested/deep")).toBe("feature--nested--deep");
  });

  it("percent-encodes spaces", () => {
    expect(encodeBranch("fix/hello world")).toBe("fix--hello%20world");
  });

  it("preserves dots and version numbers", () => {
    expect(encodeBranch("release/v1.0")).toBe("release--v1.0");
  });

  it("produces output with no forward slashes", () => {
    const encoded = encodeBranch("a/b/c/d");
    expect(encoded).not.toContain("/");
  });

  it("encodes double-dots to prevent path traversal", () => {
    const encoded = encodeBranch("some..branch");
    expect(encoded).not.toContain("..");
  });

  it("encodes leading dot", () => {
    const encoded = encodeBranch(".hidden");
    expect(encoded).not.toMatch(/^\./);
  });

  // BUG-034: literal "--" in branch names must not collide with the "/" separator
  it("escapes literal -- in branch names (BUG-034)", () => {
    expect(encodeBranch("feature--test")).toBe("feature%2D%2Dtest");
  });

  it("produces different encodings for feature--test and feature/test (BUG-034)", () => {
    expect(encodeBranch("feature--test")).not.toBe(encodeBranch("feature/test"));
  });

  it("escapes multiple -- sequences (BUG-034)", () => {
    expect(encodeBranch("a--b--c")).toBe("a%2D%2Db%2D%2Dc");
  });

  it("handles branch with both -- and / (BUG-034)", () => {
    // feature/--/test: "/" → "--", "--" → "%2D%2D"
    expect(encodeBranch("feature/--/test")).toBe("feature--%2D%2D--test");
  });

  it("handles triple dashes: first -- is escaped, remaining - passes through (BUG-034)", () => {
    expect(encodeBranch("a---b")).toBe("a%2D%2D-b");
  });
});

describe("decodeBranch", () => {
  it("round-trips: decodeBranch(encodeBranch(x)) === x", () => {
    const cases = [
      "main",
      "feature/my-branch",
      "feature/nested/deep",
      "fix/hello world",
      "release/v1.0",
      "my-branch",
      "some..branch",
      ".hidden",
      // BUG-034: branches with literal "--"
      "feature--test",
      "a--b--c",
      "feature/--/test",
      "a---b",
    ];
    for (const c of cases) {
      expect(decodeBranch(encodeBranch(c))).toBe(c);
    }
  });

  it("decodes percent-encoded characters", () => {
    expect(decodeBranch("fix--hello%20world")).toBe("fix/hello world");
  });

  it("decodes -- back to /", () => {
    expect(decodeBranch("feature--my-branch")).toBe("feature/my-branch");
  });

  // BUG-034: %2D%2D must decode back to "--", not "/"
  it("decodes %2D%2D back to -- (BUG-034)", () => {
    expect(decodeBranch("feature%2D%2Dtest")).toBe("feature--test");
  });

  it("decodes mixed -- and %2D%2D correctly (BUG-034)", () => {
    // "feature--%2D%2D--test" should decode to "feature/--/test"
    expect(decodeBranch("feature--%2D%2D--test")).toBe("feature/--/test");
  });
});

describe("encoded output validity", () => {
  it("encoded output contains no forward slashes", () => {
    const branches = ["main", "feature/foo", "a/b/c", "fix/hello world", "feature--test"];
    for (const b of branches) {
      expect(encodeBranch(b)).not.toContain("/");
    }
  });

  it("encoded output contains no null bytes", () => {
    expect(encodeBranch("main\0branch")).not.toContain("\0");
  });

  // BUG-034: injectivity — distinct inputs must produce distinct outputs
  it("encoding is injective: no two branch names produce the same encoded form (BUG-034)", () => {
    const pairs: [string, string][] = [
      ["feature/test", "feature--test"],
      ["a/b", "a--b"],
      ["x/y/z", "x--y--z"],
      ["a--b--c", "a/b/c"],
    ];
    for (const [a, b] of pairs) {
      expect(encodeBranch(a)).not.toBe(encodeBranch(b));
    }
  });
});
