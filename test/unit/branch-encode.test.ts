import { describe, it, expect } from "vitest";
import { encodeBranch, decodeBranch } from "../../src/core/branch-encode.js";

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
});

describe("encoded output validity", () => {
  it("encoded output contains no forward slashes", () => {
    const branches = ["main", "feature/foo", "a/b/c", "fix/hello world"];
    for (const b of branches) {
      expect(encodeBranch(b)).not.toContain("/");
    }
  });

  it("encoded output contains no null bytes", () => {
    expect(encodeBranch("main\0branch")).not.toContain("\0");
  });
});
