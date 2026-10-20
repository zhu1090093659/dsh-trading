import { Outlet, useNavigation } from "react-router-dom";
import { AiPageProvider } from "../../../../core/ai/pageContext";
import { useDarkMode } from "@/hooks/useDarkMode";

/** Research occupies the terminal content pane; the terminal owns primary navigation. */
export function Layout() {
  const navigation = useNavigation();
  useDarkMode();
  return <AiPageProvider>
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground" data-research-workspace="">
      <main id="workspace-main" tabIndex={-1} className="min-h-0 flex-1 overflow-auto">
        <div className="workspace-content relative" aria-busy={navigation.state !== "idle"}>
          {navigation.state !== "idle" && <>
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-primary/70" />
            <span role="status" className="sr-only">正在切换页面</span>
          </>}
          <Outlet />
        </div>
      </main>
    </div>
  </AiPageProvider>;
}
