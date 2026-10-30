/** Real installed Node PTC worker coverage. Run with DSH_PACKAGE_ROOT set. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntimeExemption } from '../src/index.js'

const hostRoot = process.env.DSH_PACKAGE_ROOT

test('installed Node runtime deadline exemptions', { timeout: 30000, skip: !hostRoot && 'Set DSH_PACKAGE_ROOT to the installed @deepseek-ai/dsh package' }, async (t) => {
  const requireHost = createRequire(join(hostRoot, 'package.json'))
  const load = name => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)))
  const { Context } = await load('cordis')
  const { default: LocalFileSystem } = await load('dsh-fs-local')
  const { default: LocalSubprocessRuntime } = await load('dsh-subprocess-local')
  const { NodePtcRuntime } = await load('dsh-ptc-runtime-node')

  const fixture = (t) => {
    const ctx = new Context()
    new LocalFileSystem(ctx, LocalFileSystem.Config({ cwd: process.cwd() }))
    new LocalSubprocessRuntime(ctx)
    const runtime = new NodePtcRuntime(ctx, NodePtcRuntime.Config({}))
    const exemption = createRuntimeExemption(runtime)
    exemption.register('wait_subagent')
    exemption.register('ask_user_question')
    t.after(async () => {
      exemption.dispose()
      await ctx.fiber.dispose()
    })
    return (program, functions, timeoutMs = 400, signal) => runtime.run({
      program,
      bindings: [{ global: 'tools', functions }],
      cwd: process.cwd(),
      timeoutMs,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd() },
      ...(signal === undefined ? {} : { signal }),
    })
  }

  for (const name of ['wait_subagent', 'ask_user_question']) {
    await t.test(name + ' outlasts the program budget in a real worker', async (t) => {
      const run = fixture(t)
      const start = Date.now()
      const result = await run('return await tools.' + name + '({})', {
        [name]: async () => { await delay(650); return name + '-done' },
      })
      assert.equal(result.error, undefined)
      assert.equal(result.value, name + '-done')
      assert.ok(Date.now() - start >= 650)
    })
  }

  await t.test('namespace copying preserves a tool named __proto__', async (t) => {
    const run = fixture(t)
    const functions = Object.create(null)
    Object.defineProperty(functions, '__proto__', {
      enumerable: true,
      value: async () => 'special-tool-result',
    })
    functions.wait_subagent = async () => 'unused'
    const result = await run("return await tools['__proto__']({})", functions)
    assert.equal(result.error, undefined)
    assert.equal(result.value, 'special-tool-result')
  })

  await t.test('overlapping exempt bindings stay paused until the last one settles', async (t) => {
    const run = fixture(t)
    const result = await run('return await Promise.all([tools.wait_subagent({}), tools.ask_user_question({})])', {
      wait_subagent: async () => { await delay(500); return 'wait-done' },
      ask_user_question: async () => { await delay(1000); return 'ask-done' },
    })
    assert.equal(result.error, undefined)
    assert.deepEqual(result.value, ['wait-done', 'ask-done'])
  })

  await t.test('the remaining budget expires after an exempt binding settles', async (t) => {
    const run = fixture(t)
    const result = await run('await tools.wait_subagent({}); while (true) {}', {
      wait_subagent: async () => { await delay(650); return 'waited' },
    })
    assert.equal(result.error?.kind, 'timeout')
    assert.equal(result.error.message, 'execution deadline reached (400ms)')
  })

  await t.test('time spent before a wait is deducted from the resumed budget', async (t) => {
    const run = fixture(t)
    const active = new Set()
    t.after(() => Promise.all(active))
    const result = await run("await tools.hold({ ms: 200 }); await tools.wait_subagent({}); await tools.hold({ ms: 250 }); return 'over-budget'", {
      wait_subagent: async () => { await delay(650); return 'waited' },
      hold: ({ ms }) => {
        const pending = delay(ms).then(() => 'held')
        active.add(pending)
        pending.finally(() => active.delete(pending))
        return pending
      },
    })
    assert.equal(result.error?.kind, 'timeout')
  })

  await t.test('ordinary bindings still consume the program budget', async (t) => {
    const run = fixture(t)
    const pending = delay(900).then(() => 'late')
    t.after(() => pending)
    const result = await run('return await tools.hold({})', {
      wait_subagent: async () => 'unused',
      hold: () => pending,
    })
    assert.equal(result.error?.kind, 'timeout')
  })

  await t.test('outer cancellation interrupts a worker during an exempt wait', async (t) => {
    const run = fixture(t)
    const controller = new AbortController()
    const entered = Promise.withResolvers()
    const finish = Promise.withResolvers()
    const pending = run('return await tools.wait_subagent({})', {
      wait_subagent: async () => { entered.resolve(); return await finish.promise },
    }, 400, controller.signal)
    await entered.promise
    controller.abort('user stop')
    try {
      const result = await pending
      assert.equal(result.error?.kind, 'abort')
      assert.equal(result.error.message, 'user stop')
    } finally {
      finish.resolve('released')
    }
  })

  await t.test('parallel programs keep independent deadlines', async (t) => {
    const run = fixture(t)
    const pending = delay(900).then(() => 'late')
    t.after(() => pending)
    const [waited, ordinary] = await Promise.all([
      run('return await tools.wait_subagent({})', {
        wait_subagent: async () => { await delay(650); return 'waited' },
      }),
      run('return await tools.hold({})', {
        wait_subagent: async () => 'unused',
        hold: () => pending,
      }),
    ])
    assert.equal(waited.value, 'waited')
    assert.equal(ordinary.error?.kind, 'timeout')
  })

  await t.test('a nested runtime invocation keeps its own ordinary-tool deadline', async (t) => {
    const run = fixture(t)
    const pending = delay(900).then(() => 'late')
    t.after(() => pending)
    const result = await run('return await tools.wait_subagent({})', {
      wait_subagent: () => run('return await tools.hold({})', {
        wait_subagent: async () => 'unused',
        hold: () => pending,
      }, 200),
    })
    assert.equal(result.error, undefined)
    assert.equal(result.value.error.kind, 'timeout')
  })
})
