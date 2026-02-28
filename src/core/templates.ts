import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TemplateConfig } from "./config.js";

/**
 * Expand template variables in a string.
 * - {{WORKTREE_DIR}} → worktree slot directory name
 * - {{BRANCH_NAME}} → branch name (or empty string if vacant/detached)
 * - Unknown {{...}} patterns are left as-is.
 */
export function expandTemplate(
  content: string,
  vars: { WORKTREE_DIR: string; BRANCH_NAME: string },
): string {
  return content
    .replace(/\{\{WORKTREE_DIR\}\}/g, vars.WORKTREE_DIR)
    .replace(/\{\{BRANCH_NAME\}\}/g, vars.BRANCH_NAME);
}

/**
 * Generate template files for a single worktree slot.
 * Reads each template source from wtDir, expands variables,
 * writes to the target path in the worktree.
 * Always overwrites the target file.
 * Emits a warning to stderr if the template source file is missing.
 */
export async function generateTemplates(
  wtDir: string,
  worktreeDir: string,
  slotName: string,
  branchName: string,
  templates: TemplateConfig[],
): Promise<void> {
  const vars = { WORKTREE_DIR: slotName, BRANCH_NAME: branchName };

  for (const tmpl of templates) {
    const sourcePath = join(wtDir, tmpl.source);
    let sourceContent: string;
    try {
      sourceContent = await readFile(sourcePath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        process.stderr.write(`wt: template source not found: ${sourcePath}\n`);
        continue;
      }
      throw err;
    }

    const expanded = expandTemplate(sourceContent, vars);
    const targetPath = join(worktreeDir, tmpl.target);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, expanded, "utf8");
  }
}

/**
 * Generate templates for all worktree slots.
 */
export async function generateAllTemplates(
  wtDir: string,
  containerDir: string,
  slots: Record<string, { branch: string | null }>,
  templates: TemplateConfig[],
): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [slotName, slot] of Object.entries(slots)) {
    const worktreeDir = join(containerDir, slotName);
    const branchName = slot.branch ?? "";
    promises.push(generateTemplates(wtDir, worktreeDir, slotName, branchName, templates));
  }
  await Promise.all(promises);
}
