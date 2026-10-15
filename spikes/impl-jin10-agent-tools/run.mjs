#!/usr/bin/env node
/**
 * 金十 agent 工具面两处补齐的现场取证脚本 —— B 交付证据的一次性复现入口。
 *
 * 真实网络（无凭证路径）：热度快讯走网页版公开接口、央行利率走网页版公开利率接口，
 * 两者都不需要金十 MCP Token；因此本脚本能真跑，不需要读取 profile 里的密钥。
 *
 * 用法（在 worktree 根）：
 *   node spikes/impl-jin10-agent-tools/run.mjs
 */
import { join } from 'node:path'
import process from 'node:process'

const ROOT = new URL('../..', import.meta.url).pathname
const { Jin10McpClient } = await import(join(ROOT, 'packages/connector-jin10/lib/mcp.js'))
const { Jin10Service } = await import(join(ROOT, 'packages/connector-jin10/lib/service.js'))
const { createJin10Tools } = await import(join(ROOT, 'packages/connector-jin10/lib/tools.js'))

/** MCP 半的 token 缺席（本机 env 与 profile 都未提供）；本次取证只用网页版公开路径。 */
const service = new Jin10Service(new Jin10McpClient({
  endpoint: 'https://mcp.jin10.com/mcp',
  token: () => process.env.JIN10_MCP_TOKEN,
  timeoutMs: 15_000,
}), { timeoutMs: 15_000 })

const tools = new Map(createJin10Tools(service).map(tool => [tool.name, tool]))
const out = { tool_names: [...tools.keys()] }

out.flash_list_hot_all = JSON.parse(JSON.stringify(String(await tools.get('flash_list').execute({ hot: '火,热,沸,爆' }))))
out.flash_list_hot_two_limited = String(await tools.get('flash_list').execute({ hot: '热,爆', limit: 3 }))
try {
  out.flash_list_without_hot = String(await tools.get('flash_list').execute({}))
} catch (error) {
  out.flash_list_without_hot = `ERROR ${error?.code ?? ''}: ${error?.message ?? String(error)}`
}
try {
  out.flash_list_bad_hot = String(await tools.get('flash_list').execute({ hot: '烫' }))
} catch (error) {
  out.flash_list_bad_hot = `ERROR: ${error?.message ?? String(error)}`
}
out.macro_rates_all = JSON.parse(String(await tools.get('macro_rates').execute({})))
out.macro_rates_us = JSON.parse(String(await tools.get('macro_rates').execute({ region: '美国' })))
out.macro_rates_miss = JSON.parse(String(await tools.get('macro_rates').execute({ region: '火星' })))

process.stdout.write(JSON.stringify(out, null, 1) + '\n')
