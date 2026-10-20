/** Check the UI and its authenticated API proxy without exposing the bearer token. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export async function productUiReady(baseUrl = "http://127.0.0.1:5930", timeoutMs = 1_000): Promise<boolean> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const [ui, api] = await Promise.all([
      fetch(`${baseUrl}/`, { signal }), fetch(`${baseUrl}/api/health`, { signal }),
    ]);
    if (!ui.ok || !api.ok || !ui.headers.get("content-type")?.includes("text/html")) return false;
    const [html, health] = await Promise.all([ui.text(), api.json()]);
    return /<div\b[^>]*\bid=["']root["']/.test(html) && health?.ok === true &&
      typeof health.version === "string" && health.version.length > 0;
  } catch {
    return false;
  }
}

// Windows 启动器用:页面端口由它选好后经 VRA_UI_PORT 传进来(默认 5930)。
// 按真实路径比:仓库在符号链接 / 目录联接 / subst 盘符下时两边写法不同,比不上就什么都不做、退出码 0,启动器会误以为已就绪
const realPath = (p: string) => { try { return fs.realpathSync.native(p); } catch { return p; } };
if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  const port = /^\d{1,5}$/.test(process.env.VRA_UI_PORT ?? "") ? process.env.VRA_UI_PORT : "5930";
  process.exitCode = await productUiReady(`http://127.0.0.1:${port}`) ? 0 : 2;
}
