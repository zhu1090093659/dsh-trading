/** 错误 / stderr 脱敏：去 URL 查询串、遮蔽 key/token/secret/password 赋值、截断。 */
export function redact(s: string, max = 300): string {
  return String(s ?? "")
    .replace(/([?&][^=\s&]*(key|token|secret|sig|signature|password|access)[^=\s&]*=)[^&\s]+/gi, "$1***")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/g, "$1?…")
    .replace(/((api[_-]?key|secret|token|password|authorization)\s*[:=]\s*)\S+/gi, "$1***")
    .slice(-max);
}
