/** Stdio adapter for a single live API-owned turn; no model credentials or filesystem tools. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { productVersion } from "./version.ts";
import fs from "node:fs";

async function main() {
  const url = process.env.VRA_ASSISTANT_URL ?? "";
  const tokenFile = process.env.VRA_ASSISTANT_TOKEN_FILE;
  const token = tokenFile ? fs.readFileSync(tokenFile, "utf8") : "";
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(url) || !/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid_context");
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(310_000),
    });
    if (!response.ok) throw new Error("bridge_request_failed");
    return response.json();
  };
  const server = new Server({ name: "vra-assistant", version: productVersion() }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await request("/tools") }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try { return await request("/call", { name: params.name, arguments: params.arguments ?? {} }); }
    catch { return { isError: true, content: [{ type: "text", text: "工具连接结束或执行失败，请重试。" }] }; }
  });
  await server.connect(new StdioServerTransport());
}
main().catch(() => { console.error("[vra-assistant] Bridge unavailable"); process.exitCode = 1; });
