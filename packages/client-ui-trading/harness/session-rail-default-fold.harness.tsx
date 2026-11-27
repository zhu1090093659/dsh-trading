/**
 * 会话列默认折叠与展开联动的组件级 UI harness（scripts/ui-component-check.mjs 装载）。
 *
 * 复现真实三栏壳布局（shell-pad.css + tokens.css + SessionRail + HomeHistory +
 * foldStore 默认折叠态）：
 *   1) 启动首帧：会话列默认折叠（body[data-dshtrading-chat-folded='on']、会话列宽 0、
 *      右缘竖条折叠钮 aria-pressed='true'、中栏行情区铺到竖条左缘无错位）；
 *   2) 点「展开会话列」：会话列展开到 380px、HomeHistory 自动接卡并抹平底圆角对齐同宽；
 *   3) 再次折叠后点「新会话」：自动展开会话列、不留在折叠死角。
 */
import { createElement, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/client/tokens.css'
import '../src/client/shell-pad.css'
import { createFoldStore, RIGHT_FOLD_KEY } from '../src/client/fold-store.ts'
import { SessionRail } from '../src/client/SessionRail.tsx'
import { HomeHistory } from '../src/client/HomeHistory.tsx'
import { zh } from '../src/client/locales.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import type { RightbarStore } from '../src/client/rightbar-store.ts'

// 模拟全新打开软件：无历史折叠偏好
localStorage.removeItem(RIGHT_FOLD_KEY)

const chatFolded = createFoldStore(RIGHT_FOLD_KEY, true)
// 与 client/index.ts apply() 同款：首帧前即写入折叠属性
document.body.dataset.dshtradingChatFolded = chatFolded.getSnapshot() ? 'on' : 'off'

const rightbar: RightbarStore = {
  getSnapshot: () => false,
  subscribe: () => () => {},
}

const t = (key: MarketLocaleKey): string => (zh[key] as string) ?? key

const WORKSPACES = {
  items: [{ workspaceId: 'ws-1', title: 'cowork', path: '/tmp/cowork', sessionIds: ['s-blank', 's-1', 's-2'], createdAt: '', updatedAt: '' }],
  archivedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
}

const SESSIONS = {
  phase: 'ready',
  byId: {
    's-blank': { id: 's-blank', blank: true, origin: 'user', running: false, updatedAt: 300, displayTitle: '', retainedBy: { mainView: 1 } },
    's-1': { id: 's-1', blank: false, origin: 'user', running: false, updatedAt: 200, displayTitle: '每日大盘复盘（交易日收盘后）', retainedBy: {} },
    's-2': { id: 's-2', blank: false, origin: 'user', running: false, updatedAt: 100, displayTitle: 'A股内外盘收盘快照采集', retainedBy: {} },
  },
}

let newSessionClicks = 0

function useFolded<T>(sel: (v: boolean) => T): T {
  const value = useSyncExternalStore(chatFolded.subscribe, chatFolded.getSnapshot)
  return sel(value)
}

function useRightbar<T>(sel: (v: boolean) => T): T {
  const value = useSyncExternalStore(rightbar.subscribe, rightbar.getSnapshot)
  return sel(value)
}

function ShellDemo() {
  const folded = useSyncExternalStore(chatFolded.subscribe, chatFolded.getSnapshot)
  return createElement(
    'div',
    {
      style: {
        position: 'fixed',
        inset: 0,
        display: 'grid',
        background: '#ffffff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
      },
    },
    // child 1: 退役侧栏占位（shell-pad.css 规则 8）
    createElement('div', { 'data-mock-sidebar': '' },
      createElement(HomeHistory as never, {
        t,
        useSessions: (sel: (s: typeof SESSIONS) => unknown) => sel(SESSIONS),
        useWorkspaces: (sel: (w: typeof WORKSPACES) => unknown) => sel(WORKSPACES),
        openSession: () => {},
        startNewSession: () => {},
        renameSession: async () => {},
        forkSession: () => {},
        archiveSession: () => {},
        deleteWorkspace: async () => {},
      }),
    ),
    // child 2: 官方对话列（带 hero + composer seat）
    createElement(
      'div',
      {
        'data-mock-chat-col': '',
        style: {
          background: '#ffffff',
          borderLeft: '1px solid #e3e6ea',
          height: '100vh',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
        },
      },
      createElement(
        'div',
        {
          'data-conversation-scroll': '',
          style: {
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            justifyContent: 'center',
            padding: '24px 0',
            boxSizing: 'border-box',
          },
        },
        createElement('div', {
          style: { textAlign: 'center', fontSize: '20px', fontWeight: 600, color: '#1a1e24', marginBottom: '20px' },
        }, '探索未至之境'),
        createElement(
          'div',
          { 'data-composer-seat': '', style: { width: '100%', padding: '0 18px', boxSizing: 'border-box' } },
          createElement(
            'div',
            {
              'data-mock-composer-card': '',
              style: {
                height: '92px',
                borderRadius: '14px',
                border: '1px solid #cfd4da',
                background: '#ffffff',
                padding: '12px 14px',
                boxSizing: 'border-box',
                color: '#8a8f99',
                fontSize: '13px',
              },
            },
            '描述你想要构建的内容，/ 调用指令，@ 文件或对话',
          ),
        ),
      ),
    ),
    // child 3: 折叠的工具详情列
    createElement('div', { 'data-rightbar-col': '', style: { width: 0 } }),
    // overlay layer：模拟中栏行情区 + 真实 SessionRail
    createElement(
      'div',
      { 'data-shell-overlay': '' },
      createElement(
        'div',
        {
          'data-mock-quote-stage': '',
          style: {
            position: 'fixed',
            top: 0,
            bottom: 0,
            left: 0,
            right: folded ? '44px' : '424px',
            background: '#f7f8fa',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#1a1e24',
            fontSize: '15px',
            fontWeight: 600,
            borderRight: '1px solid #e3e6ea',
            boxSizing: 'border-box',
          },
        },
        folded ? '行情主视图（会话列默认已折叠，全宽展示）' : '行情主视图（会话列已展开）',
      ),
      createElement(SessionRail as never, {
        t,
        useFolded,
        useRightbar,
        startNewSession: () => { newSessionClicks += 1 },
        toggleFold: () => { chatFolded.toggle() },
        openSession: () => {},
        openFilesPanel: () => {},
        collapseRightbar: () => {},
      }),
    ),
  )
}

const host = document.getElementById('root') as HTMLElement
// 宿主 frame 带 data-rightbar-collapsed 标记，令第 4 轨归零
createRoot(host).render(createElement(ShellDemo))
requestAnimationFrame(() => {
  const frame = document.querySelector('div:has(> [data-shell-overlay])')
  frame?.setAttribute('data-rightbar-collapsed', 'true')
})

const metrics = () => {
  const chatCol = document.querySelector('[data-mock-chat-col]') as HTMLElement | null
  const rail = document.querySelector('[data-dshtrading-rail]') as HTMLElement | null
  const stage = document.querySelector('[data-mock-quote-stage]') as HTMLElement | null
  const card = document.querySelector('[data-mock-composer-card]') as HTMLElement | null
  const history = document.querySelector('div[data-dshtrading-home-history]') as HTMLElement | null
  const foldBtn = rail?.querySelector('button') as HTMLButtonElement | null
  return {
    attr: document.body.dataset.dshtradingChatFolded ?? '',
    chatW: chatCol ? Math.round(chatCol.getBoundingClientRect().width) : -1,
    railLeft: rail ? Math.round(rail.getBoundingClientRect().left) : -1,
    stageRight: stage ? Math.round(stage.getBoundingClientRect().right) : -1,
    foldPressed: foldBtn?.getAttribute('aria-pressed') ?? '',
    foldLabel: foldBtn?.getAttribute('aria-label') ?? '',
    cardW: card ? Math.round(card.getBoundingClientRect().width) : -1,
    cardLeft: card ? Math.round(card.getBoundingClientRect().left) : -1,
    cardRadius: card ? card.style.borderBottomLeftRadius : '',
    historyW: history ? Math.round(history.getBoundingClientRect().width) : -1,
    historyLeft: history ? Math.round(history.getBoundingClientRect().left) : -1,
    newSessionClicks,
  }
}

;(window as unknown as Record<string, unknown>).__h = { metrics }
;(window as unknown as Record<string, unknown>).__uiHarness = {
  ready: new Promise<void>((resolve) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => resolve()) })
  }),
  steps: [
    {
      name: '01-initial-folded',
      expect: `(() => {
        const m = __h.metrics();
        const ok = m.attr === 'on'
          && m.chatW === 0
          && m.foldPressed === 'true'
          && m.foldLabel === '展开会话列'
          && Math.abs(m.stageRight - m.railLeft) <= 1;
        return { ok, detail: JSON.stringify(m) };
      })()`,
    },
    {
      name: '02-after-expand',
      run: `(() => {
        document.querySelector('button[aria-label="展开会话列"]').click();
        return new Promise((r) => setTimeout(r, 120));
      })()`,
      expect: `(() => {
        const m = __h.metrics();
        const ok = m.attr === 'off'
          && m.chatW === 380
          && m.foldPressed === 'false'
          && m.foldLabel === '折叠会话列'
          && m.cardRadius === '0px'
          && m.cardW > 200
          && Math.abs(m.historyW - m.cardW) <= 1
          && Math.abs(m.historyLeft - m.cardLeft) <= 1;
        return { ok, detail: JSON.stringify(m) };
      })()`,
    },
    {
      name: '03-refold-then-new-session-expands',
      run: `(() => {
        document.querySelector('button[aria-label="折叠会话列"]').click();
        return new Promise((r) => setTimeout(() => {
          document.querySelector('button[aria-label="新会话"]').click();
          setTimeout(r, 120);
        }, 80));
      })()`,
      expect: `(() => {
        const m = __h.metrics();
        const ok = m.attr === 'off'
          && m.chatW === 380
          && m.foldPressed === 'false'
          && m.newSessionClicks === 1;
        return { ok, detail: JSON.stringify(m) };
      })()`,
    },
  ],
}
