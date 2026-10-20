/** 统一任务层的无模型执行器：页面查询、登记源刷新与确定性计算。 */
import { randomUUID } from "node:crypto";

import { ServiceError } from "../service.ts";
import { isTrustedRouteDecision, type DeterministicExecutor, type DeterministicOperation,
  type RouteDecision, type TaskEvent } from "../task_router.ts";

export interface DeterministicOperationExecutor {
  execute(operation: DeterministicOperation, signal?: AbortSignal): Promise<unknown>;
}

export class DeterministicEngine implements DeterministicExecutor {
  readonly id = "deterministic-v1";
  readonly target = "deterministic" as const;
  readonly #execute: DeterministicOperationExecutor["execute"];

  constructor(executor: DeterministicOperationExecutor) {
    if (!executor || typeof executor.execute !== "function") throw new TypeError("确定性执行器缺少操作适配器");
    this.#execute = executor.execute.bind(executor);
  }

  async *run(route: RouteDecision, signal?: AbortSignal): AsyncIterable<TaskEvent> {
    const runId = randomUUID();
    let sequence = 0;
    const event = (type: TaskEvent["type"], payload?: Record<string, unknown>): TaskEvent =>
      Object.freeze({ runId, taskId: route.task.id, sequence: ++sequence, type,
        ...(payload ? { payload: Object.freeze(payload) } : {}) });
    yield event("started", { routeFingerprint: route.routeFingerprint, routeReason: route.reason, executor: this.id });
    try {
      if (!isTrustedRouteDecision(route) || route.target !== "deterministic" || route.engineFamily !== "none" ||
          !route.task.operation) throw new Error("确定性执行器只接受已路由的类型化操作");
      if (signal?.aborted) throw new ServiceError("cancelled", "确定性任务已取消");
      const result = await this.#execute(route.task.operation, signal);
      if (signal?.aborted) throw new ServiceError("cancelled", "确定性任务已取消");
      yield event("artifact", { format: route.task.outputFormat, artifactType: route.task.operation.kind, result });
      yield event("completed", { routeFingerprint: route.routeFingerprint });
    } catch (error) {
      yield event("failed", {
        code: error instanceof ServiceError ? error.code : "deterministic_execution_failed",
        message: error instanceof ServiceError ? error.message : "确定性任务执行失败，请检查输入或数据源后重试",
      });
    }
  }
}
