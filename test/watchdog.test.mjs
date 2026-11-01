import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULTS,
  buildSweepScript,
  createWatchdog,
  extractCommand,
  isPnpmMutation,
  isProfileMutation,
  mutationDetector,
  resolveConfig,
} from '../index.js'

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-watchdog-'))
  mkdirSync(join(dir, '.plugin-manager', 'logs'), { recursive: true })
  mkdirSync(join(dir, '.dsh-market'), { recursive: true })
  writeFileSync(join(dir, '.dsh-market', 'log.ndjson'), '')
  return dir
}

function watchdogFor(dir, calls) {
  const config = resolveConfig({
    profileDir: dir,
    logPath: join(dir, 'watchdog.log'),
    sweepIntervalMs: 250,
    watcherIntervalMs: 250,
    minSweepGapMs: 0,
    activeWindowMs: 60_000,
  })
  const watchdog = createWatchdog({
    config,
    now: () => 1_000_000,
    sweep: async (trigger) => {
      calls.push(trigger)
      return { killed: [] }
    },
  })
  watchdog.prime()
  return { config, watchdog }
}

test('resolveConfig applies defaults and clamps', () => {
  const config = resolveConfig({})
  assert.equal(config.enabled, true)
  assert.deepEqual(config.bashPathPatterns, DEFAULTS.bashPathPatterns)
  assert.equal(config.activeWindowMs, DEFAULTS.activeWindowMs)
  assert.equal(config.profileDir, null)

  const clamped = resolveConfig({ activeWindowMs: 1, sweepIntervalMs: 999_999, watcherIntervalMs: 'x' })
  assert.equal(clamped.activeWindowMs, 5_000)
  assert.equal(clamped.sweepIntervalMs, 10_000)
  assert.equal(clamped.watcherIntervalMs, DEFAULTS.watcherIntervalMs)

  assert.deepEqual(resolveConfig({ bashPathPatterns: 'a, b' }).bashPathPatterns, ['a', 'b'])
})

test('isPnpmMutation recognizes mutating package commands only', () => {
  const detector = mutationDetector(resolveConfig({}))
  for (const command of [
    'pnpm install',
    'corepack pnpm update --latest',
    'pnpm add dsh-meme',
    'pnpm remove dsh-meme',
    'pnpm i',
    'dsh plugin add ./plugin',
    'cd /d C:\\x && pnpm rebuild',
  ]) {
    assert.equal(isPnpmMutation(command, detector), true, command)
  }
  for (const command of ['pnpm --version', 'pnpm list', 'git status', 'echo hello', '']) {
    assert.equal(isPnpmMutation(command, detector), false, command)
  }
})

test('extractCommand reads the command key of a shell tool call', () => {
  assert.equal(extractCommand({ command: 'pnpm install' }), 'pnpm install')
  assert.equal(extractCommand({ cmd: 'x' }), 'x')
  assert.equal(extractCommand({ unrelated: true }), '')
  assert.equal(extractCommand('plain'), 'plain')
})

test('buildSweepScript quotes patterns safely', () => {
  const script = buildSweepScript(["dsh-win-bash", "a'b"])
  assert.match(script, /@\('dsh-win-bash', 'a''b'\)/)
  assert.ok(script.includes('taskkill.exe /PID'))
  assert.ok(script.includes('Get-Process'))
})

test('a new official operation-* directory arms the sweep', async () => {
  const dir = tempDir()
  try {
    const calls = []
    const { watchdog } = watchdogFor(dir, calls)
    mkdirSync(join(dir, '.plugin-manager', 'logs', 'operation-abc123'))
    await watchdog.tick()
    assert.deepEqual(calls, ['plugin-manager-operation:operation-abc123'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('existing operation directories do not arm the sweep', async () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, '.plugin-manager', 'logs', 'operation-old'))
    const calls = []
    const { watchdog } = watchdogFor(dir, calls)
    await watchdog.tick()
    assert.deepEqual(calls, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a market install record arms the sweep', async () => {
  const dir = tempDir()
  try {
    const calls = []
    const { watchdog } = watchdogFor(dir, calls)
    appendFileSync(
      join(dir, '.dsh-market', 'log.ndjson'),
      `${JSON.stringify({ at: 'now', level: 'info', event: 'install', detail: 'pnpm is about to run' })}\n`,
    )
    await watchdog.tick()
    assert.deepEqual(calls, ['market:install'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('market config-only records are ignored', async () => {
  const dir = tempDir()
  try {
    const calls = []
    const { watchdog } = watchdogFor(dir, calls)
    appendFileSync(
      join(dir, '.dsh-market', 'log.ndjson'),
      `${JSON.stringify({ at: 'now', level: 'info', event: 'toggle', detail: 'x' })}\n`,
    )
    await watchdog.tick()
    assert.deepEqual(calls, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('official install-log chunks arm once per pnpm job and extend the window', async () => {
  const dir = tempDir()
  try {
    const calls = []
    const { watchdog } = watchdogFor(dir, calls)
    const chunk = { jobId: 'job-1', argv: ['pnpm', 'add', 'x'], stream: 'stdout', text: 'downloading' }
    watchdog.handleInstallLog(chunk)
    watchdog.handleInstallLog({ ...chunk, text: 'still downloading' })
    await Promise.resolve()
    assert.deepEqual(calls, ['plugin-manager/install-log'])
    assert.ok(watchdog.state.windowUntil > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('install-state installing arms the sweep', async () => {
  const dir = tempDir()
  try {
    const calls = []
    const { watchdog } = watchdogFor(dir, calls)
    watchdog.handleInstallState({ requestId: 'r1', phase: 'installing' })
    assert.deepEqual(calls, ['plugin-manager/install-state'])
    watchdog.handleInstallState({ requestId: 'r1', phase: 'applying' })
    assert.deepEqual(calls, ['plugin-manager/install-state'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pwsh call that runs pnpm sweeps before next()', async () => {
  const dir = tempDir()
  try {
    const calls = []
    const { watchdog } = watchdogFor(dir, calls)
    let continued = false
    const decision = await watchdog.handlePreExecute(
      { name: 'pwsh', arguments: { command: 'corepack pnpm update --latest' }, signal: { aborted: false } },
      async () => {
        continued = true
        return { kind: 'allow' }
      },
    )
    assert.equal(continued, true)
    assert.deepEqual(decision, { kind: 'allow' })
    assert.deepEqual(calls, ['tool:pwsh'])
    assert.ok(watchdog.state.toolWindows.size > 0)

    await watchdog.handlePreExecute(
      { name: 'read', arguments: { file_path: 'C:\\x' }, signal: { aborted: false } },
      async () => ({ kind: 'allow' }),
    )
    assert.deepEqual(calls, ['tool:pwsh'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the official bash tool name is intercepted as well', async () => {
  const dir = tempDir()
  try {
    const calls = []
    const { watchdog } = watchdogFor(dir, calls)
    const decision = await watchdog.handlePreExecute(
      { name: 'bash', arguments: { command: 'pnpm install --ignore-scripts' }, signal: { aborted: false } },
      async () => ({ kind: 'allow' }),
    )
    assert.deepEqual(decision, { kind: 'allow' })
    assert.deepEqual(calls, ['tool:bash'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isProfileMutation distinguishes DSH profile commands from project commands', () => {
  const profile = 'C:\\Users\\daeda\\.dsh\\profiles\\desktop'
  assert.equal(isProfileMutation('pnpm install', {}, profile), false)
  assert.equal(isProfileMutation('pnpm update --latest', { workdir: 'C:\\work\\project' }, profile), false)
  assert.equal(isProfileMutation('dsh plugin add ./x', {}, profile), true)
  assert.equal(isProfileMutation(`cd ${profile} && pnpm update`, {}, profile), true)
  assert.equal(isProfileMutation('cd ~/.dsh/profiles/desktop && pnpm update', {}, profile), true)
  assert.equal(isProfileMutation('pnpm install', { workdir: profile }, profile), true)
  assert.equal(isProfileMutation('pnpm install', {}, profile, profile), true)
  assert.equal(isProfileMutation('cd ../project && pnpm install', {}, profile, profile), false)
})

test('win_bash refuses profile pnpm mutations instead of trying to kill the shell', async () => {
  const dir = tempDir()
  try {
    const calls = []
    const { watchdog } = watchdogFor(dir, calls)
    let continued = false
    const decision = await watchdog.handlePreExecute(
      { name: 'win_bash', arguments: { command: `cd ${dir} && pnpm update` }, signal: { aborted: false } },
      async () => {
        continued = true
        return { kind: 'allow' }
      },
    )
    assert.equal(continued, false)
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /plugin manager|replacePwsh:false/)
    assert.match(decision.reason, /restart DSH once/)
    assert.deepEqual(calls, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('win_bash still allows an ordinary project pnpm command', async () => {
  const dir = tempDir()
  try {
    const calls = []
    const { watchdog } = watchdogFor(dir, calls)
    let continued = false
    const decision = await watchdog.handlePreExecute(
      { name: 'win_bash', arguments: { command: 'pnpm install --ignore-scripts' }, signal: { aborted: false } },
      async () => {
        continued = true
        return { kind: 'allow' }
      },
    )
    assert.equal(continued, true)
    assert.deepEqual(decision, { kind: 'allow' })
    assert.deepEqual(calls, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tools/post-execute closes only its own tool window', async () => {
  const dir = tempDir()
  try {
    const calls = []
    const { watchdog } = watchdogFor(dir, calls)
    for (const callId of ['call-1', 'call-2']) {
      await watchdog.handlePreExecute(
        { name: 'pwsh', callId, arguments: { command: 'pnpm install' }, signal: { aborted: false } },
        async () => ({ kind: 'allow' }),
      )
    }
    assert.equal(watchdog.state.toolWindows.size, 2)
    await watchdog.handlePostExecute(
      { name: 'pwsh', callId: 'call-1', arguments: { command: 'pnpm install' } },
      { isError: false },
      async () => ({ kind: 'allow' }),
    )
    assert.equal(watchdog.state.toolWindows.has('call-2'), true)
    assert.equal(watchdog.state.toolWindows.has('call-1'), true)
    // The finished call's window was shortened to the sweep interval.
    const [until] = [...watchdog.state.toolWindows.entries()].filter(([key]) => key === 'call-1').map(([, value]) => value)
    assert.ok(until <= 1_000_000 + 250)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a market completion record closes the operation window', async () => {
  const dir = tempDir()
  try {
    const calls = []
    const { watchdog } = watchdogFor(dir, calls)
    appendFileSync(
      join(dir, '.dsh-market', 'log.ndjson'),
      `${JSON.stringify({ event: 'update-start', detail: 'dsh-meme -> 0.1.73' })}\n`,
    )
    await watchdog.tick()
    const openUntil = watchdog.state.windowUntil
    assert.ok(openUntil > 0)
    appendFileSync(
      join(dir, '.dsh-market', 'log.ndjson'),
      `${JSON.stringify({ event: 'update', detail: 'dsh-meme exit=0 hot=true' })}\n`,
    )
    await watchdog.tick()
    assert.ok(watchdog.state.windowUntil < openUntil)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the active window keeps sweeping for new shells', async () => {
  const dir = tempDir()
  try {
    const calls = []
    const { watchdog } = watchdogFor(dir, calls)
    await watchdog.activate('manual', { force: true })
    watchdog.state.nextSweepAt = 0
    await watchdog.tick()
    assert.ok(calls.length >= 2, `expected at least two sweeps, got ${calls.length}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
