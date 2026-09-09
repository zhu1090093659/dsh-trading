# Agent Note: screener_run 逐标的 vm 编译提升为按扫描编译一次——实测无收益，撤回

Status: rejected — 两种源码体量下实测差异均在测量噪声内（V8 惰性编译使 vm.Script 编译开销可忽略，逐标的成本由 createContext 主导而其为隔离语义必须保留）

## Problem

只读审计提出：`screener_run` 扫描循环对每个标的调用 `nodeScreenerEvaluateRunner`，内部 `new vm.Script(code)` + `vm.createContext(sandbox)` 逐次重来（`packages/strategies/src/validate-node.ts:40-41`，调用点 `packages/strategies/src/plugin.ts:1207`）；扫描池上限 500，即单次自定义选股器扫描最多 500 次重复编译，审计假设为「数百 ms CPU + GC 压力」。

## Alternatives considered

- **编译一次、逐标的仅建沙箱（本优化原案）**：实现后按规范做对照基准（`spikes/bench-screener-vm-compile.mts`，同源码同 500 根日 K、200 标的、5 轮取中位数，预热后测量）：一行小源码 重编译 40.6ms vs 复用 40.2ms（中位数）；24KB 现实体量源码（200 个 helper 函数）166.8ms vs 166.6ms。差异均在噪声内。根因：V8 对 Script 只立即编译顶层，内部函数惰性编译（本例 200 个 helper 只有 2 个被调用才编译），`new vm.Script` 本身极快；逐标的真实成本是 `vm.createContext`（约 0.8ms/标的量级），而它承载「标的间零状态泄漏」的隔离语义，不能为省成本复用。
- **复用 context、逐标的重置 sandbox 键**：用户源码可改 `Math`/`Object` 等全局，复用会让前一标的的污染静默流入后一标的的判定结果；为未证实的小收益放弃隔离语义，风险大于收益，否决。
- **维持现状**：选定。审计该条的收益假设被实测推翻，不产生代码变更。

## 保留产物

- `packages/strategies/test/screener-run.test.ts` 新增「编译复用执行器逐标的建独立沙箱」回归用例（对现状代码同样成立：写 globalThis 的污染源在逐标的独立 context 下计数恒为 1）——把「逐标的零状态泄漏」这一隐含不变量固化成显式测试。
- `spikes/bench-screener-vm-compile.mts`：基准脚本留档，后续若有人再提编译复用优化可直接复跑对照。
