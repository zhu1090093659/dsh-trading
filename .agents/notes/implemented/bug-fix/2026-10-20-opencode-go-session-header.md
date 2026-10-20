# OpenCode Go session routing in the trading profile

The installed host's pi-ai adapter supplies the DSH session id to pi-ai but its
OpenAI-compatible transport omits the required `x-opencode-session` header.
OpenCode Go rejects this request with HTTP 400 `MissingSessionID`; the chat UI
can show the less useful `400 status code (no body)` / `INVALID_REQUEST`.

`@dshtrading/base/opencode-session` is an optional host plugin enabled in the
local trading-web profile. Its `llm/stream` listener scopes each lazy iterator
operation to the actual conversation id with AsyncLocalStorage. A disposable
fetch wrapper adds that id only to OpenCode Go HTTPS requests to opencode.ai.
Existing session headers, credentials, the real DSH user agent, other providers
and model/reasoning selections are preserved. Concurrent conversations keep
separate ids. Host installation files remain unchanged.

The provider requirement is documented at
https://opencode.ai/v2/docs/console/go/#where-can-i-use-it.
The same page identifies incomplete session support in DeepSeek Harness.

Verification on 2026-10-20: the live trading-web chat sent a tool-free connectivity prompt using `DeepSeek V4.1 Flash` at `Max`. The persisted DSH session contains the assistant reply `ok`, confirming the full chat path succeeds after enabling the shim. A first DOM-only check incorrectly timed out because it matched uppercase `OK` while the model answered lowercase `ok`; the session record confirms success.
