import type { InferValue, JsonValueSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/**
 * 官方 jsonOutput 形态：声明完整 value schema + 紧凑 JSON render。
 *
 * render 与 schema 同源——模型读到的文本就是被运行时按同一 schema 校验过的值；
 * execute 的返回结构因此受编译器检查（InferValue），而非自行 JSON.stringify。
 * base 内部共享（market-tools / research-tools 两个入口），不跨包分发。
 */
export function jsonOutput<const S extends ValueSchemaSpec>(schema: S) {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
}

/**
 * 类型级桥（单值）：连接器/服务返回的是 JSON 载荷（api 的 Orderbook / Position / Order 等），
 * 但它们带可选字段、没有索引签名，结构上不满足 SDK 的 JsonValue，无法直接放进
 * `type: 'json'` 字段。运行时校验与渲染仍走同一 schema；这里只消除类型层的结构失配，
 * 不做任何值变换（原样传递）。
 */
export function jsonPayload<T>(value: T): InferValue<JsonValueSchemaSpec> {
  return value as InferValue<JsonValueSchemaSpec>
}

/** 类型级桥（数组）：与 jsonPayload 同理，对齐 `type: 'array'` 的 items 推断。 */
export function jsonItems<T>(values: readonly T[]): Array<InferValue<JsonValueSchemaSpec>> {
  return values as unknown as Array<InferValue<JsonValueSchemaSpec>>
}
