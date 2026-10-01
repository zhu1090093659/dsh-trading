/**
 * 心跳产出（dead-man 第一层的前半：**看门狗要有东西可看**）。
 *
 * 设计 §13：dead-man 的触发条件是 **bot 自己心跳失活**，不是"手机连不上"。
 * 所以心跳必须落在一个**独立于 agent 会话**的地方 —— 这里用原子写的工作目录文件，
 * 看门狗（另一个进程）只读它，不需要问 bot 任何问题（bot 可能已经死了）。
 *
 * @module @dshtrading/tractl/heartbeat
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 心跳内容：时刻 + 可选世代/说明，便于事后判断"是没写还是写坏了"。 */
export interface Heartbeat {
  readonly atMs: number
  readonly note?: string | undefined
}

/**
 * 原子写心跳（临时文件 + rename）：崩溃时不会留下半个 JSON，
 * 否则看门狗会把"文件坏了"误判成"心跳停了"。
 * @param path - 心跳文件路径。
 * @param heartbeat - 内容。
 */
export function writeHeartbeat(path: string, heartbeat: Heartbeat): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = path + '.tmp'
  writeFileSync(temp, JSON.stringify(heartbeat))
  renameSync(temp, path)
}
