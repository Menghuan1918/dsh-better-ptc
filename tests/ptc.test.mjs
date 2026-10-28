/** Unit tests for the shared runtime exemption registry. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeExemption, inject, name } from '../src/index.js'

const delay = ms => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

class FakeRuntime {
  lastSpec

  get timeout() {
    return { defaultMs: 100, maxMs: 1000 }
  }

  async run(spec) {
    this.lastSpec = spec
    const functions = spec.bindings?.[0]?.functions ?? {}
    const target = spec.program === 'ask_ok' ? 'ask_user_question'
      : spec.program === 'hold_ok' ? 'hold'
        : 'wait_subagent'

    if (spec.program === 'wait_pair') {
      const value = await Promise.all([functions.wait_subagent({}), functions.ask_user_question({})])
      return { logs: [], value }
    }

    const fn = functions[target]
    if (typeof fn !== 'function') return { logs: [], value: 'missing' }
    const aborted = new Promise((resolve) => {
      const signal = spec.signal
      if (signal === undefined) return
      const fail = () => resolve({ logs: [], error: { kind: 'abort', message: String(signal.reason) } })
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })
    const value = await Promise.race([fn({}), aborted])
    if (value !== null && typeof value === 'object' && 'error' in value) return value
    if (spec.program === 'wait_then_hold') {
      const after = await Promise.race([aborted, delay(200).then(() => 'ok')])
      if (after !== 'ok') return after
    }
    return { logs: [], value }
  }
}

const runtimeClass = () => class extends FakeRuntime {}
const specFor = (program, functions, timeoutMs, signal) => ({
  program,
  bindings: [{ global: 'tools', functions }],
  timeoutMs,
  ...signal === undefined ? {} : { signal },
})

test('row contract: name and ptcRuntime injection', () => {
  assert.equal(name, 'dsh-better-ptc')
  assert.deepEqual(inject, ['ptcRuntime'])
})

test('two registered names share one wrapper and both waits are exempt', async () => {
  const Runtime = runtimeClass()
  const runtime = new Runtime()
  const proto = Object.getPrototypeOf(runtime)
  const original = proto.run
  const exemption = createRuntimeExemption(runtime)
  const unregisterWait = exemption.register('wait_subagent')
  const unregisterAsk = exemption.register('ask_user_question')
  assert.notEqual(proto.run, original)
  try {
    const wait = await runtime.run(specFor('wait_ok', {
      wait_subagent: async () => { await delay(150); return 'wait-done' },
    }, 40))
    assert.deepEqual(wait, { logs: [], value: 'wait-done' })
    const ask = await runtime.run(specFor('ask_ok', {
      ask_user_question: async () => { await delay(120); return 'ask-done' },
    }, 40))
    assert.deepEqual(ask, { logs: [], value: 'ask-done' })
  } finally {
    unregisterWait()
    unregisterAsk()
  }
  assert.equal(proto.run, original)
})

test('a normal binding still expires while an exempt name is registered', async () => {
  const Runtime = runtimeClass()
  const runtime = new Runtime()
  const exemption = createRuntimeExemption(runtime)
  const unregister = exemption.register('wait_subagent')
  try {
    const result = await runtime.run(specFor('hold_ok', {
      wait_subagent: async () => 'unused',
      hold: async () => { await delay(200); return 'held' },
    }, 40))
    assert.equal(result.error?.kind, 'timeout')
    assert.equal(result.error.message, 'execution deadline reached (40ms)')
  } finally {
    unregister()
  }
})

test('resumed budget still expires after an exempt wait', async () => {
  const Runtime = runtimeClass()
  const runtime = new Runtime()
  const exemption = createRuntimeExemption(runtime)
  const unregister = exemption.register('wait_subagent')
  try {
    const result = await runtime.run(specFor('wait_then_hold', {
      wait_subagent: async () => { await delay(80); return 'waited' },
    }, 40))
    assert.equal(result.error?.kind, 'timeout')
  } finally {
    unregister()
  }
})

test('outer abort stays abort', async () => {
  const Runtime = runtimeClass()
  const runtime = new Runtime()
  const exemption = createRuntimeExemption(runtime)
  const unregister = exemption.register('wait_subagent')
  const controller = new AbortController()
  const pending = runtime.run(specFor('wait_ok', {
    wait_subagent: async () => { await delay(200); return 'late' },
  }, 500, controller.signal))
  setTimeout(() => controller.abort('user stop'), 20)
  try {
    const result = await pending
    assert.equal(result.error?.kind, 'abort')
    assert.equal(result.error.message, 'user stop')
  } finally {
    unregister()
  }
})

test('no registered name and timeoutMs null pass through', async () => {
  const Runtime = runtimeClass()
  const runtime = new Runtime()
  const exemption = createRuntimeExemption(runtime)
  const hold = async () => 'held'
  const wait = async () => 'done'
  const normal = await runtime.run(specFor('hold_ok', { hold }, 40))
  assert.deepEqual(normal, { logs: [], value: 'held' })
  assert.equal(runtime.lastSpec.timeoutMs, 40)
  assert.equal(runtime.lastSpec.bindings[0].functions.hold, hold)
  const unregister = exemption.register('wait_subagent')
  try {
    const nullBudget = await runtime.run(specFor('wait_ok', { wait_subagent: wait }, null))
    assert.deepEqual(nullBudget, { logs: [], value: 'done' })
    assert.equal(runtime.lastSpec.timeoutMs, null)
    assert.equal(runtime.lastSpec.bindings[0].functions.wait_subagent, wait)
  } finally {
    unregister()
  }
})

test('single unregister keeps the other name; last unregister restores', async () => {
  const Runtime = runtimeClass()
  const runtime = new Runtime()
  const proto = Object.getPrototypeOf(runtime)
  const original = proto.run
  const exemption = createRuntimeExemption(runtime)
  const unregisterWait = exemption.register('wait_subagent')
  const unregisterAsk = exemption.register('ask_user_question')
  unregisterWait()
  assert.notEqual(proto.run, original)
  const result = await runtime.run(specFor('ask_ok', {
    ask_user_question: async () => { await delay(80); return 'still' },
  }, 40))
  assert.deepEqual(result, { logs: [], value: 'still' })
  unregisterAsk()
  assert.equal(proto.run, original)
})

test('unsupported runtime is a no-op', () => {
  const runtime = { async run() { return { logs: [], value: 'plain' } } }
  const original = runtime.run
  const exemption = createRuntimeExemption(runtime)
  const unregister = exemption.register('wait_subagent')
  assert.equal(runtime.run, original)
  unregister()
  exemption.dispose()
  assert.equal(runtime.run, original)
})

test('duplicate register/unregister is refcounted and idempotent', async () => {
  const Runtime = runtimeClass()
  const runtime = new Runtime()
  const proto = Object.getPrototypeOf(runtime)
  const original = proto.run
  const exemption = createRuntimeExemption(runtime)
  const first = exemption.register('wait_subagent')
  const second = exemption.register('wait_subagent')
  first()
  first()
  assert.notEqual(proto.run, original)
  const result = await runtime.run(specFor('wait_ok', {
    wait_subagent: async () => { await delay(80); return 'kept' },
  }, 40))
  assert.deepEqual(result, { logs: [], value: 'kept' })
  second()
  assert.equal(proto.run, original)
})

test('cordis patch contains exactly one stable row', async () => {
  const { readFileSync } = await import('node:fs')
  const yaml = (await import('js-yaml')).default
  const rows = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  const inserted = rows.flatMap(entry => entry.insert ?? []).map(row => [row.id, row.name])
  assert.deepEqual(inserted, [['dsh-better-ptc', 'dsh-better-ptc']])
})
