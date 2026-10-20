import { createMemoryRouter, Navigate, useLocation } from "react-router-dom";
import { RouteErrorPage } from "../../core/components/RouteErrorPage";
import { Layout } from "@/components/layout/Layout";
import { Home } from "@/pages/Home";
import { Settings } from "@/pages/Settings";
import { movedUrl } from "@/lib/nav";

/** 搬了家的旧地址（收藏的书签、旧提醒里的链接）：带着原来的查询参数跳到新页面 */
function Moved({ to, tab }: { to: string; tab?: string }) {
  const { search, hash } = useLocation();
  return <Navigate replace to={movedUrl(to, search, hash, tab)} />;
}

export const createResearchRouter = (initialPath = "/") => createMemoryRouter([
  {
    element: <Layout />,
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <p role="status" className="p-6 text-sm text-muted-foreground">正在打开研究工作台…</p>,
    children: [
      { path: "/", element: <Home /> },
      { path: "/daily-review", lazy: async () => ({ Component: (await import("@/pages/DailyReview")).DailyReview }) },
      { path: "/intel", lazy: async () => ({ Component: (await import("@/pages/Intel")).Intel }) },
      { path: "/intel/:tab", lazy: async () => ({ Component: (await import("@/pages/Intel")).Intel }) },
      { path: "/signals", lazy: async () => ({ Component: (await import("@/pages/Signals")).Signals }) },
      { path: "/signals/:tab", lazy: async () => ({ Component: (await import("@/pages/Signals")).Signals }) },
      { path: "/sectors", lazy: async () => ({ Component: (await import("@/pages/Sectors")).Sectors }) },
      { path: "/sectors/:key", lazy: async () => ({ Component: (await import("@/pages/SectorDetail")).SectorDetail }) },
      { path: "/candidates", lazy: async () => ({ Component: (await import("@/pages/Candidates")).Candidates }) },
      { path: "/my-stocks", lazy: async () => ({ Component: (await import("@/pages/MyStocks")).MyStocks }) },
      { path: "/calendar", lazy: async () => ({ Component: (await import("@/pages/Calendar")).Calendar }) },
      { path: "/backtest", lazy: async () => ({ Component: (await import("@/pages/Backtest")).Backtest }) },
      { path: "/research", lazy: async () => ({ Component: (await import("@/pages/Research")).Research }) },
      { path: "/debate", lazy: async () => ({ Component: (await import("@/pages/Debate")).DebatePage }) },
      { path: "/my-reports", lazy: async () => ({ Component: (await import("@/pages/MyReports")).MyReports }) },
      { path: "/notes", lazy: async () => ({ Component: (await import("@/pages/Notes")).Notes }) },
      { path: "/inbox", lazy: async () => ({ Component: (await import("@/pages/Inbox")).Inbox }) },
      { path: "/settings", element: <Settings /> },
      // 旧地址保留兼容（收藏的书签、旧提醒里的链接）：自选和持仓并成「自选与持仓」。
      // 多空辩论 10-09 又回到单独一页（/debate）；个股页旧的 ?tab=debate 由个股页自己跳过去。
      { path: "/stock-data", element: <Moved to="/research" /> },
      { path: "/watchlist", element: <Moved to="/my-stocks" tab="watch" /> },
      { path: "/portfolio", element: <Moved to="/my-stocks" tab="hold" /> },
    ],
  },
], { initialEntries: [initialPath] });
