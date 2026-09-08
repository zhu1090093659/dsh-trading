#!/bin/bash
# spikes/launch.sh — 并发启动 5 个 spike agent（后台 headless 会话）
# 用法: spikes/launch.sh [profile]   默认 profile=spike-runner
set -u
PROFILE="${1:-spike-runner}"
ROOT=/Users/zcl/code/dsh-trading/spikes
# dsh-trading 独立 home wrapper（= DSH_HOME=~/.dsh-trading dsh，2026-09-08 分离）
DSH="${DSH_BIN:-$HOME/.local/bin/dsh-trading}"
for d in s1-bundle-install s2-skill-provider s3-preset s4-services-recon s5-scaffold-design; do
  if [ -f "$ROOT/$d/PROMPT.md" ]; then
    mkdir -p "$ROOT/$d"
    ( cd "$ROOT/$d" && "$DSH" --profile "$PROFILE" "$(cat PROMPT.md)" > agent.out.log 2>&1 ) &
    echo "launched $d (pid $!)"
  fi
done
echo "5 spikes launched; logs at spikes/<dir>/agent.out.log"
