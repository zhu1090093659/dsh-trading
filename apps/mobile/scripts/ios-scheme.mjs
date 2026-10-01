#!/usr/bin/env node
/** 取 Xcode scheme 名（prebuild 生成的工程名通常等于 app.json 的 name/slug）。 */
import { readdirSync } from 'node:fs'
const dirs = readdirSync('ios').filter((name) => name.endsWith('.xcodeproj'))
if (dirs.length === 0) { console.error('ios/ 里没有 .xcodeproj，先跑 npm run prebuild:ios'); process.exit(1) }
process.stdout.write(dirs[0].replace('.xcodeproj', ''))
