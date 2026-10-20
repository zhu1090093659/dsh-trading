# Native Research for dsh-trading

Research lives in the far-left primary navigation. Opening it replaces the
quote/strategy/knowledge content pane with the research workspace. Market
navigation restores the original terminal views. The shell includes a fallback
entry when the optional multi-chart market strip is absent.

The package owns its React workspace, same-origin HTTP dispatcher, Python data
collectors and research runtime. It does not use an iframe, proxy an upstream
service, launch Vibe-Research, or require its checkout. Upstream source attribution
and the MIT license are retained under `runtime/`.

| Area | Migrated capabilities |
| --- | --- |
| Home / review | Indices, watchlist and holdings overview; market state, sentiment, trend, volume and fund flows |
| Industry | News radar and signals; 20 sectors with research workflows |
| Research tools | Six-stage company research for CN/HK/US, evidence and calculation checks, bull/bear debate, backtests and candidate pools |
| My stocks | Research watchlist, trade ledger, positions and performance, portfolio checks, scenario replay, calendar and reminder inbox |
| Library | PDF/Word/text import, extraction, retrieval, source citations, previews, downloads and research notes |
| AI | Existing supported CLI subscriptions or user configured compatible model APIs, tested before saving |
| Data engine | 168 registered endpoints, deterministic calculations, source metadata and data-gap handling |

The upstream revision is pinned in `runtime/UPSTREAM.json`. Private upstream data,
API tokens, login files, caches and dependencies are not copied.

## Build and verify

From the monorepo root:

```powershell
pnpm install
pnpm --filter @dshtrading/client-ui-research build
pnpm --filter @dshtrading/client-ui-trading build
pnpm --filter @dshtrading/dsh-i18n build
pnpm --filter @dshtrading/client-ui-research setup:python
pnpm --filter @dshtrading/client-ui-research test
pnpm --filter @dshtrading/client-ui-research exec tsc --noEmit -p workbench/tsconfig.json
pnpm --filter @dshtrading/client-ui-trading test
pnpm i18n:check
pnpm test:audit
```

Python 3.11+ is required for data collection/calculation. `setup:python` creates
`~/.dsh-trading/research/python` and installs the collector requirements there.
Host config accepts `dataDir`, `python`, and `reminders` (enabled by default, but
only schedules explicitly enabled by the user run). An explicit
`DSH_RESEARCH_PYTHON` can select another installed interpreter.

All research data defaults to `<DSH_HOME>/research`. Browser state uses the
`dshtrading.research.workbench.*` namespace. Original trading watchlists, holdings
and knowledge are not automatically imported or replaced.

The host protects `/dshtrading/api/research/*` with its existing browser auth.
`/status` reports native readiness, `/assets/*` serves the compiled browser app,
and `/engine/*` executes the migrated request dispatcher in process. Runtime
TypeScript is compiled to JavaScript for installation under node_modules and for
background research runners. No upstream API token is used.

Install/refresh profile packages only while that trading instance is stopped,
then start the normal `trading-web` profile. The optional market strip source is
`E:/quantml/dsh-plugin-multi-chart`; its Research navigation change must accompany
an installation using that plugin. Do not restart the user's active instance as
part of automated verification.

Model-dependent generation requires the user's explicitly configured connection;
browsing and deterministic capabilities do not. External data-source outages are
shown as errors or missing data, never replaced by fabricated results.
