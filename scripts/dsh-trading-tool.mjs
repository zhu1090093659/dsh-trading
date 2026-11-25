#!/usr/bin/env node
/**
 * 仓库根兼容入口：转发到可随包分发的 `packages/bot-api/bin/dsh-trading-tool.mjs`，
 * 保持单一实现来源（Single Source of Truth），同时兼容既有符号链接与单测导入。
 */
import { isEntryScript, runCli } from '../packages/bot-api/bin/dsh-trading-tool.mjs'

export * from '../packages/bot-api/bin/dsh-trading-tool.mjs'

if (isEntryScript(import.meta.url)) {
  runCli(process.argv.slice(2)).then(
    (code) => { process.exit(code) },
    (error) => {
      process.stderr.write(`[dsh-trading-tool] 未捕获异常: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exit(3)
    },
  )
}
