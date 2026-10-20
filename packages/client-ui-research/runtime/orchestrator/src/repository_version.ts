import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Optional provenance must not block research or discover an installer's parent checkout. */
export function repositoryVersion(repoRoot: string, run: typeof spawnSync = spawnSync): string {
  if (!fs.existsSync(path.join(repoRoot, ".git"))) return "source-archive(no-git)";
  try {
    const result = run("git", ["rev-parse", "--verify", "-q", "HEAD"], {
      cwd: repoRoot, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4096, windowsHide: true,
    });
    const revision = result.stdout?.trim() ?? "";
    if (!result.error && result.status === 0 && /^[a-f0-9]{40,64}$/i.test(revision)) return revision;
  } catch { /* Version metadata is optional, not a research prerequisite. */ }
  return "unknown(git-unavailable)";
}
