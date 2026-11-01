/**
 * dsh-bash-watchdog — Host half.
 *
 * `@linxin666/dsh-win-bash` keeps one bash.exe alive per calling agent. That
 * process runs from inside its own package directory, so while it lives pnpm
 * cannot replace that directory (`ERR_PNPM_EPERM` on the final rename) and a
 * plugin update/uninstall can leave the profile half-written.
 *
 * This plugin stops those shells just before the Harness starts a pnpm
 * mutation, instead of waiting for pnpm to fail:
 *
 * - `plugin-manager/install-log` / `install-state` events (official manager);
 * - a new `operation-*` directory under `<profile>/.plugin-manager/logs`
 *   (created by the manager immediately before pnpm is spawned);
 * - new `.dsh-market/log.ndjson` records (the market runs its own pnpm);
 * - a shell tool call whose command runs a mutating pnpm command.
 *
 * On every trigger it kills only bash.exe processes whose executable path
 * contains one of `bashPathPatterns` (default `dsh-win-bash`), so an unrelated
 * Git Bash is never touched. Each trigger opens a short window during which the
 * sweep repeats, because another session can start a shell while pnpm is still
 * unpacking.
 *
 * Deliberately zero-dependency: only `node:` builtins are imported, so a
 * directory install (which pnpm links from a checkout instead of copying into
 * the profile) resolves everything it needs.
 */

import { execFile } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  watch,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const PLUGIN_NAME = 'dsh-bash-watchdog'

/** Every knob the plugin understands, with its effective default. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  /** Substrings matched (case-insensitively) against bash.exe's own path. */
  bashPathPatterns: ['dsh-win-bash'],
  /** How long one operation trigger keeps sweeping for newer shells. */
  activeWindowMs: 120_000,
  /** Upper bound on the sweep window opened by one shell tool call. */
  toolWindowMs: 120_000,
  /** Delay between sweeps while a window is open. */
  sweepIntervalMs: 2_000,
  /** Delay between filesystem/process watcher ticks. */
  watcherIntervalMs: 300,
  /** Minimum gap between two sweeps, even across triggers. */
  minSweepGapMs: 600,
  /** Kill matching shells once when the Host activates this plugin. */
  sweepOnStartup: false,
  /** Watch new operation-* directories written by the official manager. */
  watchPluginManagerLogs: true,
  /** Watch the plugin market's ndjson log for mutation starts. */
  watchMarketLog: true,
  /** Sweep before a shell tool call that runs a mutating pnpm command. */
  interceptShellTools: true,
  /**
   * Tool names whose `command` argument is inspected (case-insensitive).
   * `win_bash` is deliberately absent: killing the shell a command is about to
   * run in would abort the very pnpm run that needs the lock released, so
   * mutations belong on a one-shot shell (`pwsh`).
   */
  shellToolNames: ['pwsh', 'bash', 'shell', 'terminal', 'run_command'],
  /**
   * Tools that own a persistent shell. A pnpm mutation that targets the DSH
   * profile cannot run here safely: the shell's own bash.exe is the file pnpm
   * must replace, and killing it would abort the command. Such calls are
   * denied with an actionable reason instead.
   */
  persistentShellToolNames: ['win_bash'],
  /** Guard profile-targeting pnpm mutations inside a persistent shell. */
  denyProfilePnpmInPersistentShell: true,
  /** `i`-flagged regexp source: does this command mutate the dependency tree? */
  pnpmMutationPattern:
    String.raw`\b(?:pnpm|corepack\s+pnpm|dsh\s+plugin)\b[^\r\n;&|]{0,160}?\b(?:install|add|remove|rm|uninstall|update|upgrade|rebuild|prune|dedupe|import|link|unlink|i)\b`,
  /** Profile whose .plugin-manager/.dsh-market paths are watched. */
  profileDir: null,
  /** Command log. Default: `<DSH_HOME>/logs/dsh-bash-watchdog.log`. */
  logPath: null,
  /** PowerShell executable; the first one that can run wins. */
  powershellPath: null,
  /** Rotate the command log once it grows past this size. */
  maxLogBytes: 1_048_576,
})

/** Market log records that begin a package command. */
const MARKET_START_EVENTS = new Set([
  'install',
  'uninstall-start',
  'update-start',
  'update-repair',
  'update-compat',
  'find-compatible',
  'drain',
])

/** Market log records that finish (or abandon) a package command. */
const MARKET_END_EVENTS = new Set([
  'uninstall',
  'update',
  'cancel',
  'update-blocked',
  'update-rollback',
  'update-removed-declaration',
])

const SWEEP_TIMEOUT_MS = 20_000

const PERSISTENT_SHELL_DENY_REASON =
  'dsh-bash-watchdog refused this command: a pnpm mutation that targets the DSH profile cannot run inside the persistent win-bash shell. That shell is itself the locked bash.exe pnpm must replace, so killing it would only abort this command. Use the plugin manager or the plugin market for DSH plugins, or set @linxin666/dsh-win-bash replacePwsh:false, restart DSH once so the withdrawn pwsh tool comes back, and then run the command through pwsh.'

/**
 * Normalize the raw Loader `config` object into the effective one.
 * @param {Record<string, unknown> | undefined} input raw row config
 * @returns {typeof DEFAULTS} effective config
 */
export function resolveConfig(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const patterns = normalizePatterns(source.bashPathPatterns)
  const toolNames = normalizeToolNames(source.shellToolNames)
  const persistentToolNames = normalizeToolNames(source.persistentShellToolNames)
  return {
    ...DEFAULTS,
    enabled: source.enabled !== false,
    bashPathPatterns: patterns.length > 0 ? patterns : [...DEFAULTS.bashPathPatterns],
    activeWindowMs: clampNumber(source.activeWindowMs, DEFAULTS.activeWindowMs, 5_000, 1_800_000),
    toolWindowMs: clampNumber(source.toolWindowMs, DEFAULTS.toolWindowMs, 5_000, 1_800_000),
    sweepIntervalMs: clampNumber(source.sweepIntervalMs, DEFAULTS.sweepIntervalMs, 250, 10_000),
    watcherIntervalMs: clampNumber(source.watcherIntervalMs, DEFAULTS.watcherIntervalMs, 250, 5_000),
    minSweepGapMs: clampNumber(source.minSweepGapMs, DEFAULTS.minSweepGapMs, 0, 10_000),
    sweepOnStartup: source.sweepOnStartup === true,
    watchPluginManagerLogs: source.watchPluginManagerLogs !== false,
    watchMarketLog: source.watchMarketLog !== false,
    interceptShellTools: source.interceptShellTools !== false,
    shellToolNames: toolNames.length > 0 ? toolNames : [...DEFAULTS.shellToolNames],
    persistentShellToolNames:
      persistentToolNames.length > 0 ? persistentToolNames : [...DEFAULTS.persistentShellToolNames],
    denyProfilePnpmInPersistentShell: source.denyProfilePnpmInPersistentShell !== false,
    pnpmMutationPattern:
      typeof source.pnpmMutationPattern === 'string' && source.pnpmMutationPattern.trim() !== ''
        ? source.pnpmMutationPattern
        : DEFAULTS.pnpmMutationPattern,
    profileDir: typeof source.profileDir === 'string' && source.profileDir.trim() !== '' ? source.profileDir : null,
    logPath: typeof source.logPath === 'string' && source.logPath.trim() !== '' ? source.logPath : null,
    powershellPath:
      typeof source.powershellPath === 'string' && source.powershellPath.trim() !== '' ? source.powershellPath : null,
    maxLogBytes: clampNumber(source.maxLogBytes, DEFAULTS.maxLogBytes, 4_096, 64 * 1_048_576),
  }
}

/**
 * Resolve the profile directory the same way the Host process names it.
 * @param {ReturnType<typeof resolveConfig>} config effective config
 * @returns {string} absolute profile directory
 */
export function resolveProfileDir(config) {
  if (config.profileDir !== null) return config.profileDir
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') {
    return process.env.DSH_PROFILE_DIR
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'profiles', process.env.DSH_PROFILE || 'desktop')
}

/**
 * Compile the mutation detector once. An invalid user pattern falls back to the
 * shipped one instead of disabling the guard.
 * @param {ReturnType<typeof resolveConfig>} config effective config
 * @returns {RegExp} detector
 */
export function mutationDetector(config) {
  for (const source of [config.pnpmMutationPattern, DEFAULTS.pnpmMutationPattern]) {
    try {
      return new RegExp(source, 'i')
    } catch {
      // try the next source
    }
  }
  return /\bpnpm\b/i
}

/**
 * Whether a shell command looks like it will mutate the dependency tree.
 * @param {string} command shell command text
 * @param {RegExp} detector compiled detector
 * @returns {boolean} true when a sweep should run first
 */
export function isPnpmMutation(command, detector) {
  return typeof command === 'string' && command !== '' && detector.test(command)
}

/**
 * The command text carried by a shell tool call, if any.
 * @param {unknown} args parsed tool arguments
 * @returns {string} command text, or an empty string
 */
export function extractCommand(args) {
  if (typeof args === 'string') return args
  if (args === null || typeof args !== 'object') return ''
  for (const key of ['command', 'cmd', 'script', 'code', 'input', 'shellCommand']) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return ''
}

/**
 * Does this command mutate the DSH profile (as opposed to some project)?
 *
 * This is the classification used to refuse a pnpm mutation inside a
 * persistent shell, where killing the shell cannot save the command. It is
 * intentionally conservative: an explicit profile path, a `dsh plugin` call,
 * a profile `workdir`, or a session whose own directory is inside the profile
 * counts; an ordinary project `pnpm install` does not.
 * @param {string} command shell command text
 * @param {unknown} args parsed tool arguments
 * @param {string} profileDir absolute profile directory
 * @param {string | undefined} [sessionCwd] the calling session's directory
 * @returns {boolean} true when the command targets the DSH profile
 */
export function isProfileMutation(command, args, profileDir, sessionCwd) {
  if (typeof command !== 'string' || command === '') return false
  if (/\bdsh\s+plugin\b/i.test(command)) return true

  const profile = normalizePathText(profileDir)
  const text = normalizePathText(command)
  if (profile !== '' && text.includes(profile)) return true
  // Also catch relative/~ spellings such as `cd ~/.dsh/profiles/desktop`.
  const profileName = normalizePathText(basename(profileDir))
  if (profileName !== '' && text.includes(`/profiles/${profileName}`)) return true

  const workdir = args !== null && typeof args === 'object' && typeof args.workdir === 'string' ? normalizePathText(args.workdir) : ''
  if (profile !== '' && workdir !== '' && pathInside(workdir, profile)) return true

  const cwd = normalizePathText(sessionCwd ?? '')
  if (profile !== '' && cwd !== '' && pathInside(cwd, profile)) {
    // A command that cd's elsewhere (or passes an explicit other --dir) is not
    // a profile mutation just because the session started inside the profile.
    const changesDirectory = /\bcd\s+/i.test(command) || /--dir\b|--prefix\b|-C\b/i.test(command)
    if (!changesDirectory) return true
  }
  return false
}

/**
 * Normalize a path or command for case-insensitive containment checks.
 * @param {string} value text to normalize
 * @returns {string} slash-normalized, lowercased text
 */
function normalizePathText(value) {
  return String(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Whether one normalized path is the same as or below another.
 * @param {string} child normalized candidate path
 * @param {string} parent normalized parent path
 * @returns {boolean} true when child is parent or inside it
 */
function pathInside(child, parent) {
  return child === parent || child.startsWith(`${parent}/`)
}

/**
 * Kill every running bash.exe whose executable path matches the configured
 * patterns. The process list and the kill both happen in one PowerShell
 * invocation so a shell cannot slip between the listing and the kill.
 * @param {ReturnType<typeof resolveConfig>} config effective config
 * @returns {Promise<{ killed: Array<{ pid: number, path: string }>, failed: Array<{ pid: number, path: string, message: string }>, skipped?: boolean, error?: string }>}
 */
export async function sweepWinBash(config) {
  if (process.platform !== 'win32') return { killed: [], failed: [], skipped: true }

  const script = buildSweepScript(config.bashPathPatterns)
  let result
  try {
    result = await runPowerShell(script, config)
  } catch (error) {
    return { killed: [], failed: [], error: messageOf(error) }
  }

  const killed = []
  const failed = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const text = line.trim()
    if (text === '') continue
    const first = text.indexOf('|')
    const second = text.indexOf('|', first + 1)
    if (first < 0 || second < 0) continue
    const pid = Number.parseInt(text.slice(0, first), 10)
    if (!Number.isInteger(pid)) continue
    const status = text.slice(first + 1, second)
    const path = text.slice(second + 1)
    if (status === 'ok') killed.push({ pid, path })
    else failed.push({ pid, path, message: result.stderr.trim() })
  }
  return { killed, failed, ...(result.code !== 0 && killed.length === 0 && failed.length === 0 ? { error: result.stderr.trim() || `PowerShell exited ${result.code}` } : {}) }
}

/**
 * Build the one-shot PowerShell program. Patterns are embedded as a literal
 * array. The primary kill is Stop-Process (fast); a refused kill falls back to
 * `taskkill /T`, which tears down the shell's child processes too.
 * @param {string[]} patterns path substrings
 * @returns {string} PowerShell source
 */
export function buildSweepScript(patterns) {
  const literal = patterns.map(psQuote).join(', ')
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$patterns = @(${literal})`,
    '$results = New-Object System.Collections.Generic.List[string]',
    "Get-Process -Name 'bash' -ErrorAction SilentlyContinue | ForEach-Object {",
    '  $processId = $_.Id',
    '  $path = $null',
    '  try { $path = [string]$_.Path } catch { $path = $null }',
    '  if (-not [string]::IsNullOrEmpty($path)) {',
    '    $matched = $false',
    '    foreach ($pattern in $patterns) {',
    '      if ($path.IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $matched = $true; break }',
    '    }',
    '    if ($matched) {',
    '      $status = "ok"',
    '      try {',
    '        Stop-Process -Id $processId -Force -ErrorAction Stop',
    '      } catch {',
    '        $null = & taskkill.exe /PID $processId /T /F 2>&1',
    '        if ($LASTEXITCODE -ne 0) { $status = "fail" }',
    '      }',
    '      $results.Add(("{0}|{1}|{2}" -f $processId, $status, $path))',
    '    }',
    '  }',
    '}',
    '$results | ForEach-Object { Write-Output $_ }',
    'exit 0',
  ].join('\n')
}

/**
 * Run one PowerShell program, trying the configured executable and then the
 * well-known ones until one starts.
 * @param {string} script PowerShell source
 * @param {ReturnType<typeof resolveConfig>} config effective config
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
async function runPowerShell(script, config) {
  const candidates = powershellCandidates(config)
  // -EncodedCommand survives both Windows PowerShell 5.1 and pwsh without the
  // native command line folding the script's newlines into one statement.
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  let lastError = null
  for (const candidate of candidates) {
    try {
      return await execFileText(
        candidate,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        SWEEP_TIMEOUT_MS,
      )
    } catch (error) {
      lastError = error
      if (error && error.code !== 'ENOENT') break
    }
  }
  throw lastError ?? new Error('no PowerShell executable could be started')
}

/**
 * Candidate PowerShell executables in preference order. Windows PowerShell
 * starts several times faster than pwsh here, and the sweep only needs
 * Get-Process/taskkill, so it is asked first.
 * @param {ReturnType<typeof resolveConfig>} config effective config
 * @returns {string[]} executable paths or names
 */
function powershellCandidates(config) {
  const candidates = []
  if (config.powershellPath !== null) candidates.push(config.powershellPath)
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  candidates.push(join(programFiles, 'PowerShell', '7', 'pwsh.exe'))
  candidates.push('powershell.exe', 'pwsh.exe')
  return [...new Set(candidates)]
}

/**
 * execFile wrapper returning text instead of buffers.
 * @param {string} file executable
 * @param {string[]} args arguments
 * @param {number} timeoutMs deadline
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function execFileText(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1_048_576, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error && (typeof error.code === 'string' || error.killed === true || error.signal !== null)) {
          // Spawn-level failure (ENOENT, EACCES) or a timeout: no verdict.
          reject(error)
          return
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: typeof error?.code === 'number' ? error.code : 0 })
      },
    )
  })
}

/**
 * Build the watchdog's state machine and its trigger handlers.
 *
 * Exported separately from `apply` so the trigger logic can be exercised
 * without a running Host: tests inject a recording `sweep`.
 * @param {object} options
 * @param {ReturnType<typeof resolveConfig>} options.config effective config
 * @param {any} [options.ctx] plugin context (only used for events/logging)
 * @param {(trigger: string) => Promise<unknown>} [options.sweep] sweep implementation
 * @param {() => number} [options.now] clock
 * @returns {{ state: object, paths: { operationDir: string, marketLogPath: string }, activate: Function, touch: Function, tick: Function, handleInstallLog: Function, handleInstallState: Function, handleChanged: Function, handlePreExecute: Function, handlePostExecute: Function, prime: Function, dispose: Function }}
 */
export function createWatchdog({ config, ctx, sweep, now = Date.now }) {
  const state = {
    /** Window opened by the official manager / market watchers. */
    windowUntil: 0,
    /** Per-tool-call windows; tools/post-execute removes the call's entry. */
    toolWindows: new Map(),
    lastSweepAt: 0,
    nextSweepAt: 0,
    inFlight: null,
    lastTrigger: null,
    kills: 0,
    sweeps: 0,
    ticking: false,
    disposed: false,
  }
  const logger = safeLogger(ctx)
  const detector = mutationDetector(config)
  const profileDir = resolveProfileDir(config)
  const toolNames = new Set(config.shellToolNames.map((name) => name.toLowerCase()))
  const persistentToolNames = new Set(config.persistentShellToolNames.map((name) => name.toLowerCase()))

  const sweepImpl = sweep ?? (() => sweepWinBash(config))

  function logLine(record) {
    try {
      logger.info(`[${record.event}] ${JSON.stringify(record)}`)
    } catch {
      // logging must never break the guard
    }
    writeLogRecord(config, record)
  }

  async function runSweep(trigger, force = false) {
    if (state.disposed) return null
    if (state.inFlight !== null) return state.inFlight
    const startedAt = now()
    if (!force && startedAt - state.lastSweepAt < config.minSweepGapMs) return null
    state.lastSweepAt = startedAt
    state.sweeps += 1
    const task = (async () => {
      try {
        const outcome = await sweepImpl(trigger)
        const killed = Array.isArray(outcome?.killed) ? outcome.killed : []
        const failed = Array.isArray(outcome?.failed) ? outcome.failed : []
        if (killed.length > 0) {
          state.kills += killed.length
          logLine({ event: 'killed', trigger, at: new Date(now()).toISOString(), killed, failed })
        } else if (failed.length > 0 || outcome?.error) {
          logLine({ event: 'sweep-error', trigger, at: new Date(now()).toISOString(), failed, error: outcome?.error ?? null })
        }
        return outcome
      } catch (error) {
        logLine({ event: 'sweep-error', trigger, at: new Date(now()).toISOString(), error: messageOf(error) })
        return null
      } finally {
        state.inFlight = null
        state.nextSweepAt = now() + config.sweepIntervalMs
      }
    })()
    state.inFlight = task
    return task
  }

  /**
   * Extend one of the two independent windows.
   * @param {string} trigger trigger label
   * @param {'operation' | 'tool'} kind which window to grow
   * @param {string} [callId] tool call owning a tool window
   */
  function extendWindow(trigger, kind, callId) {
    if (state.disposed) return
    if (kind === 'tool') {
      state.toolWindows.set(callId ?? 'anonymous', now() + config.toolWindowMs)
    } else {
      const until = now() + config.activeWindowMs
      if (until > state.windowUntil) state.windowUntil = until
    }
    state.lastTrigger = trigger
  }

  /** @returns {boolean} whether either guard window is still open */
  function active() {
    if (state.windowUntil > now()) return true
    for (const until of state.toolWindows.values()) {
      if (until > now()) return true
    }
    return false
  }

  /** Shorten the operation window; used once a command is known to be done. */
  function endOperationWindow() {
    if (state.windowUntil > now()) state.windowUntil = now() + config.sweepIntervalMs
  }

  /**
   * Shorten one shell call's window; used by tools/post-execute.
   * @param {string} [callId] finished call
   */
  function endToolWindow(callId) {
    const key = callId ?? 'anonymous'
    const until = state.toolWindows.get(key)
    if (until !== undefined && until > now()) state.toolWindows.set(key, now() + config.sweepIntervalMs)
  }

  /**
   * Extend a window without sweeping.
   * @param {string} trigger trigger label
   */
  function touch(trigger) {
    extendWindow(trigger, 'operation')
  }

  /**
   * Extend a window and sweep now.
   * @param {string} trigger trigger label
   * @param {{ force?: boolean, kind?: 'operation' | 'tool' | 'startup', callId?: string }} [options]
   *   force bypasses the minimum gap; kind selects the window (default operation)
   * @returns {Promise<unknown>}
   */
  async function activate(trigger, options = {}) {
    if (state.disposed) return null
    const kind = options.kind ?? 'operation'
    if (kind !== 'startup') extendWindow(trigger, kind, options.callId)
    logLine({ event: 'activate', trigger, at: new Date(now()).toISOString() })
    return runSweep(trigger, options.force === true)
  }

  /** Filesystem + schedule tick. */
  async function tick() {
    if (state.disposed || state.ticking) return
    state.ticking = true
    try {
      for (const [callId, until] of state.toolWindows) {
        if (until <= now()) state.toolWindows.delete(callId)
      }
      pollOperationDirectories()
      pollMarketLog()
      if (active() && now() >= state.nextSweepAt) {
        state.nextSweepAt = now() + config.sweepIntervalMs
        void runSweep(state.lastTrigger ?? 'active-window')
      }
    } catch (error) {
      logLine({ event: 'tick-error', at: new Date(now()).toISOString(), error: messageOf(error) })
    } finally {
      state.ticking = false
    }
  }

  const operationDir = join(profileDir, '.plugin-manager', 'logs')
  const knownOperations = new Set()
  function primeOperationDirectories() {
    if (!config.watchPluginManagerLogs) return
    try {
      for (const name of readdirSync(operationDir)) {
        if (name.startsWith('operation-')) knownOperations.add(name)
      }
    } catch {
      // A profile without a manager log yet is ordinary.
    }
  }
  function pollOperationDirectories() {
    if (!config.watchPluginManagerLogs) return
    let names
    try {
      names = readdirSync(operationDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.startsWith('operation-') || knownOperations.has(name)) continue
      knownOperations.add(name)
      void activate(`plugin-manager-operation:${name}`)
    }
    if (knownOperations.size > 2_000) {
      knownOperations.clear()
      for (const name of names) if (name.startsWith('operation-')) knownOperations.add(name)
    }
  }

  const marketLogPath = join(profileDir, '.dsh-market', 'log.ndjson')
  const market = { offset: null, carry: '' }
  function primeMarketLog() {
    if (!config.watchMarketLog) return
    try {
      market.offset = statSync(marketLogPath).size
    } catch {
      market.offset = 0
    }
  }
  function pollMarketLog() {
    if (!config.watchMarketLog) return
    let size
    try {
      size = statSync(marketLogPath).size
    } catch {
      return
    }
    if (market.offset === null || size < market.offset) {
      market.offset = 0
      market.carry = ''
    }
    if (size === market.offset) return
    const length = size - market.offset
    let text
    try {
      const fd = openSync(marketLogPath, 'r')
      try {
        const buffer = Buffer.alloc(length)
        readSync(fd, buffer, 0, length, market.offset)
        text = buffer.toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return
    }
    market.offset = size
    const lines = (market.carry + text).split('\n')
    market.carry = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let record
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      const event = record?.event
      const detail = typeof record?.detail === 'string' ? record.detail : ''
      // `exit=` is the market's own completion marker for an install/update run.
      if (/\bexit=\d+\b/.test(detail)) {
        endOperationWindow()
        continue
      }
      if (typeof event !== 'string') continue
      if (MARKET_END_EVENTS.has(event)) {
        endOperationWindow()
        continue
      }
      if (MARKET_START_EVENTS.has(event)) {
        void activate(`market:${event}`)
        break
      }
    }
  }

  /** Official plugin manager: first output chunk of each pnpm job. */
  const seenJobs = new Set()
  function handleInstallLog(chunk) {
    if (state.disposed || chunk === null || typeof chunk !== 'object') return
    touch('plugin-manager/install-log')
    const jobId = typeof chunk.jobId === 'string' ? chunk.jobId : ''
    if (jobId === '' || seenJobs.has(jobId)) return
    seenJobs.add(jobId)
    if (seenJobs.size > 500) {
      const oldest = seenJobs.values().next().value
      if (oldest !== undefined) seenJobs.delete(oldest)
    }
    const argv = Array.isArray(chunk.argv) ? chunk.argv : []
    const isPnpm = argv.some((item) => typeof item === 'string' && /pnpm/i.test(item))
    if (isPnpm) void activate('plugin-manager/install-log')
  }

  /** Official plugin manager: `installing` is announced before pnpm starts. */
  function handleInstallState(progress) {
    if (state.disposed || progress === null || typeof progress !== 'object') return
    if (progress.phase === 'installing') void activate('plugin-manager/install-state')
  }

  /** Official plugin manager: the operation settled; stop sweeping soon. */
  function handleChanged() {
    if (state.disposed) return
    endOperationWindow()
  }

  /**
   * The calling session's directory, when the Host exposes the service.
   * @param {any} exec pending or finished tool call
   * @returns {string | undefined} absolute session directory
   */
  function sessionCwdOf(exec) {
    try {
      const service = ctx?.get?.('workingDirectory')
      const session = exec?.agent?.session
      if (service !== null && service !== undefined && typeof service.get === 'function' && session !== undefined) {
        const cwd = service.get(session)
        return typeof cwd === 'string' ? cwd : undefined
      }
    } catch {
      // An absent or refusing service only narrows the guard.
    }
    return undefined
  }

  /**
   * Waterfall listener: sweep before a shell command that runs pnpm, and refuse
   * a profile mutation inside a persistent shell, where no kill can help.
   * @param {any} exec pending tool call
   * @param {() => Promise<any>} next continue the dispatch
   * @returns {Promise<any>} the next decision
   */
  async function handlePreExecute(exec, next) {
    try {
      if (!state.disposed && exec !== null && typeof exec === 'object') {
        const name = typeof exec.name === 'string' ? exec.name.toLowerCase() : ''
        const command = extractCommand(exec.arguments)

        if (
          persistentToolNames.has(name) &&
          config.denyProfilePnpmInPersistentShell &&
          exec.signal?.aborted !== true &&
          isPnpmMutation(command, detector) &&
          isProfileMutation(command, exec.arguments, profileDir, sessionCwdOf(exec))
        ) {
          logLine({
            event: 'denied',
            trigger: `tool:${name}`,
            at: new Date(now()).toISOString(),
            command: command.slice(0, 240),
          })
          return { kind: 'deny', reason: PERSISTENT_SHELL_DENY_REASON }
        }

        if (
          !persistentToolNames.has(name) &&
          config.interceptShellTools &&
          toolNames.has(name) &&
          exec.signal?.aborted !== true &&
          isPnpmMutation(command, detector)
        ) {
          await activate(`tool:${name}`, { force: true, kind: 'tool', callId: exec.callId })
        }
      }
    } catch (error) {
      logLine({ event: 'intercept-error', at: new Date(now()).toISOString(), error: messageOf(error) })
    }
    return next()
  }

  /**
   * Waterfall listener: a shell call finished, so its tool window can close.
   * @param {any} exec finished tool call
   * @param {any} result normalized result
   * @param {() => Promise<any>} next continue the waterfall
   * @returns {Promise<any>} the next decision
   */
  async function handlePostExecute(exec, result, next) {
    try {
      if (!state.disposed && exec !== null && typeof exec === 'object') {
        const name = typeof exec.name === 'string' ? exec.name.toLowerCase() : ''
        if (toolNames.has(name)) endToolWindow(exec.callId)
      }
    } catch (error) {
      logLine({ event: 'post-execute-error', at: new Date(now()).toISOString(), error: messageOf(error) })
    }
    return next()
  }

  function prime() {
    primeOperationDirectories()
    primeMarketLog()
  }

  function dispose() {
    state.disposed = true
    state.inFlight = null
    state.toolWindows.clear()
  }

  return {
    state,
    paths: { operationDir, marketLogPath },
    activate,
    touch,
    tick,
    handleInstallLog,
    handleInstallState,
    handleChanged,
    handlePreExecute,
    handlePostExecute,
    prime,
    dispose,
  }
}

/**
 * Host plugin entry point.
 * @param {any} ctx cordis plugin context
 * @param {Record<string, unknown>} [rawConfig] Loader row config
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return
  const logger = safeLogger(ctx)
  if (process.platform !== 'win32') {
    logger.info('dsh-bash-watchdog is inert: it only guards Windows win-bash shells')
    return
  }

  const watchdog = createWatchdog({ ctx, config })
  watchdog.prime()

  ctx.on('plugin-manager/install-log', (chunk) => watchdog.handleInstallLog(chunk))
  ctx.on('plugin-manager/install-state', (progress) => watchdog.handleInstallState(progress))
  ctx.on('plugin-manager/changed', () => watchdog.handleChanged())
  ctx.on('tools/pre-execute', (exec, next) => watchdog.handlePreExecute(exec, next))
  ctx.on('tools/post-execute', (exec, result, next) => watchdog.handlePostExecute(exec, result, next))

  ctx.effect(() => {
    const timer = setInterval(() => {
      void watchdog.tick()
    }, config.watcherIntervalMs)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      watchdog.dispose()
    }
  }, `${PLUGIN_NAME}: pnpm mutation watchers`)

  // A directory/file notification beats the polling interval: the official
  // manager creates operation-* immediately before spawning pnpm, so every
  // hundred milliseconds saved here is a hundred milliseconds of rename
  // protection. Polling stays as the backstop for a watcher that cannot start.
  ctx.effect(() => {
    const watchers = []
    for (const target of [watchdog.paths.operationDir, watchdog.paths.marketLogPath]) {
      try {
        const handle = watch(target, { persistent: false }, () => {
          void watchdog.tick()
        })
        handle.on('error', () => {})
        watchers.push(handle)
      } catch {
        // Missing path or unsupported watcher: the polling tick still covers it.
      }
    }
    return () => {
      for (const handle of watchers) {
        try {
          handle.close()
        } catch {
          // already closed
        }
      }
    }
  }, `${PLUGIN_NAME}: pnpm mutation notifications`)

  logger.info(
    `${PLUGIN_NAME} armed: patterns=${JSON.stringify(config.bashPathPatterns)} profile=${resolveProfileDir(config)}`,
  )

  if (config.sweepOnStartup) void watchdog.activate('startup', { force: true })
}

/**
 * Default log path under DSH_HOME.
 * @param {ReturnType<typeof resolveConfig>} config effective config
 * @returns {string} absolute log file path
 */
function resolveLogPath(config) {
  if (config.logPath !== null) return config.logPath
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'logs', `${PLUGIN_NAME}.log`)
}

/**
 * Append one JSON line to the command log, rotating once past the cap.
 * @param {ReturnType<typeof resolveConfig>} config effective config
 * @param {Record<string, unknown>} record entry to append
 */
function writeLogRecord(config, record) {
  const file = resolveLogPath(config)
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file) && statSync(file).size > config.maxLogBytes) {
      renameSync(file, `${file}.1`)
    }
    appendFileSync(file, `${JSON.stringify(record)}\n`)
  } catch {
    // The guard's job is to kill shells; a read-only log must not stop it.
  }
}

/**
 * A Cordis logger, or a no-op stand-in when the context has none.
 * @param {any} ctx plugin context
 * @returns {{ info: Function, warn: Function }}
 */
function safeLogger(ctx) {
  try {
    const logger = ctx?.logger?.(PLUGIN_NAME)
    if (logger && typeof logger.info === 'function') return logger
  } catch {
    // fall through to the no-op logger
  }
  return { info: () => {}, warn: () => {} }
}

/**
 * String coercion for logs.
 * @param {unknown} error thrown value
 * @returns {string} message
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function normalizePatterns(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
  }
  return []
}

function normalizeToolNames(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

function clampNumber(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}
