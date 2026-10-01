/**
 * 构建期预压缩（P4 步骤 3）：给 dist 里的静态产物生成 .gz 兄弟文件。
 *
 * 为什么预压缩而不是每次请求临时压：① 省 CPU；② 产物与源码同源可控（压缩结果可以被审计）；
 * ③ serveStatic 只需按 accept-encoding 协商取用，逻辑最薄。
 * 实测依据：同一份 JS 未压缩 147752 字节、gzip 后 48234 字节（约 1/3）。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const root = new URL('../dist/', import.meta.url).pathname
const COMPRESSIBLE = ['.html', '.js', '.css', '.svg', '.json', '.map']
let written = 0
let saved = 0

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full)
      continue
    }
    if (entry.endsWith('.gz') || entry.endsWith('.br')) continue
    if (!COMPRESSIBLE.some((ext) => entry.endsWith(ext))) continue
    const raw = readFileSync(full)
    const gz = gzipSync(raw, { level: 9 })
    // 压不动就不写（避免出现比原文更大的 .gz 反而拖慢）
    if (gz.length >= raw.length) continue
    writeFileSync(full + '.gz', gz)
    // brotli 同时产出：serveStatic 在客户端接受 br 时优先发它（实测 br 比 gzip 更小）
    const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
    if (br.length < raw.length) writeFileSync(full + '.br', br)
    written += 1
    saved += raw.length - gz.length
  }
}

walk(root)
process.stdout.write('[precompress] ' + String(written) + ' 个产物已预压缩，可省 ' + String(saved) + ' 字节传输' + String.fromCharCode(10))
