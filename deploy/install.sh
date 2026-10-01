#!/usr/bin/env bash
# 三进程部署的**人来执行**入口。本脚本刻意不做任何"顺手帮你装好"的事：
# 没有显式确认就只打印计划，绝不改系统。
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "注意：安装需要 root（建 uid、写 /etc/systemd/system）。当前 uid=$(id -u)。" >&2
fi

echo "本脚本会做这些事（当前只打印计划，未执行任何系统改动）："
echo "  1) groupadd dsh-trade；useradd dsh-trade-core / dsh-trade-edge / dsh-trade-bot"
echo "  2) 建 /var/lib/dsh-trading (0700, core:dsh-trade) 与 /run/dsh-tradectl (0750)"
echo "  3) cp deploy/systemd/*.service /etc/systemd/system/ && systemctl daemon-reload"
echo "  4) 依次 start dsh-tradectl -> dsh-trading-edge -> dsh-trading-bot"
echo
echo "确认无误后自行执行 deploy/README.md『安装』一节；本脚本不代跑。"
