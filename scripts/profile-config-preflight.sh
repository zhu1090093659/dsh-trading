#!/usr/bin/env bash
# Profile 配置预检：在 dsh plugin install / 刷新前，抓出四类会让 profile
# 变砖或混世代的配置漂移（2026-09-03/04 与 2026-09-09 实证）：
#
#   1. 死路径 —— file:/link: 依赖指向已删除目录（@dsh 时代指向 code/dsh、
#      link: 指向已弃用 deepseek-harness checkout，目录删除后 profile 无法
#      组装/重装）。
#   2. 身份漂移 —— 行名与目标目录 package.json 的真实 name 不一致
#      （scope 改名 @dsh-trading/* → @dshtrading/* 后，profile 的 deps /
#      pnpm-workspace.yaml overrides / cordis.patch.yml name: 行没 sweep，
#      workspace:^ 解析不到同侪 → install 连锁失败）。
#   3. 闭包缺口 —— profile 依赖了 @dshtrading/* 包但 overrides 没覆盖全部
#      仓库包（#60 给 base 加 dsh-i18n 依赖后 overrides 缺行 → install 失败）。
#   4. 版本漂移 —— 已安装的 node_modules/@dshtrading/* 拷贝混世代（同族
#      fixed 版本，正常只可能全体同版本）。局部刷新留下的半新半旧拷贝会让
#      profile 组装崩：2026-09-09 trading-all 实测 0.1.5/0.1.6 混装 →
#      client-ui-trading 找不到 watchlist 新导出 + hk 的 eastmoney 行
#      market 配置在旧拷贝里不存在 → 重复注册 cn/eastmoney，启动即崩。
#
# 用法：scripts/profile-config-preflight.sh <profile> [profile ...]
#   退出码：0 = 全部通过；1 = 存在漂移（先修再 install）。
# 约定：只读检查，不改任何文件。数据解析在 node 内完成（行含冒号/引号，勿用 bash 切）；
#       JS 字符串一律双引号，外层 bash 单引号包裹，勿引入单引号。

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# dsh-trading 独立 home（2026-09-08 DSH_HOME 分离）；可用环境变量 DSH_HOME 覆盖。
DSH_HOME="${DSH_HOME:-$HOME/.dsh-trading}"

if [ $# -eq 0 ]; then
  echo "用法: $0 <profile> [profile ...]" >&2
  exit 1
fi

node -e '
const fs = require("fs");
const path = require("path");
const repo = process.argv[1];
const dshHome = process.argv[2];
const profiles = process.argv.slice(3);

let repoPkgs = [];
for (const d of fs.readdirSync(path.join(repo, "packages"))) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(repo, "packages", d, "package.json"), "utf8"));
    if (p.name && p.name.startsWith("@dshtrading/")) repoPkgs.push(p.name);
  } catch {}
}

// 提取 deps + pnpm-workspace.yaml overrides 的全部 file:/link: 行
function extractRows(dir) {
  const rows = [];
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch {}
  for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
    if (/^(file|link):/.test(spec)) rows.push({ name, spec, where: "package.json" });
  }
  const ypath = path.join(dir, "pnpm-workspace.yaml");
  if (fs.existsSync(ypath)) {
    const y = fs.readFileSync(ypath, "utf8");
    for (const line of y.split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const hit = line.match(/["\x27]?([\w.-]+\/[\w.-]+|@[\w.-]+\/[\w.-]+)["\x27]?\s*:\s*["\x27]?(file|link):([^"\x27\n]+?)["\x27]?\s*$/);
      if (hit) {
        rows.push({ name: hit[1], spec: hit[2] + ":" + hit[3].trim(), where: "pnpm-workspace.yaml" });
      }
    }
  }
  return rows;
}

let fail = 0;
for (const profile of profiles) {
  const P = path.join(dshHome, "profiles", profile);
  console.log("== 预检 profile: " + profile);
  const problems = [];
  if (!fs.existsSync(path.join(P, "package.json"))) {
    console.log("   FAIL: package.json 不存在"); fail = 1; continue;
  }

  const rows = extractRows(P);

  // 检查 1+2：死路径 + 行名身份
  for (const r of rows) {
    const target = r.spec.replace(/^(file|link):/, "");
    if (!fs.existsSync(target)) {
      problems.push("死路径: " + r.name + " -> " + target + "（目录已删除, " + r.where + "）");
      continue;
    }
    const pj = path.join(target, "package.json");
    if (fs.existsSync(pj)) {
      try {
        const real = JSON.parse(fs.readFileSync(pj, "utf8")).name;
        if (real !== r.name) {
          problems.push("身份漂移: 行名 " + r.name + " 但 " + target + " 的真实包名是 " + real + "（scope 改名没 sweep? " + r.where + "）");
        }
      } catch {}
    }
  }

  // 检查 3：依赖了 @dshtrading/* 就必须闭包覆盖全部仓库包
  const covered = new Set(rows.filter(r => r.name.startsWith("@dshtrading/")).map(r => r.name));
  const usesTrading = rows.some(r => r.name.startsWith("@dshtrading/"));
  if (usesTrading) {
    const missing = repoPkgs.filter(n => !covered.has(n));
    if (missing.length) {
      problems.push("闭包缺口: overrides 缺 " + missing.join(", "));
    }
  }

  // 检查 4：已安装 @dshtrading/* 拷贝版本必须全体一致（同族 fixed 版本）。
  // 递归但不下钻软链目录（指向宿主核心包的 symlink 会带出无关树）。
  const installed = new Map();
  const collectCopies = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const abs = path.join(dir, e.name);
      const relPath = rel + "/" + e.name;
      if (e.name === "@dshtrading") {
        let pkgs = [];
        try { pkgs = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
        for (const p of pkgs) {
          if (!p.isDirectory()) continue;
          try {
            const version = JSON.parse(fs.readFileSync(path.join(abs, p.name, "package.json"), "utf8")).version;
            if (!installed.has(version)) installed.set(version, []);
            installed.get(version).push(relPath + "/" + p.name);
          } catch {}
        }
        continue;
      }
      if (e.name === ".pnpm") continue;
      collectCopies(abs, relPath);
    }
  };
  collectCopies(path.join(P, "node_modules"), "node_modules");
  if (installed.size > 1) {
    const detail = [...installed.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([v, paths]) => v + " x" + paths.length + "（" + paths.slice(0, 3).join(", ") + (paths.length > 3 ? ", …" : "") + "）")
      .join(" / ");
    problems.push("版本漂移: node_modules/@dshtrading/* 混世代 " + detail
      + "——局部刷新残留，重装：rm -rf <profile>/node_modules/@dshtrading/* && dsh plugin --profile " + profile + " install");
  }

  // 检查 2b：cordis.patch.yml 的 name: 行不许指向历史 scope
  const patchPath = path.join(P, "cordis.patch.yml");
  if (fs.existsSync(patchPath)) {
    const patch = fs.readFileSync(patchPath, "utf8");
    for (const m of patch.matchAll(/name:\s*["\x27](@dsh\/|@dsh-trading\/)[^"\x27]+["\x27]/g)) {
      problems.push("身份漂移: cordis.patch.yml 存在历史 scope 的 name: 行");
    }
  }

  if (problems.length) {
    fail = 1;
    for (const p of problems) console.log("   FAIL " + p);
  } else {
    console.log("   OK（" + rows.length + " 条 file:/link: 行）");
  }
}
process.exit(fail);
' "$REPO" "$DSH_HOME" "$@"
