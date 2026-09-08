# Agent Note: 桌面壳内置默认 home（Dock 直点可用）

Status: implemented

## Problem

DSH_HOME 分离（见 [2026-09-08-separate-dsh-home](2026-09-08-separate-dsh-home.md)）后，桌面壳 Dock 直点不带 env，resolveDshHome 回落 ~/.dsh：在旧 home 重新播种 trading-web 残株 profile、被 web 宿主 home 级 cordis.patch.yml 的第三方插件引用毒化（ERR_MODULE_NOT_FOUND 启动失败，2026-09-08 10:36 实证），且插件数据分裂。「用户须用 open -a --env 或脚本启动」对普通用户不成立——点图标就必须是对的。

## Decision

desktop/src/runtime.cjs 的 resolveDshHome 缺省从 ~/.dsh 改为 ~/.dsh-trading：这是 DSH Trading 专用壳，它管理的 home 就该内置为 trading home；显式 DSH_HOME env 仍然优先（脚本/高级用法不变）。宿主 dsh CLI 自身缺省仍是 ~/.dsh——两处缺省不同是刻意的（通用宿主 vs 专用壳）。scripts/home/dsh-trading-desktop 与 --env 启动方式继续可用，只是不再必需。

## Consequences

- Dock/访达直点桌面壳即可正确启动：播种、数据、profile 全落 ~/.dsh-trading。
- 已装旧版 app 不受此 commit 影响——本机通过重打包或就地修补生效，随下一 release 对全部用户生效。
- 测试：desktop/tests/runtime.test.mjs 断言更新（env 优先、缺省 trading home）。