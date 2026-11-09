/**
 * Keep the first model request on a minimal-shaped input surface, then expose
 * the full preset catalog once the session is safely anchored.
 *
 * Phase 1 (no persisted `tool/call` yet):
 * - tool catalog: one platform shell plus `commonTools`, installed as a
 *   per-agent registry restriction (see "TOOL CROP" below)
 * - prompt sections: only the persona section (all other sections,
 *   including plan-mode's `plan:policy`, return after promotion)
 * - runtime contexts: emptied (no sandbox/approval snapshot)
 * - pre-step messages: only whitelisted source kinds pass (direct user
 *   messages and goal auto-rounds by default)
 *
 * Promotion opens the full tool catalog and restores runtime contexts and all
 * prompt sections. With `anchorGate` the promotion after the first tool call
 * also requires one minimal-like reasoning block (a first block containing
 * `we` and no `let me`) or the `maxBootstrapSteps` fallback.
 * `promoteAfterFirstResponse` promotes a tool-less first response once it has
 * responded, and also releases an anchor-gated session when its first turn
 * ends (`turn/end`). With `promotedPresentation: code` the promoted catalog
 * is presented as PTC Mode: the wire shows a single `run_code` tool
 * backed by the generated SDK, switched at the step boundary so the current
 * step's native calls are never interrupted. `deferredSources` and
 * `deferredGraceSteps` delay selected injected message kinds (workspace
 * instructions, skill catalog) for a few steps after promotion.
 *
 * COMPACTION (local addition, ported from the upstream compaction-epoch
 * semantics): a compaction rewrites the whole model-visible surface, so the
 * first post-compaction request is a "second first request". A
 * `compaction/end` event releases PTC Mode (the presentation disposer) and
 * resets the promotion state to the CONTROLLED phase — bootstrap pair plus
 * `compactionTools` (a core work set, default none) — until a NEW durable
 * promotion signal exists past that boundary. The reset lives both in the
 * live `session/event` path and inside the durable-log scan, so resume and
 * reload reconstruct the same phase.
 *
 * TOOL CROP (host 0.2.2): the phase-1 catalog is a per-agent registry
 * restriction (`agent.ctx.tools.restrict({ allow })`), never a filtered
 * `tools` array from the `system-prompt/assemble` waterfall. Two host
 * behaviours force that: `assemble()` appends `tools` to its own return value
 * after the waterfall (a returned `tools` is dropped), and the loop resolves
 * the step's tool admission (`tools.resolve`) BEFORE assembling the prompt.
 * A mask installed during assembly therefore only reaches the NEXT step, and a
 * mask installed after admission narrows a set the model has already been
 * shown — every call to a masked tool would fail as UNKNOWN_TOOL.
 * The mask is installed from `agent/status` when it turns `running`: the
 * driver emits that transition while committing the running phase and only
 * then enters `turn()` → `preStep()` → `tools.resolve()`, which makes it the
 * earliest hook that carries the live agent. It is re-synced at `step/end`
 * and `turn/end` — the other boundaries where no admitted tool set is still
 * in flight. Promotion disposes the mask. `compaction/end` resets the phase
 * but never masks in place (the compacting step was already admitted); the
 * next boundary installs the post-compaction core set instead. A session that
 * is already promoted in the durable log replays as promoted from the same
 * events the live path used, so a continued conversation is never narrowed.
 *
 * ROBUSTNESS: composition drift (a missing bootstrap shell or common tool)
 * degrades to the full catalog with a one-time warning instead of throwing,
 * so a broken composition can never lock a session out of every request.
 *
 * OPT-IN PHASE-1 INSTRUCTION (issue #274): `phase1FirstCallInstruction` is
 * an optional string appended to the phase-1 persona; unset (the default)
 * keeps the phase-1 persona the exact one-line Minimal anchor. Test builds
 * use it to ask the model to ground its first answer with one Minimal-native
 * tool call before responding, so first-turn capability questions are
 * answered from the promoted registry instead of the cropped two-tool view.
 *
 * Source: https://github.com/xiaobright/dsh-anchored-standard (MIT), extended
 * with the phase-1 quarantine and the stabilization controls above.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-tool-bootstrap'

/** Prompt assembly and the tool registry must exist before this filter runs. */
export const inject = ['systemPrompt', 'tools']

/**
 * Prompt section names that carry the preset persona. The `dsh-persona` row
 * registers the preset persona as `deployment:persona` (the PERSONA_SECTION
 * name of `@deepseek-ai/dsh-system-prompt`), shadowing the deployment
 * default for the preset scope; `persona` is the legacy name kept for older
 * harnesses that registered the persona section without the prefix.
 */
const PERSONA_SECTION_NAMES = new Set(['deployment:persona', 'persona'])

/**
 * Workspace line a promoted persona gains. Phase 1 keeps the exact one-line
 * persona (the Minimal anchor); after promotion the model must also know the
 * session's selected workspace, which the Standard persona carries through
 * the `{{cwd}}` prompt variable. The literal cwd is read from the session
 * header at assembly time instead, so the line stays correct after a
 * workspace switch and a session without a selected workspace keeps the bare
 * one-liner rather than failing prompt interpolation.
 */
const WORKSPACE_LINE_PREFIX = '\n\nYour working directory is '

/**
 * Message-source kinds the model may see during phase 1. Goal auto-rounds
 * (source kind `goal`, issue #578) must be here: a filtered-out goal round
 * never produces a response or tool call, so no promotion branch ever fires
 * and the goal resume/pause loop deadlocks.
 */
const DEFAULT_MESSAGE_SOURCES = ['user', 'goal']

function stringList(value, field, fallback) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be an array of non-empty strings`)
  }
  return [...new Set(value)]
}

function optionalString(value, field) {
  if (value === undefined) return ''
  if (typeof value !== 'string') {
    throw new TypeError(`${name}: ${field} must be a string`)
  }
  return value
}

function integerAtLeast(value, field, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name}: ${field} must be an integer >= ${minimum}`)
  }
  return value
}

export function countWord(text, regex) {
  return [...text.matchAll(regex)].length
}

/**
 * Anchor classifier for promotion gating. A reasoning block counts as
 * minimal-like when it contains `we` and no `let me`; a block with any
 * `let me` is standard-like; everything else is ambiguous. This is a
 * deliberate relaxation of the modeltest identity probe: the gate decides
 * trajectory surface, not model identity, and `we` presence without
 * first-person execution phrases is the stable surface marker.
 */
export function classifyReasoning(text) {
  const trimmed = String(text ?? '').trim()
  const we = countWord(trimmed, /\bwe\b/gi)
  const letMe = countWord(trimmed, /\blet me\b/gi)
  const metrics = { we, letMe }
  if (we > 0 && letMe === 0) return { label: 'minimal-like', score: 4, metrics }
  if (letMe > 0) return { label: 'standard-like', score: -4, metrics }
  return { label: 'ambiguous', score: 0, metrics }
}

/**
 * Whether the FIRST reasoning block of an assistant message classifies as
 * minimal-like. Later blocks do not override an earlier standard-like first
 * block.
 */
export function hasAnchoredReasoning(content) {
  if (!Array.isArray(content)) return false
  const first = content.find(block => block?.type === 'reasoning')
  return first !== undefined && classifyReasoning(first.text).label === 'minimal-like'
}

/**
 * Whether one pre-step message belongs to a whitelisted source kind. The
 * configured whitelist alone decides; injected kinds and source-less seed
 * messages never pass unless explicitly named. (Before issue #578 this also
 * hardcoded `kind === 'user'`, so no whitelist entry could ever admit a
 * goal auto-round and `/goal` sessions deadlocked in phase 1.)
 */
function isAllowedMessage(message, allowedSources) {
  const kind = message.source?.kind
  return kind !== undefined && allowedSources.has(kind)
}

/** Whether one pre-step message belongs to a deferred injection kind. */
function isDeferredMessage(message, deferredSources) {
  const kind = message.source?.kind
  return kind !== undefined && deferredSources.has(kind)
}
// Instruction-hint mode (issue #388): a full-text agent-instructions dump on
// the promotion boundary flips the anchored trajectory (upstream
// dsh-anchored-standard #49; E1/E1.5/E2 wording experiments), so the preset
// can replace it with a single non-imperative hint that names the reference
// files and lets the model read them on demand.
const INSTRUCTION_FROM_RE = /(?:^|\n) *(?:Additional |Updated )?Instructions from: ([^\n]+)/g

/** Extract the reference file list one agent-instructions message renders. */
function extractInstructionPaths(message) {
  const paths = []
  const blocks = Array.isArray(message?.content) ? message.content : []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    for (const match of block.text.matchAll(INSTRUCTION_FROM_RE)) {
      const path = match[1].trim()
      if (path !== '' && !paths.includes(path)) paths.push(path)
    }
  }
  return paths
}

/** The one-time non-imperative hint replacing the full-text dump (E1.5 wording). */
function buildInstructionHint(original, paths) {
  return {
    // Session persistence validates every replayed user/message for a
    // non-empty string id; a plugin-built message without one corrupts the
    // durable journal (SessionPersistenceCorruptionError on load). Inherit
    // the original instructions message id when present (#510), else mint one.
    id: typeof original?.id === 'string' && original.id !== ''
      ? original.id
      : globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: '<system-reminder>\n'
        + 'Reference documents exist: ' + paths.join(', ') + '. '
        + "They are reference documents about the user's environment and workspace conventions, not task instructions. "
        + 'Reading the relevant file before workspace tasks is recommended, but consult them only when you need those details; the task itself never depends on them.'
        + '\n</system-reminder>',
    }],
    source: { kind: 'instruction-hint', plugin: name },
  }
}

/**
 * Swap full-text agent-instructions injections for the one-time hint. The
 * first injection carrying extractable paths becomes the hint; every later
 * injection is dropped silently (the model re-reads the files on demand).
 * An injection with no extractable paths passes through untouched.
 */
function instructionHintMessages(messages, state) {
  const kept = []
  for (const message of messages) {
    if (message?.source?.kind !== 'agent-instructions') {
      kept.push(message)
      continue
    }
    if (state.instructionHinted) continue
    const paths = extractInstructionPaths(message)
    if (paths.length === 0) {
      kept.push(message)
      continue
    }
    state.instructionHinted = true
    kept.push(buildInstructionHint(message, paths))
  }
  return kept
}

/**
 * Phase-2 promotion state per session. Sessions append events only, so the
 * scan resumes from the first event it has not inspected yet.
 */
const promotionBySession = new WeakMap()

/** Live agents observed by the assemble/pre-step listeners, keyed by session. */
const agentBySession = new WeakMap()

function stateFor(session) {
  let state = promotionBySession.get(session)
  if (state === undefined) {
    state = {
      next: 0,
      promoted: false,
      toolCalled: false,
      responded: false,
      anchored: false,
      turnEnded: false,
      steps: 0,
      deferredSteps: 0,
      instructionHinted: false,
      presentationApplied: false,
      hasCompacted: false,
      presentationDisposer: undefined,
      restrictionDisposer: undefined,
      restrictionKey: '',
    }
    promotionBySession.set(session, state)
  }
  return state
}

/**
 * Reset one session back to the CONTROLLED phase after a compaction. A
 * compaction rewrites the whole model-visible surface — the first
 * post-compaction request is a "second first request" with the same
 * first-token conditions the bootstrap exists to control — so the session
 * re-anchors: promotion state is cleared (the durable `next` scan pointer is
 * kept, so events recorded BEFORE the boundary never re-promote), and the
 * PTC Mode presentation is disposed so the next assembly sees the native
 * catalog and the phase-1 filter can narrow it again.
 */
function resetToControlled(state, session) {
  if (typeof state.presentationDisposer === 'function') {
    try {
      state.presentationDisposer()
    } catch {
      // A failed presentation reset must never break the session; the
      // next promotion re-declares PTC Mode anyway.
    }
    state.presentationDisposer = undefined
    const agent = session !== undefined ? agentBySession.get(session) : undefined
    if (agent?.ctx && typeof agent.ctx.emit === 'function') {
      agent.ctx.emit('tools/presentation-changed', { mode: 'native', session: session?.id })
    }
  }
  state.promoted = false
  state.toolCalled = false
  state.responded = false
  state.anchored = false
  state.turnEnded = false
  state.steps = 0
  state.deferredSteps = 0
  state.instructionHinted = false
  state.presentationApplied = false
  state.hasCompacted = true
}

/**
 * Switch one agent's wire presentation to PTC Mode (PTC: a single `run_code`
 * tool backed by the generated SDK) after promotion. `agent.ctx.tools` is the
 * per-agent view of the host registry, so the switch affects this session only.
 */
function applyPresentation(agent, state, policy) {
  if (state.presentationApplied || policy.promotedPresentation !== 'code') return
  const tools = agent?.ctx?.tools
  // Latch only after the switch really happened: without a tools view there
  // is nothing to present, and latching early would skip PTC Mode forever.
  if (tools === undefined) return
  // The disposer restores the deployment-default (native) presentation; it is
  // kept on the state so a post-compaction reset can release PTC Mode and
  // let the phase-1 catalog filter see the native tool list again.
  state.presentationDisposer = tools.presentAs('code')
  state.presentationApplied = true
  // #1128: Broadcast presentation switch so external discipline / analysis
  // plugins decouple presentation mode from tool failure detection.
  if (typeof agent?.ctx?.emit === 'function') {
    agent.ctx.emit('tools/presentation-changed', { mode: 'code', session: agent.session?.id })
  }
}

/**
 * One agent's registry view, read the way both the composition check and the
 * phase-1 mask need it. `knownNames` is the PRE-restriction name set, so drift
 * keeps meaning "the composition no longer carries a bootstrap tool" instead
 * of "the mask already removed it"; `restrictableNames` is the subset a mask
 * can actually remove (global and preset-scope registrations — an agent-scope
 * registration stays visible and cannot be masked away). Host 0.2.2 stopped
 * folding tool schemas into the `system-prompt/assemble` waterfall, so the
 * registry view is the surviving source. Falls back to `definitions()` when no
 * `view()` is reachable, which is the already-masked list.
 */
function registryView(agent) {
  const tools = agent?.ctx?.tools
  if (tools === undefined) return undefined
  try {
    if (typeof tools.view === 'function') {
      const view = tools.view(agent)
      if (view?.knownNames instanceof Set && view.restrictableNames instanceof Set) {
        return { names: view.knownNames, restrictable: view.restrictableNames }
      }
    }
    if (typeof tools.definitions === 'function') {
      const definitions = tools.definitions(agent)
      if (Array.isArray(definitions)) {
        return {
          names: new Set(definitions
            .map(definition => definition?.name)
            .filter(toolName => typeof toolName === 'string')),
          restrictable: undefined,
        }
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * The phase-1 catalog: one shell plus the common work set, widened by the
 * post-compaction core set once this session has compacted.
 */
function phase1AllowList(state, policy) {
  return [...new Set([
    ...policy.shellTools,
    ...policy.commonTools,
    ...(state.hasCompacted ? policy.compactionTools : []),
  ])]
}

/**
 * Whether the registry still carries the phase-1 composition contract:
 * exactly one configured shell and every common tool.
 */
function compositionDrift(names, policy) {
  const available = new Set(names)
  const shells = policy.shellTools.filter(toolName => available.has(toolName))
  const missing = policy.commonTools.filter(toolName => !available.has(toolName))
  if (shells.length === 1 && missing.length === 0) return undefined
  return { shells, missing }
}

/** Report composition drift once; the catalog then stays complete. */
function warnDrift(warnOnce, drift) {
  warnOnce(
    `${name}: expected exactly one bootstrap shell and every common tool; `
    + `shells=${JSON.stringify(drift.shells)}, missing=${JSON.stringify(drift.missing)} — `
    + 'bootstrap disabled, full catalog exposed',
  )
}

/** Lift the phase-1 registry mask, if one is installed. */
function releaseRestriction(state) {
  const disposer = state.restrictionDisposer
  state.restrictionDisposer = undefined
  state.restrictionKey = ''
  if (typeof disposer !== 'function') return
  try {
    disposer()
  } catch {
    // A mask that cannot be lifted must not break the session: the owning
    // agent scope reclaims it on disposal either way.
  }
}

/**
 * Install the phase-1 catalog as this agent's registry mask. The mask is
 * validated against the pre-restriction view, so a configured name the
 * composition does not register is dropped instead of throwing inside
 * `restrict()` (that call rejects unknown global names).
 */
function applyRestriction(agent, state, policy, warnOnce) {
  const tools = agent?.ctx?.tools
  if (tools === undefined || typeof tools.restrict !== 'function') return
  const registry = registryView(agent)
  if (registry === undefined) return
  const drift = compositionDrift(registry.names, policy)
  if (drift !== undefined) {
    warnDrift(warnOnce, drift)
    return
  }
  const wanted = phase1AllowList(state, policy)
  const allow = registry.restrictable === undefined
    ? wanted
    : wanted.filter(toolName => registry.restrictable.has(toolName))
  if (allow.length === 0) return
  const key = allow.join('\n')
  if (state.restrictionDisposer !== undefined && state.restrictionKey === key) return
  releaseRestriction(state)
  try {
    state.restrictionDisposer = tools.restrict({ allow })
    state.restrictionKey = key
  } catch {
    state.restrictionDisposer = undefined
    state.restrictionKey = ''
  }
}

/**
 * Bring one agent's registry mask in line with its phase. Only boundaries with
 * no admitted tool set in flight may call this: the host resolves a step's
 * admission before assembling its prompt, so a mask installed after that point
 * turns a tool the model was just shown into an UNKNOWN_TOOL failure.
 */
function syncRestriction(agent, state, policy, warnOnce) {
  if (state.promoted) {
    releaseRestriction(state)
    return
  }
  applyRestriction(agent, state, policy, warnOnce)
}

/**
 * a) first tool call, no anchor gate — promote immediately;
 * b) first tool call, anchored or `maxBootstrapSteps` fallback — promote;
 * c) first tool call, still gated, but the first turn ended and
 *    `promoteAfterFirstResponse` is set — release on the new user turn (the
 *    `turn/end` boundary lifts the registry mask, so that turn's admission
 *    already sees the full catalog);
 * d) tool-less first response with `promoteAfterFirstResponse` — promote.
 */
function decidePromotion(state, config) {
  if (state.toolCalled && config.anchorGate !== true) return true
  if (state.toolCalled && config.anchorGate === true && (state.anchored || state.steps >= config.maxBootstrapSteps)) return true
  if (state.toolCalled && config.anchorGate === true && config.promoteAfterFirstResponse === true && state.turnEnded) return true
  if (!state.toolCalled && state.responded && config.promoteAfterFirstResponse === true) return true
  return false
}

/** Scan newly appended session events and update promotion state. */
function scanEvents(state, session) {
  const events = Array.isArray(session?.events)
    ? session.events
    : typeof session?.snapshotEvents === 'function'
      ? session.snapshotEvents()
      : []
  for (; state.next < events.length; state.next += 1) {
    const event = events[state.next]
    if (event === undefined) continue
    if (event.type === 'compaction/end') {
      // A compaction rewrites the model-visible surface: the session falls
      // back to the controlled phase until a NEW promotion signal exists
      // past this boundary (the `next` pointer stays, so events before the
      // boundary never re-promote). Handled inside the scan so cold starts
      // reconstruct the same phase from the durable log.
      resetToControlled(state, session)
    } else if (event.type === 'tool/call') {
      state.toolCalled = true
    } else if (event.type === 'step/start') {
      state.steps += 1
    } else if (event.type === 'turn/end') {
      state.turnEnded = true
    } else if (event.type === 'assistant/message') {
      state.responded = true
      if (!state.anchored) state.anchored = hasAnchoredReasoning(event.data?.message?.content)
    }
  }
}

/** Update one agent's promotion state and apply its post-promotion presentation. */
function refresh(agent, policy) {
  const session = agent?.session
  if (session === undefined) return undefined
  const state = stateFor(session)
  agentBySession.set(session, agent)
  if (!state.promoted) {
    scanEvents(state, session)
    if (decidePromotion(state, policy)) state.promoted = true
  }
  if (state.promoted) applyPresentation(agent, state, policy)
  return state
}

const PTC_INSTRUCTION = '\n\nNote: You are in Programmatic Tool Calling (PTC) mode. All actions (running shell commands, file operations, web tools) MUST be performed via the `run_code` tool by writing and executing TypeScript/JavaScript programs. Do not attempt to invoke tools like `bash` or `str_replace_editor` directly on the wire.'

/**
 * Append the session's working directory to the persona section of a promoted
 * assembly. Returns the assembly unchanged when there is no persona section,
 * no selected workspace, or the exact line is already present.
 */
function withWorkspaceLine(assembly, agent) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return assembly
  if (!Array.isArray(assembly.sections)) return assembly
  const line = `${WORKSPACE_LINE_PREFIX}${cwd}.`
  const persona = assembly.sections.find(section =>
    PERSONA_SECTION_NAMES.has(section?.name)
    && typeof section?.text === 'string'
    && !section.text.includes(line))
  if (persona === undefined) return assembly
  return {
    ...assembly,
    sections: assembly.sections.map(section => section === persona
      ? { ...section, text: `${persona.text}${line}` }
      : section),
  }
}

/**
 * Append PTC mode instructions to the persona section when promoted to code presentation.
 */
function withPtcInstruction(assembly, policy) {
  if (policy?.promotedPresentation !== 'code') return assembly
  if (!Array.isArray(assembly.sections)) return assembly
  const persona = assembly.sections.find(section =>
    PERSONA_SECTION_NAMES.has(section?.name)
    && typeof section?.text === 'string'
    && !section.text.includes('PTC) mode'))
  if (persona === undefined) return assembly
  return {
    ...assembly,
    sections: assembly.sections.map(section => section === persona
      ? { ...section, text: `${persona.text}${PTC_INSTRUCTION}` }
      : section),
  }
}

/** Register the per-session bootstrap quarantine and promotion policy. */
export function apply(ctx, config) {
  const commonTools = stringList(config.commonTools, 'commonTools')
  const shellTools = stringList(config.shellTools, 'shellTools')
  const messageSources = new Set(stringList(config.messageSources, 'messageSources', DEFAULT_MESSAGE_SOURCES))
  const deferredSources = new Set(stringListOrEmpty(config.deferredSources, 'deferredSources'))
  const presentation = config.promotedPresentation ?? 'native'
  if (presentation !== 'native' && presentation !== 'code') {
    throw new TypeError(`${name}: promotedPresentation must be "native" or "code"`)
  }

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }
  const bootstrapMaxTokens = config.bootstrapMaxTokens === undefined
    ? undefined
    : integerAtLeast(config.bootstrapMaxTokens, 'bootstrapMaxTokens', 1)
  // Core work set exposed during the post-compaction controlled phase, so a
  // mid-task model keeps working with a small catalog instead of the full
  // Standard set. Defaults to none: the session stays on the bootstrap pair
  // until a new promotion signal (the composition may widen it via config).
  const compactionTools = stringListOrEmpty(config.compactionTools, 'compactionTools')
  // Opt-in extra line for the phase-1 persona (test builds, issue #274):
  // asks the model to ground its first answer with a Minimal-native tool
  // call before responding. Unset keeps the exact one-line persona.
  const phase1FirstCallInstruction = optionalString(config.phase1FirstCallInstruction, 'phase1FirstCallInstruction')
  const policy = {
    anchorGate: config.anchorGate === true,
    promoteAfterFirstResponse: config.promoteAfterFirstResponse === true,
    maxBootstrapSteps: integerAtLeast(config.maxBootstrapSteps ?? 4, 'maxBootstrapSteps', 1),
    deferredGraceSteps: integerAtLeast(config.deferredGraceSteps ?? 0, 'deferredGraceSteps', 0),
    promotedPresentation: presentation,
    // Opt-in (issue #388): replace the post-promotion full-text
    // agent-instructions dump with a one-time non-imperative hint naming the
    // reference files, so the injection never flips the anchored trajectory.
    instructionHint: config.instructionHint === true,
    bootstrapMaxTokens,
    compactionTools,
    phase1FirstCallInstruction,
    shellTools,
    commonTools,
  }

  // The phase-1 catalog is a registry mask, so it has to exist before the loop
  // resolves a step's admission. `agent/status` is the earliest hook that
  // carries the live agent: the driver commits the running phase and emits it
  // synchronously, and only then enters `turn()` -> `preStep()` ->
  // `tools.resolve()`. `refresh` replays the durable events the live path
  // already saw, so a session that is already promoted (a continued
  // conversation) reads as promoted here and is never narrowed.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'running' || agent === undefined) return
    const state = refresh(agent, policy)
    if (state === undefined) return
    syncRestriction(agent, state, policy, warnOnce)
  })

  // Promotion is applied at step/turn boundaries, never while a step is still
  // executing tools: switching the presentation mid-step would collapse the
  // native calls that step already planned. By `step/end` the tool-call and
  // reasoning events are durable, so the NEXT prompt assembly already sees
  // PTC Mode with its generated SDK section. A `compaction/end` event
  // releases PTC Mode and resets the promotion state (see
  // resetToControlled); the reset also runs inside scanEvents, so a cold
  // start reconstructs the same controlled phase from the durable log.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'compaction/end') {
      // The compacting step was admitted before this event, so masking in
      // place here would turn the tools the model was just shown into
      // UNKNOWN_TOOL failures. `step/end`, `turn/end` or the next
      // `agent/status` installs the post-compaction core set instead —
      // always before the next admission.
      resetToControlled(stateFor(session), session)
      return
    }
    if (event.type !== 'step/end' && event.type !== 'turn/end') return
    const state = stateFor(session)
    if (!state.promoted) {
      scanEvents(state, session)
      if (decidePromotion(state, policy)) state.promoted = true
    }
    const agent = agentBySession.get(session)
    if (agent !== undefined && state.promoted) applyPresentation(agent, state, policy)
    if (agent !== undefined) syncRestriction(agent, state, policy, warnOnce)
    else if (state.promoted) releaseRestriction(state)
  })

  // `prepend: true` puts both filters at the outermost position of their
  // waterfall, so `await next()` always observes the complete downstream
  // result (including messages appended by listener order, not row order)
  // before the quarantine strips it.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is
    // guarded (a filter bug must never brick every request of a session).
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const state = refresh(agent, policy)
    if (state.promoted) return withPtcInstruction(withWorkspaceLine(assembled, agent), policy)

    // The waterfall no longer carries the tool list (host 0.2.2): read the
    // registry view instead, and leave the catalog untouched when it is out of
    // reach rather than throwing on a surface this filter cannot inspect. The
    // view is read PRE-restriction, so drift still means "the composition lost
    // a bootstrap tool" rather than "the mask already removed it".
    const registry = registryView(agent)
    if (registry === undefined) return assembled
    const drift = compositionDrift(registry.names, policy)
    if (drift !== undefined) {
      // Composition drift must not lock a session out: degrade to the full
      // catalog with a one-time warning instead of throwing (the bootstrap
      // phase surfaces will simply not apply). A mask installed by an earlier
      // step must not outlive its premise either.
      warnDrift(warnOnce, drift)
      releaseRestriction(state)
      return assembled
    }

    const sections = Array.isArray(assembled.sections)
      ? assembled.sections.filter(section => PERSONA_SECTION_NAMES.has(section?.name))
      : undefined
    // Opt-in phase-1 instruction: appended once to the persona section so
    // test builds can shift the first answer behind a Minimal-native tool
    // call (issue #274). Unset leaves the exact one-line persona.
    const phase1Sections = sections === undefined || phase1FirstCallInstruction === ''
      ? sections
      : sections.map(section => {
          if (typeof section?.text !== 'string' || section.text.includes(phase1FirstCallInstruction)) return section
          return { ...section, text: `${section.text}${phase1FirstCallInstruction}` }
        })
    return {
      ...assembled,
      contexts: [],
      ...(phase1Sections !== undefined ? { sections: phase1Sections } : {}),
    }
  }, { prepend: true })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const agent = payload.agent
    if (agent === undefined || decision.kind !== 'enter') return decision
    const state = refresh(agent, policy)
    if (state === undefined) return decision

    if (!state.promoted) {
      return {
        ...decision,
        messages: decision.messages.filter(message => isAllowedMessage(message, messageSources)),
      }
    }
    let result = decision
    if (state.deferredSteps < policy.deferredGraceSteps) {
      state.deferredSteps += 1
      result = {
        ...result,
        messages: result.messages.filter(message => !isDeferredMessage(message, deferredSources)),
      }
    }
    if (policy.instructionHint) {
      result = { ...result, messages: instructionHintMessages(result.messages, state) }
    }
    return result
  }, { prepend: true })

  // Phase 1 caps the next request output budget to bootstrapMaxTokens, the
  // community-observed We-need trigger window (dsh-anchored-standard issue 6),
  // and strips the cap again after promotion. The strip is mandatory:
  // requestProposal(persistedHeader) carries a plain maxTokens from the
  // previous header into the next request unless the adapter marked it a
  // default, so an un-stripped cap would be soldered into every request.
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const agent = payload?.agent
    if (agent === undefined || policy.bootstrapMaxTokens === undefined) return resolved
    const state = refresh(agent, policy)
    if (state.promoted) {
      if (resolved.maxTokens !== policy.bootstrapMaxTokens) return resolved
      const rest = { ...resolved }
      delete rest.maxTokens
      return rest
    }
    return { ...resolved, maxTokens: policy.bootstrapMaxTokens }
  }, { prepend: true })
}
