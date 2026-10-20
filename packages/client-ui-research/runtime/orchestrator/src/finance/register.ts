/**
 * 金融插件的**注册入口**。任何会走到 Core 校验 / 编排的进程,都必须先 import 这一行。
 *
 * Core(`plugin.ts` / `number_fidelity.ts`)不内联任何垂类配置,改为接受注入;
 * 金融那一份全部落在 `finance/`。词表是 `Plugin` 的一个字段,
 * `registerPlugin` 会一并注册 —— **只有这一个注册点**,不会出现"注册了包却忘了词表"。
 *
 * ⚠️ 这是**副作用 import**。架构审计指出过:Core 消费者靠副作用 import 硬接某个包,
 * 换垂类时无法靠入口 import 恢复(ESM 会缓存)。正解是从 composition root 显式注入并一路传下去。
 * 现状是过渡形态 —— 单垂类进程里成立,多垂类要等实例级 PluginRuntime。
 */
import { registerGateLabels } from "../number_gate.ts";
import { registerPlugin } from "../plugin.ts";
import { FINANCE_GATE_LABELS, FINANCE_LEXICON } from "./lexicon.ts";
import { FINANCE_PLUGIN } from "./plugin.ts";

registerPlugin(FINANCE_PLUGIN);
registerGateLabels(FINANCE_GATE_LABELS);
export { FINANCE_LEXICON, FINANCE_PLUGIN };
