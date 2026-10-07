# Trading Bot GUI Stage View Integration

## Context and Architecture
- Added `@dshtrading/client-ui-bot-gui` as a private local Cordis dual-half plugin.
- **Node Half**: Mounts proxy route `/dshtrading/api/bot-gui` fenced by `connection.requestRejection(req)` (browser authentication & origin fence). Proxies `GET /:bot/cards` and `POST /:bot/commands` to configured bot edges with Bearer token authentication (`deviceId + '.' + secret`) and injects `x-dsht-caps: action:ack,action:dismiss,action:open-detail,action:retry-sync,action:approve,action:reject,action:pause,action:resume,action:kill,action:flatten,action:grant-control,action:revoke-device`.
- **Client Half**: Registers into the `tradingStageViews` Cordis service (`id: 'bot'`, `titleKey: 'stage.bot'`, `order: 5`).
- **Contract**: Inlines closed enums (`CARD_TYPES`, `FIELD_KINDS`, `ACTION_KINDS`, `CONFIRM_LEVELS`, `CARD_LIMITS`) matching satellite repo `packages/contract`.
- **Security & Confirmation**: High-risk actions (`pause`, `resume`, `kill`, `flatten`, `grant-control`, `revoke-device`) require strong confirmation via `ACTION_CONFIRM` modal dialog prior to forwarding.
- **Multi-bot**: Supports switcher selector dropdown loaded from `/dshtrading/api/bot-gui/status`.
- **Run-mode badge**: The header shows the desk's current dispatch mode derived from the cards themselves (`detectRunMode` in `blocks.tsx`): the latest `trigger-trace` card's `channel`/`mode` field decides — `demo`/`paper` renders "Paper 模拟盘", `dry-run`/`shadow` renders "dry-run 只记录", no channel evidence renders "未知". No second fact source: the mode is whatever the server's card protocol already carries (satellite `card-projector` writes `trigger.dispatch.*` channel into fields). A live "switch to paper" control would need a new server-side action kind (contract change) and does not exist client-side.
- **Decision feed pagination**: `DecisionFeed` (decision + trigger-trace cards, newest first) renders at most `DECISION_PAGE_SIZE = 5` records per page with a prev/next pager (`bot.page.*` locale keys); the page clamps when the record count shrinks, and the pager is hidden for a single page.
- **Profile Wiring**: Configured in `~/.dsh-trading/profiles/trading-web/cordis.patch.yml` (and `package.json`) with multi-bot credentials, keeping secrets out of Git.

## Verification Evidence
- `pnpm build`: clean build across all workspace packages.
- `pnpm --filter @dshtrading/client-ui-bot-gui test`: 5 test suites, 24 tests passing (includes `decision-feed.test.tsx`: 5-per-page pagination, page clamp, mixed-type counting, run-mode derivation).
- `node scripts/i18n-audit.mjs --check`: passed cleanly.
- `node scripts/test-audit.mjs`: passed cleanly.
- `node scripts/typecheck-gate.mjs`: passed cleanly.
- `node scripts/patch-id-gate.mjs`: passed cleanly.
- Live headless Chrome verification on `trading-web` profile (`http://127.0.0.1:18888`):
  - Verified presence of 「机器人」 tab in middle stage between 「行情」 and 「策略」.
  - Verified card rendering (desk-summary, position, etc.) with freshness metadata and action buttons.
  - Verified switching between configured bots (`alpha-arb` and `beta-trend`).
  - Verified `ACTION_CONFIRM` interception dialog prompt when triggering `pause` action.
