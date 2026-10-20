/** Install research's Python dependencies in its trading-owned environment. */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = dirname(fileURLToPath(import.meta.url))
const configured = process.env.DSH_HOME
const tradingHome = configured && configured.includes('-trading') ? resolve(configured) : join(homedir(), '.dsh-trading')
const target = join(tradingHome, 'research', 'python')
const python = join(target, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const bootstrap = process.env.DSH_RESEARCH_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
function run(executable, args) {
  const result = spawnSync(executable, args, { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (!existsSync(python)) run(bootstrap, ['-m', 'venv', target])
run(python, ['-m', 'pip', '--disable-pip-version-check', 'install', '-r', join(root, 'runtime/.agents/skills/data-access/scripts/requirements.txt')])
console.log('Research Python environment ready:', target)
