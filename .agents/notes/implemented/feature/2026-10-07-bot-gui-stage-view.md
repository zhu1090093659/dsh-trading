# Trading Bot GUI Stage View Integration

## Context and Architecture
- Added `@dshtrading/client-ui-bot-gui` as a private local Cordis dual-half plugin.
- **Node Half**: Mounts proxy route `/dshtrading/api/bot-gui` fenced by `connection.requestRejection(req)` (browser authentication & origin fence). Proxies `GET /:bot/cards` and `POST /:bot/commands` to configured bot edges with Bearer token authentication (`deviceId + '.' + secret`) and injects `x-dsht-caps: action:ack,action:dismiss,action:open-detail,action:retry-sync,action:approve,action:reject,action:pause,action:resume,action:kill,action:flatten,action:grant-control,action:revoke-device`.
- **Client Half**: Registers into the `tradingStageViews` Cordis service (`id: 'bot'`, `titleKey: 'stage.bot'`, `order: 5`).
- **Contract**: Inlines closed enums (`CARD_TYPES`, `FIELD_KINDS`, `ACTION_KINDS`, `CONFIRM_LEVELS`, `CARD_LIMITS`) matching satellite repo `packages/contract`.
- **Security & Confirmation**: High-risk actions (`pause`, `resume`, `kill`, `flatten`, `grant-control`, `revoke-device`) require strong confirmation via `ACTION_CONFIRM` modal dialog prior to forwarding.
- **Multi-bot**: Supports switcher selector dropdown loaded from `/dshtrading/api/bot-gui/status`.
- **Profile Wiring**: Configured in `~/.dsh-trading/profiles/trading-web/cordis.patch.yml` (and `package.json`) with multi-bot credentials, keeping secrets out of Git.

## Verification Evidence
- `pnpm build`: clean build across all workspace packages.
- `pnpm --filter @dshtrading/client-ui-bot-gui test`: 4 test suites, 15 tests passing.
- `node scripts/i18n-audit.mjs --check`: passed cleanly.
- `node scripts/test-audit.mjs`: passed cleanly.
- `node scripts/typecheck-gate.mjs`: passed cleanly.
- `node scripts/patch-id-gate.mjs`: passed cleanly.
- Live headless Chrome verification on `trading-web` profile (`http://127.0.0.1:18888`):
  - Verified presence of 「机器人」 tab in middle stage between 「行情」 and 「策略」.
  - Verified card rendering (desk-summary, position, etc.) with freshness metadata and action buttons.
  - Verified switching between configured bots (`alpha-arb` and `beta-trend`).
  - Verified `ACTION_CONFIRM` interception dialog prompt when triggering `pause` action.
