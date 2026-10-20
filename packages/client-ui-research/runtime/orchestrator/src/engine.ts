/**
 * **大脑契约**(Core)。
 *
 * 一次运行 = 六阶段状态机 + 一个大脑。状态机、取数、校验、gate、收工守卫、归档全部与大脑无关且只有一份;
 * 大脑只负责**跑一个 turn**(见 agent_runner.ts 的 AgentRunner),并且只能通过产品受控工具读写运行目录。
 *
 * 🔴 **为什么要有 capabilities 这一层**:不同大脑产出**相同的产物**,但**执行保障等级不同**
 *    (结构化输出是服务端约束还是写进提示词、审计事件来自哪里)。validator 挡得住不合格产物,
 *    挡不住"这一轮的保障比上一轮弱"。⇒ 差异必须**显式声明**并写进 manifest,
 *    让界面把「产物通过校验」与「执行保障等级」分开讲,不要混成一个 ✅。
 */

/** 大脑能力声明:原样写进 manifest.engine.capabilities */
export interface EngineCapabilities {
  /** 大脑种类 */
  kind: "direct" | "local_agent";
  /** 与模型对话的线路:OpenAI 兼容 Chat Completions,还是用户本机已登录的订阅 CLI */
  protocol: "chat_completions" | "cli_subscription";
  /** 宿主隔离方式:模型拿不到执行宿主命令的工具,只有产品受控工具(工具白名单即边界) */
  sandbox: "model_has_no_host_access";
  /** v1 字段:引擎级 lifecycle hooks。v2 恒为 false(收工守卫由产品自己执行,见 stop_guard.ts) */
  hooks: false;
  /** 跨阶段上下文:每阶段独立会话,靠已校验的磁盘产物传递 */
  contextStrategy: "per_stage_session";
  /** 结构化输出:服务端 JSON Schema 约束,还是只能写进提示词 */
  structuredOutput: "server_schema" | "prompt";
  /** 审计视角:事件由本产品在宿主侧记录(拿不到大脑内部视角) */
  auditLevel: "host_events";
  /** 方法论来源:宪法与阶段 skills 由产品写进每个阶段的提示词 */
  methodology: "constitution_and_skills";
}

/** 一次运行实际选中的大脑信息;用于写 manifest,不能再从配置默认值反推。 */
export interface EngineRuntime {
  kind: EngineCapabilities["kind"];
  /** 本机 CLI 版本(如 `claude/2.1.3`),或 `direct-api/<provider>/<model>` */
  version: string;
  binary: string | null;
  model: string | null;
}

export function directCapabilities(structuredOutput: "server_schema" | "prompt"): EngineCapabilities {
  return {
    kind: "direct", protocol: "chat_completions", sandbox: "model_has_no_host_access", hooks: false,
    contextStrategy: "per_stage_session", structuredOutput, auditLevel: "host_events", methodology: "constitution_and_skills",
  };
}

export function localAgentCapabilities(): EngineCapabilities {
  return {
    kind: "local_agent", protocol: "cli_subscription", sandbox: "model_has_no_host_access", hooks: false,
    contextStrategy: "per_stage_session", structuredOutput: "prompt", auditLevel: "host_events", methodology: "constitution_and_skills",
  };
}
