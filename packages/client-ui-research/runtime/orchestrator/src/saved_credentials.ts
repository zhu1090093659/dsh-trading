/**
 * 设置页可以保存的选填凭据(垂类在 `Plugin.savedCredentials` 里声明)。
 *
 * Core 只管三件事:按凭据变量名取值时先问垂类、设置接口的读写、远程访问模式下不许在页面改。
 * 这项凭据叫什么、怎么校验、怎么打码、存在哪个文件,都由垂类实现 ——
 * 原来某个数据源专用的联系方式整套写在 Core 里(第四轮审计 A6)。
 */
import { currentPlugin, type SavedCredential } from "./plugin.ts";

/** 垂类校验不通过时抛这个:code 与提示原样交给页面(别的异常照常当内部错误) */
export class CredentialError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CredentialError";
    this.code = code;
  }
}

/** 按设置接口名找凭据;没声明 = undefined */
export function savedCredential(id: string): SavedCredential | undefined {
  return currentPlugin().savedCredentials?.find((c) => c.id === id);
}

/**
 * 端点 / 工具声明的凭据变量取什么值:垂类声明过「设置页可保存」的,按垂类给的口径取;
 * 其余只认服务进程自己的环境变量。空串当没设。
 */
export function authEnvValue(name: string, dataRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const c = currentPlugin().savedCredentials?.find((x) => x.envVar === name);
  if (c) return c.value(dataRoot, env) ?? undefined;
  return env[name] || undefined;
}
