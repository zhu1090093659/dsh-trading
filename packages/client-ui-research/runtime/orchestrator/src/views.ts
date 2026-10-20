/**
 * 垂类注册的**界面视图**:一个名字 → 一个只读的整理函数(读台账、按需取数、整理成一屏)。
 *
 * 和 `/page/<名字>` 的区别:page 查询是一组固定的取数块,参数只有一个主体;
 * 视图可以按台账里的内容扇出取数(比如"台账里每个主体各取一次")。
 * Core 只按名字找到它、把查询串原样交过去、转发取消信号 —— 不知道视图里取了什么。
 *
 * 视图可以另带一个**写动作** `act`(走 `POST /view/<名字>`,请求体原样交过去):
 * 用于这一屏自己的整理动作(比如把旧格式的台账记录转成新格式,先备份)。
 * 🔴 读(run)永远不写盘;要写就走 act —— 写操作与台账写入同一套防护(只认 POST + JSON + Bearer)。
 */
import { ServiceError, type ServiceContext } from "./service.ts";

export interface ViewDef {
  id: string;
  label: string;
  run(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal): Promise<unknown>;
  act?(ctx: ServiceContext, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

const views = new Map<string, ViewDef>();

export function registerView(def: ViewDef): void {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(def.id)) throw new Error(`视图名不合法:${def.id}`);
  const prev = views.get(def.id);
  // 同一个定义重复登记(模块被多处导入)无害;两个不同的定义抢一个名字是写错了
  if (prev && prev !== def) throw new Error(`视图重复注册:${def.id}`);
  views.set(def.id, def);
}

export function listViews(): { id: string; label: string }[] {
  return [...views.values()].map((v) => ({ id: v.id, label: v.label }));
}

export async function runView(ctx: ServiceContext, id: string, query: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const v = views.get(id);
  if (!v) throw new ServiceError("not_found", `没有这个视图:${id}`);
  return v.run(ctx, query, signal);
}

export async function runViewAction(ctx: ServiceContext, id: string, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const v = views.get(id);
  if (!v) throw new ServiceError("not_found", `没有这个视图:${id}`);
  if (!v.act) throw new ServiceError("bad_request", `视图「${v.label}」没有写动作`);
  return v.act(ctx, body, signal);
}
