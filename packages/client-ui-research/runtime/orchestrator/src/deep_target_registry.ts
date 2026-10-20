/** Deep 对象解析器的进程级注册槽；具体实现由产品入口的 Plugin 注册。 */
import type { DeepTargetResolver } from "./engines/deep_engine.ts";

export type DeepTargetResolverFactory = (dataRoot: string) => DeepTargetResolver;

let factory: DeepTargetResolverFactory | null = null;

export function registerDeepTargetResolver(next: DeepTargetResolverFactory): void {
  if (factory && factory !== next) throw new Error("Deep 对象解析器已经注册");
  factory = next;
}

export function deepTargetResolverFor(dataRoot: string): DeepTargetResolver {
  if (!factory) throw new Error("未注册 Deep 对象解析器");
  return factory(dataRoot);
}
