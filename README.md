# dsh-trading

> **Your next trading terminal can also be DSH**  
> *你的下一个交易终端，也可以是 DSH*

[![DSH Baseline](https://img.shields.io/badge/DSH%20Baseline-0.1.2--alpha.1-blue.svg)](https://github.com/deepseek-ai)
[![Markets](https://img.shields.io/badge/Markets-Crypto%20%7C%20US%20%7C%20CN%20%7C%20HK-green.svg)](#-multi-market-coverage--19-active-connectors)
[![Connectors](https://img.shields.io/badge/Connectors-19%20Active-orange.svg)](docs/connectors-guide.md)
[![Architecture](https://img.shields.io/badge/Architecture-Cordis%20Microkernel-purple.svg)](#-architecture--layering-mechanism)
[![License](https://img.shields.io/badge/License-PolyForm%20NC%201.0.0-lightgrey.svg)](LICENSE)

`dsh-trading` is a modular, full-market AI trading terminal and plugin ecosystem built on **DeepSeek Harness (DSH)**.

It combines the **three-column GUI experience of professional trading software** with deep reasoning AI agents, multi-market automated execution, comprehensive technical indicators, and strict, verifiable risk-control gates — seamlessly uniting conversational investment research with live terminal workflows.

---

## 🌟 Core Architecture & Highlights

```
+---------------------------------------------------------------------------------------------------+
|                                     DSH Trading Ecosystem Overview                                |
+---------------------------------------------------------------------------------------------------+
|  [3-Column GUI]      Left: Multi-Market Dock  |  Center: Lightweight Charts v5 + TA  |  Right: Agent Rail |
|  [Full Markets]      Crypto (4 exchanges)   |  US Equities (6 sources/brokers)     |  CN / HK Markets   |
|  [Agent-Native]      Session Preset Isolation |  Conversational Market Analysis      |  Risk Checklists   |
|  [Dual Safety Gates] Default Dry-Run Mode   |  Explicit liveTrading Toggle         |  BYOK Key Custody  |
|  [Cordis Microkernel] Insert-Only Bundles   |  Open Setting Hot-Routing            |  Zero Host Hacks   |
+---------------------------------------------------------------------------------------------------+
```

### 1. Professional Three-Column Trading GUI
- **Center Stage Charting Engine**: Built with high-performance **Lightweight Charts v5**, supporting multi-timeframe switching (intraday minutes to daily/weekly); equipped with MA, EMA, BOLL, MACD, RSI, KDJ, and SuperTrend technical indicators, visual parameter customization, and third-party indicator hot-plugging.
- **Left Market & Watchlist Dock**: Rapid switching across markets (Watchlist / Crypto / US / CN / HK), mini Sparkline price trends, real-time bid/ask quotes, and localized persistent storage.
- **Right Session Rail & Hero Fusion**: Native AI agent conversation panel docked on the right rail; historical sessions seamlessly merged with the Hero Composer launcher, supporting collapsible distraction-free workflows.

### 2. Multi-Market Coverage & 19+ Active Connectors
- **Crypto**: Binance, OKX (Paper / Live), Bybit, CCXT (100+ exchanges aggregation).
- **US Equities (US)**: Yahoo Finance (public), Alpaca (Paper / Live), FMP, Finnhub, Polygon.io, Interactive Brokers (IBKR Client Portal Gateway).
- **China A-Shares (CN)**: Tencent Finance (public), Eastmoney (public), Tushare Pro, AkShare, MiniQMT (broker gateway).
- **Hong Kong Stocks (HK)**: Tencent HK (public), Longbridge OpenAPI, Futu OpenD Gateway, Tiger Trade OpenAPI.
- See the comprehensive onboarding guide in [Connectors Guide (docs/connectors-guide.md)](docs/connectors-guide.md).

### 3. Agent-Native Intelligence & Domain Knowledge (Skills)
- **Session-Level Preset Isolation**: Dedicated presets per market (`crypto-trader`, `us-trader`, `cn-trader`, `hk-trader`), isolating tools and memory per session within the same process.
- **Bundled Domain Knowledge**: Pre-packaged risk checklists, qualitative analysis frameworks, and research skills ([cn-risk-checklist](.agents/skills/cn-risk-checklist/SKILL.md), [hk-risk-checklist](.agents/skills/hk-risk-checklist/SKILL.md), [us-risk-checklist](.agents/skills/us-risk-checklist/SKILL.md), [crypto-risk-checklist](.agents/skills/crypto-risk-checklist/SKILL.md), [crypto-instrument-analysis](.agents/skills/crypto-instrument-analysis/SKILL.md), [company-analysis](.agents/skills/company-analysis/SKILL.md), [content-insight](.agents/skills/content-insight/SKILL.md), [trading-notes-setup](.agents/skills/trading-notes-setup/SKILL.md)).
- **Trading Journal**: Each market preset's persona instructs the agent to check the workspace for a `.trading-journal/` directory at session start — if missing, remind the user and scaffold it via the [trading-notes-setup](.agents/skills/trading-notes-setup/SKILL.md) skill; the journal dual-tracks what the agent did (`agent/`) and what the human did (`human/`), append-only per month.

### 4. Strict Safety Gates & Privacy (BYOK)
- **Dual-Track Order Approval**: Order placement and cancellation tools operate in Dry-run simulation by default. Live order routing requires an explicit `liveTrading: true` configuration and triggers DSH interactive approval prompts (fails closed in headless environments).
- **Bring Your Own Key (BYOK)**: All API credentials remain on your local machine or in environment variables. No secrets are bundled, relayed, or uploaded.

---

## 🏛️ Architecture & Layering Mechanism

`dsh-trading` leverages the Cordis microkernel extension architecture provided by DSH:

| Layer | Mechanism | Project Implementation |
|---|---|---|
| **Functional Unit** | Cordis Plugin (npm package) | Connectors, toolkits, UI views, indicator extensions, automation |
| **Distribution Unit** | **Bundle Package** (`dsh.bundle.patch` + `cordis.patch.yml`) | One bundle per market; `@dsh-trading/base` hosts market-agnostic core abstractions |
| **Deployment Unit** | Profile (`$DSH_HOME/profiles/<name>`) | User runtime environment; isolated profiles available for live execution |
| **Session Behavior** | Agent Preset | One preset per market, allowing multi-market sessions to co-exist in one process |
| **Knowledge Unit** | Skill (`SKILL.md` via package provider) | Trading rules and methodologies distributed alongside market packages |

```
@dsh-trading/base          ← Core abstractions: account/order/quote interfaces, approval gate, 3-column GUI, preset root
├── @dsh-trading/crypto    ← Crypto bundle: Binance / OKX / Bybit / CCXT + Skills + Presets
├── @dsh-trading/us        ← US bundle: Yahoo / Alpaca / FMP / Finnhub / Polygon / IBKR + Skills + Presets
├── @dsh-trading/cn        ← CN bundle: Tencent / Eastmoney / Tushare / AkShare / MiniQMT + Skills + Presets
└── @dsh-trading/hk        ← HK bundle: Tencent / Longbridge / Futu OpenD / Tiger + Skills + Presets
@dsh-trading/all           ← Meta bundle declaration
```

---

## 🛡️ Six Invariant Design Rules

1. **Insert-only Patch**: Market bundles may only insert new plugin rows under their own unique namespaces. Replacing rows belonging to base or other markets is strictly forbidden.
2. **Decoupled Knowledge & Code**: Market regulations, analytical frameworks, and risk checklists must live in skills, not hardcoded into plugin logic.
3. **Dual-Track Trading Safety Gate**: Order placement and cancellation default to dry-run simulations. Live trading requires explicit configuration (`liveTrading: true`) and interactive approval (fail-closed in headless mode).
4. **Base Anti-Corruption**: Capabilities are only hoisted to `@dsh-trading/base` when required by $\ge 2$ markets, preventing premature abstraction.
5. **Data Compliance & Zero Re-distribution**: Users bring their own API keys. No market data is cached for external re-distribution; local private caching for backtesting is permitted.
6. **Replaceable GUI Shell, Inviolable Data Layer**: The `client-ui-*` frontend presentation layer may be refactored or rewritten as host UI evolves, but core data layer contracts (`/dshtrading/api` bridge, `dshtrading` settings namespace, `tradingMarketRouter` / `tradingMarketDataRegistry`, `@dsh-trading/api` types) must remain backward-compatible and intact.

---

## 📊 Package Inventory & Responsibilities

| Package | Type | Responsibility |
|---|---|---|
| `packages/api` | Type Contract | Market data and trading service interfaces, standard Ticker/Kline, error vocabulary (zero runtime deps) |
| `packages/base` | Core Bundle | Sole owner of shared rows: unified approval gate plugin + agent-presets root row + GUI shell mount |
| `packages/router` | Router Plugin | Registers `dshtrading` settings namespace, provides `tradingMarketRouter` & `tradingMarketDataRegistry` (hot-switching) |
| `packages/indicators` | TA Core | Pure math computation kernel for technical indicators (MA/EMA/BOLL/MACD/RSI/KDJ/SuperTrend) and definitions |
| `packages/client-ui-indicators` | UI Plugin | Client-side indicator provider registering built-in indicators into `tradingIndicators` service |
| `packages/client-ui-settings` | UI Plugin | Injects the "Settings → Trading" top-level section and per-market provider routing panels |
| `packages/client-ui-trading` | GUI Terminal Shell | Professional three-column trading GUI: Left watchlist dock, center Lightweight Charts stage, right session rail & HTTP bridge |
| `packages/connector-*` (16 pkgs) | Connector Plugins | REST / WebSocket / Gateway implementations for all global exchanges and data providers |
| `packages/kit-*` (4 pkgs) | Market Toolkits | Market-specific tools (funding rates, news) and risk checklist skill providers |
| `packages/crypto / us / cn / hk` | Market Bundles | Market dependency aggregation packages and automated preset installers |

---

## ⚖️ Data Sources & Terms of Service (ToS)

| Market | Default Source | Authorization & ToS Boundary |
|---|---|---|
| **US Equities** | Yahoo Finance / Alpaca | Yahoo is a public endpoint (individual usage boundary; see connector-yahoo README); Alpaca provides official Paper/Live APIs |
| **China A-Shares** | Tencent Finance / Eastmoney | Public endpoints; live execution connects locally to broker MiniQMT gateway |
| **Hong Kong Stocks** | Tencent HK / Longbridge | Tencent is a public endpoint; Longbridge, Futu, and Tiger provide licensed broker OpenAPI / Gateway connections |
| **Crypto** | Binance / OKX | Official Binance and OKX APIs; OKX supports simulated paper trading accounts with BYOK keys |
| **Crypto fundamentals drill-down** | CoinCap | Public REST endpoint (`api.coincap.io`), individual usage boundary only — no redistribution, no bulk scraping (issue #36, 2026-09-02) |

---

## 🚀 Quick Start & Usage

### 1. Install to a DSH Profile

```sh
# Install base core along with selected markets (e.g. Crypto and US Equities)
dsh plugin --profile trading-web add @dsh-trading/base @dsh-trading/crypto @dsh-trading/us

# Or install all markets at once
dsh plugin --profile trading-web add @dsh-trading/base @dsh-trading/crypto @dsh-trading/us @dsh-trading/cn @dsh-trading/hk
```

### 2. Launch the Trading Terminal

```sh
# Launch dedicated Web trading terminal profile
dsh --profile trading-web

# Or launch in headless development mode
dsh --profile trading-dev
```

After starting:
1. Open the DSH Web interface in your browser to access the three-column trading terminal (Left: Watchlist, Center: Interactive Charts, Right: AI Agent).
2. When creating a new conversation, pick `crypto-trader`, `us-trader`, `cn-trader`, or `hk-trader` from the Presets list.
3. Click "Settings → Trading" in the sidebar or session rail to switch market data/exchange providers on the fly (instant hot-reload).

### 3. Hot Refresh During Development

```sh
# Rebuild packages
pnpm -r build

# Clear profile node_modules cache and restart
rm -rf ~/.dsh/profiles/trading-web/node_modules/@dsh-trading/*
pnpm install --prefix ~/.dsh/profiles/trading-web
dsh --profile trading-web
```

---

## 📚 Documentation Index & Roadmap

- 📖 **Connectors Onboarding & Configuration Guide**: [docs/connectors-guide.md](docs/connectors-guide.md)
- 📖 **New Connector Standard Playbook**: [docs/connector-playbook.md](docs/connector-playbook.md)
- 📖 **Skills Architecture & Integration Guide**: [docs/skills-guide.md](docs/skills-guide.md)
- 📖 **Market Canonical Symbol Vocabulary**: [docs/symbol-vocabulary.md](docs/symbol-vocabulary.md)
- 📖 **Exchange Routing & Dataplane Architecture**: [docs/exchange-routing.md](docs/exchange-routing.md)
- 🗺️ **Qualitative Analysis & Quant Roadmap**: [docs/analysis-roadmap.md](docs/analysis-roadmap.md)
- 📜 **Architecture Decision Log & Spike Reviews**: [spikes/REVIEW-LOG.md](spikes/REVIEW-LOG.md)

---

## 📄 License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).

- **Noncommercial use** — personal study, research, hobby projects, and use by noncommercial organizations (as defined in the license) — is free.
- **Commercial use requires prior written authorization** from the project owner. To obtain a commercial license, please open a GitHub issue or contact <chunlinzhu666@gmail.com>.

> 本项目采用 [PolyForm Noncommercial 1.0.0](LICENSE) 许可：个人学习、研究、兴趣项目等非商业用途免费使用；**任何商业用途须事先取得项目所有者的书面授权**，请通过 [chunlinzhu666@gmail.com](mailto:chunlinzhu666@gmail.com) 或 GitHub Issue 洽谈商用许可。

