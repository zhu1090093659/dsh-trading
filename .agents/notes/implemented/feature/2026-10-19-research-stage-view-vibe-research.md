# Agent Note: Native Research workspace

Status: implemented

Date: 2026-10-20. This note owns the Research package boundary, left navigation,
content-pane replacement, migrated runtime and browser integration.

## Current decision

The owner requires feature migration into dsh-trading itself. The earlier
loopback-service/iframe integration is superseded. Research neither connects to
nor launches an external Vibe-Research UI or API server.

`packages/client-ui-research/runtime/` contains the upstream MIT engine, data
registry, Python collectors, calculations, backtests, methodology and provider
resources. `UPSTREAM.json` records the verified upstream HEAD
`94f61bf517393f80e88e974c224ac20b774ff990`; LICENSE is retained.
Only tracked public source and resources are migrated; user workspaces, private
data, tokens, browser state and node_modules are excluded.

The migrated API exports a request dispatcher instead of creating an HTTP
server. The DSH host serves `/dshtrading/api/research/engine/*` after its normal
`connection.requestRejection` browser fence. JSON-only mutations, argument
validation, evidence/number checks and local-library path validation remain in
the engine. No Bearer token is manufactured or forwarded. Enabled reminder
schedules run with the plugin lifecycle and are stopped on disposal.

`build-runtime.mjs` compiles runtime TypeScript and runner paths to JavaScript
under `lib/runtime/`, retaining its directory structure and non-code resources.
Node's ban on stripping TypeScript inside node_modules therefore also holds for
packaged research child runners. The host does not depend on the upstream checkout.

The research view mounts a same-origin ES module into a ShadowRoot. MemoryRouter
contains page navigation; CSS, theme, chart colors, portals and browser storage
are scoped to Research. The migrated pages cover home, daily review, news/signals,
20 industries, stock research, debate, backtests, candidate pools, stocks/holdings,
calendar, inbox, documents, notes and AI connections. AI connection prompts are
user-invoked so browsing does not require a model connection.

Research is a first-level entry in the far-left navigation. The market-strip
plugin (`E:/quantml/dsh-plugin-multi-chart`) spells it `Research` and navigates
immediately on click. Its section shortcuts reuse the stable research-section
event. Without that plugin, the trading shell renders its own primary navigation;
its folded rail also exposes Research.
Both navigation surfaces show the complete two-level research menu. Clicking a
group's full row toggles its children and opens the section overview; its chevron
is part of the same button. Child rows navigate directly to their research route.
The middle stage hides the
quote/strategy/knowledge tabs while Research fills that content pane. Returning
to market navigation restores them. Research is excluded from the subordinate
middle-stage tab list.

Data is under the trading home's `research/` directory, separate from the
terminal's original watchlist, holdings and knowledge stores. No user data is
imported or overwritten automatically. Python uses `config.python`, then
`DSH_RESEARCH_PYTHON`, then the research-owned `research/python` virtual
environment, then platform Python. `setup-python.mjs` installs collector
requirements in that virtual environment. AI provider choices still require an
explicit successful connection test before being saved. Existing CLI logins are
used by the original supported adapters; no login files are copied.

## Configuration and distribution

The existing GUI patch row is retained (insert-only ID). Configuration is
`dataDir`, `python`, and `reminders`; obsolete UI/API probe addresses are no longer
used. Locale registrations and the same stage navigation event remain compatible.
The GUI depends on the research package; it ships both the engine runtime and
built browser assets. No service startup or port configuration is required.

Isolated verification uses a separate trading home and a `trading-web` profile
on port 8897. On 2026-10-20, after the user requested activation, the live
`~/.dsh-trading/profiles/trading-web` packages were refreshed from local vendor
archives and the host restarted on port 8888. An authenticated browser opened
the left-side Research entry, mounted the native workbench, and received
`{ ok: true, mode: "native", sections: 8 }`. Model-dependent end-to-end report
generation is not asserted without a user configured model. Public sources
remain subject to their own availability.

See the package README for feature coverage and reproducible build/check commands.

## Verification (current working tree)

HEAD is `a4052699a882013d963e433379222484ce70bbd3` plus the local implementation.
Research build and host/client/workbench type checks pass. The research client
uses a structural locale-service boundary because the published SDK lacks its
exported client declaration file; dictionary keys remain checked by the local
union and paired zh/en records. The previous three research-client typecheck
baseline entries are reduced to zero.

Research tests: 21 passing. Trading shell regression tests: 310 passing.
`i18n:check` and `test:audit` pass. Browser verification on the isolated
trading-web host passes the eight sections, four research tools, actual pointer
clicks, refresh persistence, returning to market, absence of iframe/old-service
requests, native navigation without the market-strip plugin, and theme isolation.
The packaged engine executes JavaScript under node_modules, registers 168 data
endpoints and fetches real public data via tx_quote with exit code 0 and 18
evidence items. Its local Python environment is installed under the trading home.
The final 0.6.1 package contains 587 entries and excludes tests, local state,
Python bytecode caches and upstream agent instructions. Research-side DOM lookups
stay inside the Shadow DOM, and cross-window AI settings listen on the namespaced
storage key.

The global documentation-link checker is not verified: it stops on pre-existing
EACCES at `.agents/skills/cn-risk-checklist/SKILL.md`. That unrelated file is not
modified. The refreshed live 8888 host is running; isolated verification
processes and children are stopped. Full model-generated research is not
exercised without a user configured AI connection. Local evidence:
`E:/hermes/artifacts/research-native/`.
