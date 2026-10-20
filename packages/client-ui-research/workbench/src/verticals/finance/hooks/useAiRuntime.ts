import { useEffect, useState } from "react";

import { AI_RUNTIME_CHANGED, LLM_KEY, readAiRuntime } from "@/lib/llmStore";
import { workspaceStorageKey } from "@/lib/workspace";

export function useAiRuntime() {
  const [runtime, setRuntime] = useState(() => readAiRuntime());
  useEffect(() => {
    const refresh = () => setRuntime(readAiRuntime());
    const storage = (event: StorageEvent) => { if (event.key === workspaceStorageKey(LLM_KEY) || event.key === null) refresh(); };
    globalThis.addEventListener(AI_RUNTIME_CHANGED, refresh);
    globalThis.addEventListener("storage", storage);
    return () => {
      globalThis.removeEventListener(AI_RUNTIME_CHANGED, refresh);
      globalThis.removeEventListener("storage", storage);
    };
  }, []);
  return runtime;
}
