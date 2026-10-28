/**
 * dsh-better-ptc — one host-side PTC deadline exemption service.
 *
 * The Node PTC runtime owns run_code's elapsed deadline and has no public
 * extension point. This row patches the mounted runtime's prototype run once
 * and exposes betterPtc.register(toolName): while a registered tool's binding
 * is in flight the wall clock pauses, then resumes with the remaining budget.
 * Every other binding keeps the shipped nested-tools-consume-the-budget
 * semantics.
 *
 * The service is a singleton row. Plugins insert the same stable row and call
 * the service through Cordis; they never import separate copies that could
 * double-wrap the runtime.
 */
import { Service } from '@deepseek-ai/cordis'

export const name = 'dsh-better-ptc'

/** The mounted Node PTC runtime this service wraps. */
export const inject = ['ptcRuntime']

/** Render the runtime's own timeout message so caller-visible text is unchanged. */
function deadlineMessage(timeoutMs) {
  return 'execution deadline reached (' + timeoutMs + 'ms)'
}

/** Copy one binding namespace, pausing the deadline around registered tools. */
function wrapNamespace(namespace, names, pause, resume) {
  const functions = {}
  for (const [toolName, fn] of Object.entries(namespace.functions ?? {})) {
    functions[toolName] = names.has(toolName)
      ? async (args) => {
          pause()
          try { return await fn(args) } finally { resume() }
        }
      : fn
  }
  return { ...namespace, functions }
}

/** Whether any visible binding carries a currently registered tool name. */
function hasExemptBinding(bindings, names) {
  if (!Array.isArray(bindings) || names.size === 0) return false
  for (const namespace of bindings) {
    for (const toolName of Object.keys(namespace?.functions ?? {})) {
      if (names.has(toolName)) return true
    }
  }
  return false
}

/**
 * Run one program under a host-owned deadline that pauses during registered
 * waits.
 * @param runtime - original call target.
 * @param spec - resolved runtime spec with a numeric timeout.
 * @param original - the runtime's unwrapped run method.
 * @param names - live registered tool names.
 * @returns the runtime result, with this wrapper's expiry reported as timeout.
 */
async function runWithPausedDeadline(runtime, spec, original, names) {
  const controller = new AbortController()
  let remaining = spec.timeoutMs
  let deadlineAt = Date.now() + remaining
  let paused = 0
  let expired = false
  let timer

  const fire = () => {
    if (expired) return
    expired = true
    controller.abort('execution deadline reached')
  }
  const arm = (ms) => {
    deadlineAt = Date.now() + ms
    timer = setTimeout(fire, ms)
  }
  const pause = () => {
    if (paused === 0) {
      remaining = Math.max(0, deadlineAt - Date.now())
      clearTimeout(timer)
      timer = undefined
    }
    paused += 1
  }
  const resume = () => {
    if (paused === 0) return
    paused -= 1
    if (paused > 0 || expired) return
    if (remaining <= 0) fire()
    else arm(remaining)
  }

  timer = setTimeout(fire, remaining)

  const bindings = spec.bindings.map(namespace => wrapNamespace(namespace, names, pause, resume))
  const signal = spec.signal === undefined
    ? controller.signal
    : AbortSignal.any([spec.signal, controller.signal])

  try {
    const result = await original.call(runtime, { ...spec, bindings, timeoutMs: null, signal })
    if (expired && spec.signal?.aborted !== true && result?.error?.kind === 'abort') {
      return { ...result, error: { kind: 'timeout', message: deadlineMessage(spec.timeoutMs) } }
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create one runtime exemption registry. The service uses it; tests use it
 * directly with a fake runtime.
 * @param runtime - mounted PTC runtime.
 * @returns an object with register and dispose.
 */
export function createRuntimeExemption(runtime) {
  const names = new Map()
  let original
  let wrapped
  let proto
  let installed = false

  let supported = false
  try { supported = runtime?.timeout !== undefined } catch { supported = false }

  const ensureInstalled = () => {
    if (!supported || installed) return
    proto = Object.getPrototypeOf(runtime)
    if (typeof proto?.run !== 'function') return
    original = proto.run
    wrapped = function betterPtcRun(spec) {
      if (spec?.timeoutMs === null || typeof spec?.timeoutMs !== 'number' || !hasExemptBinding(spec?.bindings, names)) {
        return original.call(this, spec)
      }
      return runWithPausedDeadline(this, spec, original, names)
    }
    proto.run = wrapped
    installed = true
  }

  const restore = () => {
    if (!installed) return
    if (proto.run === wrapped) proto.run = original
    installed = false
    original = undefined
    wrapped = undefined
  }

  const register = (toolName) => {
    if (typeof toolName !== 'string' || toolName.length === 0) {
      throw new TypeError('betterPtc.register requires a non-empty tool name')
    }
    if (!supported) return () => {}
    ensureInstalled()
    if (!installed) return () => {}
    names.set(toolName, (names.get(toolName) ?? 0) + 1)
    let active = true
    return () => {
      if (!active) return
      active = false
      const count = names.get(toolName)
      if (count === undefined) return
      if (count <= 1) names.delete(toolName)
      else names.set(toolName, count - 1)
      if (names.size === 0) restore()
    }
  }

  const dispose = () => {
    names.clear()
    restore()
  }

  return { register, dispose }
}

/** ctx.betterPtc: one exemption registry per profile. */
export class BetterPtc extends Service {
  constructor(ctx) {
    super(ctx, 'betterPtc')
    this.exemption = createRuntimeExemption(ctx.ptcRuntime)
    ctx.effect(() => () => { this.exemption.dispose() }, 'dsh-better-ptc: runtime exemption')
  }

  /**
   * Exempt one blocking tool from the PTC elapsed deadline.
   * @param toolName - exact binding/tool name.
   * @returns idempotent unregister disposer.
   */
  register(toolName) {
    return this.exemption.register(toolName)
  }
}

/** Register the singleton service row. */
export function apply(ctx) {
  ctx.plugin(BetterPtc)
}
