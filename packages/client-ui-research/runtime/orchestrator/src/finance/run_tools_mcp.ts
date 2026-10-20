#!/usr/bin/env node
/**
 * 受控执行层的 **MCP 入口**(stdio)。
 *
 * Codex 的 Windows PowerShell Hook 存在上游缺口,因此 Windows 研究线程不开放 Shell、
 * 也不给 workspace 写权限;模型只能经这里读取本次运行的净化产物、调用确定性 calc、写当前阶段 JSON / 报告。
 *
 * ⚠️ **工具的实现与 schema 都不在这里**,在 Core 的 `../run_tools.ts`:
 *    那五件事换个垂类一行都不用重写,而直连引擎也要用同一份定义与同一次校验。
 *    本文件只做两件事:把 registry 适配成 MCP 服务器,以及作为独立进程的入口。
 *    ⇒ 新增 / 修改工具请去改 registry,**不要在这里另写一套注册**(那就又有两份 schema 了)。
 *
 * 路径不能动:`runner.ts` 是按这个文件路径把它当 MCP 服务器拉起来的,装机载荷清单也按路径打包。
 */
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { RUN_TOOLS, RunToolsError, callRunTool, type RunToolsContext } from "../run_tools.ts";
import { productVersion } from "../version.ts";
import "./register.ts";

// 兼容既有导入方(测试与将来的直连适配器都从这里取过):实现的唯一出处仍是 ../run_tools.ts
export {
  MAX_READ_CHARS, RUN_TOOLS, RunToolsError, callRunTool, listRunFiles, readRunFile,
  runCalculation, runToolByName, runToolsAsFunctionSpecs, writeReport, writeStageOutput,
  type RunToolDef, type RunToolsContext,
} from "../run_tools.ts";

function result(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function wrap<T>(fn: () => T) {
  try { return result(fn()); }
  catch (error) {
    if (error instanceof RunToolsError) return result({ error: error.code, message: error.message }, true);
    console.error(`[vra-run-tools] ${error instanceof Error ? error.message : String(error)}`);
    return result({ error: "internal" }, true);
  }
}

export function buildRunToolsServer(ctx: RunToolsContext): McpServer {
  const server = new McpServer({ name: "vra-run-tools", version: productVersion() });
  for (const def of RUN_TOOLS) {
    // 注册用的是 registry 里那份 inputShape;执行走 callRunTool —— 与直连引擎同一个入口、同一次校验。
    server.registerTool(def.name, { title: def.title, description: def.description, inputSchema: def.inputShape },
      (args: unknown) => wrap(() => callRunTool(ctx, def.name, args)));
  }
  return server;
}

function contextFromEnv(): RunToolsContext {
  const runDir = process.env.VRA_RUN_DIR;
  const repoRoot = process.env.VRA_REPO_ROOT;
  const python = process.env.VRA_PYTHON;
  if (!runDir || !repoRoot || !python) throw new RunToolsError("missing_context", "缺少 VRA_RUN_DIR / VRA_REPO_ROOT / VRA_PYTHON");
  return { runDir: path.resolve(runDir), repoRoot: path.resolve(repoRoot), python };
}

async function main(): Promise<void> {
  await buildRunToolsServer(contextFromEnv()).connect(new StdioServerTransport());
}

if (process.argv[1] && /run_tools_mcp\.ts$/i.test(process.argv[1])) {
  main().catch((error) => { console.error(`[vra-run-tools] ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
}
