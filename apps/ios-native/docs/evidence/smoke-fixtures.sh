#!/usr/bin/env bash
# 夹具服务器的冒烟验证：每个情形都真起一次服务、真发一次请求。
# 期望：running/restricted/stopped 拿到卡；unreachable 在连接层失败。
set -uo pipefail
cd "$(dirname "$0")"
PORT=8791
fail=0

for scenario in running restricted stopped unknown-enum; do
  node fixture-server.mjs --scenario "$scenario" --port "$PORT" >/tmp/fixture-$scenario.log 2>&1 &
  pid=$!
  # 轮询就绪（不盲目 sleep）
  ready=0
  for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ready=1; break; fi
    sleep 0.1
  done
  if [ "$ready" != "1" ]; then echo "FAIL $scenario: 服务未就绪"; kill $pid 2>/dev/null; fail=1; continue; fi

  pair=$(curl -fsS -X POST "http://127.0.0.1:$PORT/pair/redeem" -H 'content-type: application/json' -d '{"code":"c1","name":"fixture"}')
  token=$(printf '%s' "$pair" | sed -n 's/.*"deviceId":"\([^"]*\)".*"secret":"\([^"]*\)".*/\1.\2/p')
  cards=$(curl -fsS "http://127.0.0.1:$PORT/v1/cards" -H "authorization: Bearer $token")
  count=$(printf '%s' "$cards" | grep -o '"cardId"' | wc -l | tr -d ' ')
  status=$(curl -fsS "http://127.0.0.1:$PORT/a0/status" -H "authorization: Bearer $token")
  unauth=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/cards")
  echo "$scenario: cards=$count unauth_status=$unauth status=$(printf '%s' "$status" | tr -d ' ')"
  kill $pid 2>/dev/null
  wait $pid 2>/dev/null
done

# unreachable：连接层断开 ⇒ curl 必须失败
node fixture-server.mjs --scenario unreachable --port "$PORT" >/tmp/fixture-unreachable.log 2>&1 &
pid=$!
sleep 0.5
if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/a0/ping" >/dev/null 2>&1; then
  echo "FAIL unreachable: 居然拿到了响应（应当是连接层失败）"; fail=1
else
  echo "unreachable: 连接层失败（符合预期）"
fi
kill $pid 2>/dev/null

exit $fail
