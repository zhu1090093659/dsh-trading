#!/usr/bin/env node
/**
 * bili_transcribe.js — ASR 分段转写（断点续传 + 限流退避）
 *
 * 用法:
 *   node bili_transcribe.js <工作目录> [--limit N]
 *   --limit N: 只转写前N个缺失分段（冒烟测试/成本控制用，正式跑不要加）
 *
 * 输入: <工作目录>/chunks/chunk_000.wav ...
 * 输出: <工作目录>/transcript_full.json  [{index, start:"HH:MM:SS", text}]
 *       <工作目录>/transcript_full.txt   全文拼接
 *
 * 特性:
 *   - 断点续传: 每段成功立即写盘，中断后重跑自动跳过已完成段
 *   - 429限流退避: 等待 15s×尝试次数 后重试，最多5次
 *   - 段间隔8秒: 避免触发限流
 */
const fs = require('fs');
const path = require('path');

// SDK 路径兼容: 优先常规解析，失败则回退 bun 全局安装的绝对路径
let ZAI;
try {
  ZAI = require('z-ai-web-dev-sdk').default;
} catch (e) {
  ZAI = require('/home/z/.bun/install/global/node_modules/z-ai-web-dev-sdk').default;
}

const CHUNK_SEC = 29;

function fmtTs(startSec) {
  const h = String(Math.floor(startSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((startSec % 3600) / 60)).padStart(2, '0');
  const s = String(startSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

async function transcribeWithRetry(zai, filePath, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const b64 = fs.readFileSync(filePath).toString('base64');
      const resp = await zai.audio.asr.create({ file_base64: b64 });
      return (resp.text || '').trim();
    } catch (e) {
      const is429 = e.message && e.message.includes('429');
      if (attempt === maxRetries) throw e;
      const waitMs = is429 ? 15000 * attempt : 3000;
      console.log(`  第${attempt}次失败(${is429 ? '限流' : e.message.slice(0, 50)}), 等待${waitMs / 1000}秒后重试...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const workdir = path.resolve(args[0] || '');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
  const chunksDir = path.join(workdir, 'chunks');
  const outputPath = path.join(workdir, 'transcript_full.json');

  if (!fs.existsSync(chunksDir)) {
    console.error(`错误: 分段目录不存在: ${chunksDir}（请先运行 bili_fetch.py）`);
    process.exit(1);
  }

  const zai = await ZAI.create();
  const files = fs.readdirSync(chunksDir).filter(f => f.endsWith('.wav')).sort();

  // 断点续传: 载入已有结果
  let results = [];
  if (fs.existsSync(outputPath)) {
    try { results = JSON.parse(fs.readFileSync(outputPath)); } catch (e) { results = []; }
  }
  const resultMap = new Map(results.filter(r => r.text).map(r => [r.index, r]));
  const missing = files.length - resultMap.size;
  console.log(`共 ${files.length} 段, 已成功 ${resultMap.size} 段, 待转写 ${missing} 段${limit !== Infinity ? `（本次限制 ${limit} 段）` : ''}`);
  if (missing === 0) {
    console.log('RESULT: ' + JSON.stringify({ status: 'TRANSCRIBE_DONE', chunks: files.length, resumed: true }));
    return;
  }

  let doneThisRun = 0;
  for (let i = 0; i < files.length && doneThisRun < limit; i++) {
    if (resultMap.has(i)) { continue; }
    const f = files[i];
    const startTs = fmtTs(i * CHUNK_SEC);
    try {
      const text = await transcribeWithRetry(zai, path.join(chunksDir, f));
      resultMap.set(i, { index: i, start: startTs, text });
      doneThisRun++;
      console.log(`[${resultMap.size}/${files.length}] ${startTs} -> ${text ? text.slice(0, 40) + (text.length > 40 ? '...' : '') : '(空)'}`);
    } catch (e) {
      console.error(`[${i + 1}/${files.length}] ${f} 最终失败: ${e.message.slice(0, 80)}`);
    }
    // 段间隔8秒防限流；每次成功后立即写盘防丢进度
    await new Promise(r => setTimeout(r, 8000));
    fs.writeFileSync(outputPath, JSON.stringify([...resultMap.values()].sort((a, b) => a.index - b.index), null, 2));
  }

  const all = [...resultMap.values()].sort((a, b) => a.index - b.index);
  fs.writeFileSync(outputPath, JSON.stringify(all, null, 2));
  const fullText = all.map(r => r.text).filter(Boolean).join('');
  fs.writeFileSync(path.join(workdir, 'transcript_full.txt'), fullText);
  const okCount = all.filter(r => r.text).length;
  const failed = files.length - okCount;
  console.log(`\n本轮成功 ${doneThisRun} 段, 累计 ${okCount}/${files.length} 段, 总字数: ${fullText.length}`);
  if (failed > 0) {
    console.log(`⚠ 仍有 ${failed} 段未完成，请重新运行本脚本续传（已完成的段会自动跳过）`);
    console.log('RESULT: ' + JSON.stringify({ status: 'TRANSCRIBE_PARTIAL', done: okCount, total: files.length }));
    process.exit(2);
  }
  console.log('RESULT: ' + JSON.stringify({ status: 'TRANSCRIBE_DONE', chunks: files.length, chars: fullText.length }));
}

main().catch(e => { console.error('致命错误:', e.message); process.exit(1); });
