/**
 * 版本的**唯一真理源**:一律从 `orchestrator/package.json` 读,任何地方都不许再写字面量。
 *
 * 🔴 为什么要有这个文件:架构审计(2026-08-24)发现版本**已经分叉** ——
 * `api.ts` 的 /health 与 `mcp.ts` 的 server 版本写死 "0.5.0",而 package.json 是 "0.1.0"。
 * 对外暴露的版本号(健康检查、MCP 握手)与真实包版本不一致,发布后会变成用户可见的混乱,
 * 也让"这个 bug 在哪个版本"这类问题无从查起。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/**
 * 产品版本。读不到返回 "unknown" —— 显示层不猜、不编。
 *
 * ⚠️ **失败不缓存**:发布产物少带了 package.json 时,缓存住 "unknown" 会让整个进程一直报错误版本,
 * 而健康检查看着是"正常返回"(Codex lexicon-r1 P2)。不缓存则每次重试,恢复后立刻自愈。
 */
export function productVersion(): string {
  if (cached !== null) return cached;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim()) {
      cached = pkg.version;
      return cached;
    }
  } catch {
    // 落到下面的 unknown;**不写进 cached**
  }
  return "unknown";
}
