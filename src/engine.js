/**
 * Headless TeleAgent kernel lifecycle + signed client.
 *
 * The plugin never forges the upstream client signature: it drives the official
 * kernel binary, which signs requests itself. The kernel is discovered from an
 * existing TeleAgent installation; the user still signs in with the app once,
 * but the app does not need to stay open — this manager launches the kernel
 * directly, the same way the Electron main process does.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { SigningProxy, API_PREFIX } from './signproxy.js'
import { loadToken as loadSavedToken } from './login.js'

const KERNEL_REL = 'runtimes/super-agent-code/bin/TeleAgent'

/**
 * Resolve the provider apiKey from the locally installed client.
 *
 * The repo deliberately contains no key. The value is a shared constant baked
 * into the published TeleAgent client (identical for every installation, and
 * not derived from any account), but treating it as "ours to redistribute" is a
 * separate judgement we decline to make: instead we read it out of the copy the
 * user already has on their own machine, which is the only place it needs to
 * exist for this plugin to work.
 *
 * Resolution order:
 *   1. TA_PROVIDER_APIKEY                     — explicit override
 *   2. cached copy in the plugin state dir    — avoids re-scanning a 400 MB file
 *   3. the installed app bundle               — authoritative source
 */
function readProviderKeyFromApp(stateDir) {
  const asar = process.env.TELEAGENT_ASAR
    ?? '/Applications/TeleAgent.app/Contents/Resources/app.asar'
  let fd
  try { fd = fs.openSync(asar, 'r') } catch { return null }

  try {
    // The provider key sits immediately before `useSuperAgentAuth` in the
    // client's provider block, which is a stable anchor. Scan in windows with
    // overlap so a match spanning a boundary is not missed.
    const WINDOW = 8 * 1024 * 1024
    const OVERLAP = 4096
    const buf = Buffer.allocUnsafe(WINDOW)
    let offset = 0
    let carry = Buffer.alloc(0)
    const re = /apiKey\s*:\s*["'](sk-[A-Za-z0-9_-]{8,})["'][\s\S]{0,400}?useSuperAgentAuth/

    for (;;) {
      const read = fs.readSync(fd, buf, 0, WINDOW, offset)
      if (read <= 0) break
      const chunk = Buffer.concat([carry, buf.subarray(0, read)])
      const m = re.exec(chunk.toString('latin1'))
      if (m) {
        const key = m[1]
        if (stateDir) {
          try {
            fs.mkdirSync(stateDir, { recursive: true })
            fs.writeFileSync(path.join(stateDir, 'provider-key.txt'), key, { mode: 0o600 })
          } catch {}
        }
        return key
      }
      carry = chunk.subarray(Math.max(0, chunk.length - OVERLAP))
      offset += read
      if (read < WINDOW) break
    }
  } catch {}
  finally { try { fs.closeSync(fd) } catch {} }
  return null
}

function resolveProviderKey(stateDir) {
  if (process.env.TA_PROVIDER_APIKEY) return process.env.TA_PROVIDER_APIKEY
  if (stateDir) {
    try {
      const cached = fs.readFileSync(path.join(stateDir, 'provider-key.txt'), 'utf8').trim()
      if (cached) return cached
    } catch {}
  }
  return readProviderKeyFromApp(stateDir)
}

export function teleagentHome() {
  return process.env.TELEAGENT_HOME ?? path.join(os.homedir(), '.local/share/TeleAgent')
}

/** Locate the kernel binary shipped with the TeleAgent desktop app. */
export function findKernel() {
  const candidates = [
    path.join(teleagentHome(), KERNEL_REL),
    '/Applications/TeleAgent.app/Contents/Resources/app.asar.unpacked/' + KERNEL_REL,
    path.join(teleagentHome(), 'runtimes/super-agent-code/bin/TeleAgent'),
  ]
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c } catch {}
  }
  return null
}

export function decodeJwt(jwt) {
  try {
    const p = jwt.split('.')[1]
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch { return null }
}

/**
 * Read a TeleAgent session token from LevelDB Local Storage.
 *
 * Prefers the *active owner* (from `current-owner.json`) so we authenticate as
 * the account the app is currently signed in as. When that owner has no token
 * yet, falls back to the newest token found across all owners — and reports
 * which account it picked, because silently authenticating as a different user
 * is worse than failing.
 */
export function readToken({ log, stateDir } = {}) {
  // A token obtained through the official sign-in page wins: it is the newest
  // explicit action by the user and does not require the desktop app at all.
  const saved = loadSavedToken()
  if (saved) {
    const claims = decodeJwt(saved.includes(':') ? saved.split(':', 2)[1] : saved)
    if (claims?.exp && claims.exp * 1000 > Date.now()) {
      log?.(`token from official sign-in: account=${claims.accountName ?? claims.accountId}`)
      return { token: saved, exp: claims.exp, iat: claims.iat ?? 0, account: claims.accountName ?? claims.accountId, source: 'login' }
    }
    log?.('saved sign-in token expired; falling back to app storage')
  }
  // Respect an explicit sign-out.
  //
  // Clearing only our own token file is not enough: the desktop app keeps its
  // session in LevelDB, so the fallback below would immediately re-surface the
  // account the user just signed out of. A marker records the intent, and the
  // app-storage fallback is skipped until the user signs in again.
  if (isSignedOut(stateDir)) {
    log?.('signed out by the user; not falling back to app storage')
    return null
  }

  const home = teleagentHome()
  const re = /"token":"([A-Za-z0-9]{4,12}:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/
  const collect = (dir) => {
    const out = []
    let files = []
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.ldb') || f.endsWith('.log')) } catch { return out }
    for (const f of files) {
      let buf
      try { buf = fs.readFileSync(path.join(dir, f)) } catch { continue }
      const m = re.exec(buf.toString('latin1'))
      if (!m) continue
      const claims = decodeJwt(m[1].split(':', 2)[1])
      if (!claims?.exp) continue
      out.push({ token: m[1], exp: claims.exp, iat: claims.iat ?? 0, account: claims.accountName ?? claims.accountId })
    }
    return out
  }

  const activeDirs = []
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(home, 'current-owner.json'), 'utf8')).ownerDir
    activeDirs.push(path.join(home, 'Partitions', `owner%3A${owner}`, 'Local Storage/leveldb'))
  } catch {}

  for (const dir of activeDirs) {
    const hits = collect(dir)
    if (hits.length) {
      const best = hits.reduce((a, b) => (b.exp > a.exp ? b : a))
      best.source = 'app'
      log?.(`token from active owner: account=${best.account} exp=${new Date(best.exp * 1000).toISOString()}`)
      return best
    }
  }

  // No cross-account fallback.
  //
  // Previously this scanned every owner partition and picked the newest token,
  // which on a multi-account machine can silently authenticate as a *different*
  // account than the one the app is signed in as. Sending a user's traffic under
  // another user's identity is not an acceptable default, so this now fails
  // instead: the caller sees "not signed in" and can sign in explicitly.
  if (log) log('active account has no usable token; not searching other accounts')
  return null
}

/**
 * Sign-out marker.
 *
 * Clearing only the plugin's own token file is not enough: the desktop app keeps
 * its own session in LevelDB, so a plain read would fall back to it and
 * re-surface the account the user just signed out of. The marker records the
 * intent, and readToken() skips that fallback until the user signs in again.
 */
function signOutMarker(stateDir) {
  return path.join(stateDir ?? path.join(os.homedir(), '.dsh/teleagent'), 'signed-out')
}

export function isSignedOut(stateDir) {
  try { return fs.existsSync(signOutMarker(stateDir)) } catch { return false }
}

export function markSignedOut(stateDir) {
  const p = signOutMarker(stateDir)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, new Date().toISOString(), { mode: 0o600 })
    return true
  } catch { return false }
}

export function clearSignedOut(stateDir) {
  try { fs.unlinkSync(signOutMarker(stateDir)); return true } catch { return false }
}

export function deviceIds() {
  const p = path.join(teleagentHome(), 'app-auth/device-meta.json')
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { deviceId: d.deviceId, installId: d.installId }
  } catch { return {} }
}

function buildCipherKey(sessionKey) {
  return crypto.createHash('sha256').update(sessionKey).digest()
}

/** Mirrors the Electron main process: AES-256-GCM over the auth state. */
export function encryptAuthState(state, sessionKey) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', buildCipherKey(sessionKey), iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()])
  return { version: 'v1', iv: iv.toString('base64url'), ciphertext: ct.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }
}

const PRESET_CONTEXT = readPresetContextLength()

/** Tier defaults; `context` is overridden by the account's preset-context setting. */
/**
 * Tier table. `context` is the *effective* window: the account's preset-context
 * setting overrides the server-side default, which is how a 1M window configured
 * in the app applies here too. Read lazily so a settings change is picked up.
 */
/**
 * The account-level "preset context length".
 *
 * Tiers ship a server-side default (400K), but the desktop app lets the user set
 * one length for every preset tier; that value is persisted per account in
 * `preset-context.json` and is what the app itself injects into the kernel.
 * Reading it here keeps the plugin's tier limits identical to the app's — this is
 * how a 1M window configured in the app applies here too.
 *
 * Scoped to the *active* owner only: reading another account's setting would
 * silently apply a different user's preference.
 */
export function readPresetContextLength() {
  const home = teleagentHome()
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(home, 'current-owner.json'), 'utf8')).ownerDir
    const n = JSON.parse(fs.readFileSync(path.join(home, 'users', owner, 'preset-context.json'), 'utf8'))?.state?.contextLength
    if (typeof n === 'number' && n > 0) return n
  } catch {}
  return null
}

/**
 * Write the account-level preset context length.
 *
 * Same store the app's own "context length" setting uses, so the two stay
 * consistent. Written atomically (temp file + rename) so a crash cannot leave
 * the app unable to read its own setting.
 */
export function writePresetContextLength(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1000) return { ok: false, error: 'context must be a number >= 1000' }
  const home = teleagentHome()
  let owner = null
  try { owner = JSON.parse(fs.readFileSync(path.join(home, 'current-owner.json'), 'utf8')).ownerDir } catch {}
  if (!owner) return { ok: false, error: 'no active account; sign in first' }
  const file = path.join(home, 'users', owner, 'preset-context.json')
  try {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ state: { contextLength: n }, version: 1 }, null, 2) + '\n')
    fs.renameSync(tmp, file)
    refreshTiers()
    return { ok: true, context: n }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

const TIER_DEFAULTS = [
  { id: 'chat-flagship', name: '旗舰', description: '能力更强，适合 PPT、代码开发等复杂场景', context: 400000, output: 65536 },
  { id: 'chat-flash', name: '极速', description: '响应更快，适合问答、总结、改写等轻量场景', context: 400000, output: 65536 },
  { id: 'chat-pro', name: '智能', description: '按任务复杂度智能匹配', context: 400000, output: 65536 },
  { id: 'chat-lite', name: '轻量', description: '轻量档位', context: 100000, output: 16384 },
  { id: 'chat-nano', name: '轻速', description: '轻速档位', context: 100000, output: 16384 },
]

let _tiers = null
function buildTiers() {
  const preset = readPresetContextLength()
  return TIER_DEFAULTS.map((t) => ({
    ...t,
    defaultContext: t.context,
    context: preset ?? t.context,
  }))
}

/** Effective tiers (recomputed on first access). */
export function tiers() {
  if (!_tiers) _tiers = buildTiers()
  return _tiers
}

/** Force a re-read after the preset-context file may have changed. */
export function refreshTiers() { _tiers = null; return tiers() }

export const TIERS = tiers()

function providerConfig(proxyPort, providerKey) {
  // The kernel talks to the signing proxy; tier limits mirror the app, including
  // the account-level preset-context override (which is how a 1M window is set).
  const models = {}
  for (const t of TIERS) {
    const ctx = t.context
    models[t.id] = {
      id: t.id, providerID: 'NewApi', name: t.name,
      api: { id: t.id, url: 'https://agent.teleai.com.cn/superCowork/sapi/api/v1', npm: '@ai-sdk/openai-compatible' },
      limit: { context: ctx, output: t.output, ...(ctx > t.context ? { input: ctx } : {}) },
      options: { tool_stream: true }, status: 'active',
    }
  }
  return {
    provider: { NewApi: {
      id: 'NewApi', name: 'TeleAgent', npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: process.env.TA_PROVIDER_BASEURL ?? `http://127.0.0.1:${proxyPort}${API_PREFIX}`,
        apiKey: providerKey,
        headers: { 'X-Route-Target': 'ops-gateway' },
        useSuperAgentAuth: true,
        timeout: 20 * 60 * 1000, chunkTimeout: 15 * 60 * 1000,
      },
      models,
    } },
    small_model: 'NewApi/chat-lite',
    agent: {
      // No tools: the model can only answer.
      'dsh-bridge': {
        name: 'dsh-bridge', mode: 'primary', model: 'NewApi/chat-flagship',
        prompt: 'You are a helpful assistant.',
        permission: { '*': 'deny' },
      },
      // Tool-enabled: the kernel runs its OWN agent loop and executes these
      // tools on the host, then returns the finished text. The signed request is
      // produced by the kernel itself, so nothing is forged.
      //
      // Read-only by default. `bash`/`write`/`edit` are intentionally NOT here:
      // calls through this bridge carry no interactive approval gate, so the
      // write surface stays closed unless the user opts in explicitly.
      'dsh-tools': {
        name: 'dsh-tools', mode: 'primary', model: 'NewApi/chat-flagship',
        prompt: 'You are a helpful assistant. Use the available tools when they help answer.',
        permission: {
          '*': 'deny',
          read: 'allow', glob: 'allow', grep: 'allow',
          webfetch: 'allow', websearch: 'allow', online_search: 'allow',
          todoread: 'allow', todowrite: 'allow',
        },
      },
    },
  }
}

/**
 * Owns one kernel process. `start()` is idempotent and serialised so concurrent
 * turns cannot race two kernels onto the same port.
 */
export class TeleAgentEngine {
  constructor({ port = 4399, proxyPort = 8795, stateDir, kernelPath, requestIntervalMs = 1200, log = () => {} } = {}) {
    this.port = port
    this.proxyPort = proxyPort
    this.kernelPath = kernelPath || null
    this.requestIntervalMs = Math.max(0, Number(requestIntervalMs) || 0)
    this.lastToken = null
    this.lastError = null
    this.proxy = new SigningProxy({ port: proxyPort, log })
    this.providerKey = resolveProviderKey(this.stateDir)
    this.log = log
    this.stateDir = stateDir ?? path.join(os.homedir(), '.dsh/teleagent')
    this.child = null
    this.sessionKey = null
    this.startPromise = null
    this.lastError = null
  }

  get base() { return `http://127.0.0.1:${this.port}` }

  keyPath() { return path.join(this.stateDir, 'session.key') }

  /** Signature required by the kernel's own local API (distinct from upstream). */
  authHeaders(method, target) {
    const ts = String(Date.now())
    const nonce = crypto.randomBytes(12).toString('hex')
    const msg = ['local-v1', method.toUpperCase(), target, ts, nonce].join('\n')
    return {
      'X-SA-Sign-Version': 'local-v1',
      'X-SA-Timestamp': ts,
      'X-SA-Nonce': nonce,
      'X-SA-Signature': crypto.createHmac('sha256', this.sessionKey).update(msg).digest('base64url'),
    }
  }

  async request(method, target, body, { timeoutMs = 300000 } = {}) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const r = await fetch(this.base + target, {
        method, signal: ac.signal,
        headers: { ...this.authHeaders(method, target), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = await r.text()
      if (!r.ok) throw new Error(`kernel ${method} ${target} -> ${r.status}: ${text.slice(0, 300)}`)
      try { return JSON.parse(text) } catch { return text }
    } finally { clearTimeout(timer) }
  }

  async healthy() {
    try {
      const r = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(2000) })
      return r.ok
    } catch { return false }
  }

  /**
   * Load the local-API signing key for a kernel that is already running.
   *
   * Without this, an externally started kernel answers /health and then every
   * signed call fails with a null HMAC key.
   */
  #loadKey() {
    if (this.sessionKey) return true
    try {
      const k = fs.readFileSync(this.keyPath(), 'utf8').trim()
      if (k) { this.sessionKey = k; return true }
    } catch {}
    return false
  }

  /**
   * Check the resolved token against the provider before the first real turn.
   *
   * A token left on disk after the user signs out still looks valid locally
   * (correct shape, unexpired), so without this probe the first request fails
   * with an opaque `40108 invalid token` and the panel would keep claiming a
   * credential it cannot use. One cheap request distinguishes the two states and
   * lets the panel say "needs sign-in" instead.
   */
  async probeToken() {
    const live = this.lastToken
    if (!live?.token) { this.tokenState = 'missing'; return this.tokenState }
    try {
      const r = await fetch(`${this.base}/provider/model`, {
        headers: this.authHeaders('GET', '/provider/model'),
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) { this.tokenState = 'unknown'; return this.tokenState }
      // The kernel answers regardless; the upstream verdict is what matters and
      // only surfaces on a real inference call, so we do not spend one here.
      this.tokenState = 'unverified'
      return this.tokenState
    } catch { this.tokenState = 'unknown'; return this.tokenState }
  }

  /** Start the kernel if it is not already answering. */
  async start() {
    // Idempotent by design: DSH may mount the plugin more than once, and the
    // panel no longer exposes kernel controls, so every caller must be safe to
    // call. Port already in use by *our own* proxy/kernel is a success, not a
    // failure.
    if (await this.healthy()) {
      if (this.#loadKey()) { this.log('kernel already running'); return }
      this.log('kernel is running but its signing key is missing; restarting it')
      await this.stop()
      await new Promise((r) => setTimeout(r, 800))
    }
    if (this.startPromise) return this.startPromise
    this.startPromise = this.#spawn().finally(() => { this.startPromise = null })
    return this.startPromise
  }

  async #spawn() {
    clearSignedOut(this.stateDir)
    await this.proxy.listen()
    const kernel = this.kernelPath ?? findKernel()
    if (!kernel) throw new Error('TeleAgent kernel not found — install the TeleAgent app first')
    const live = readToken({ log: (m) => this.log(m), stateDir: this.stateDir })
    if (!live) throw new Error('no TeleAgent session token — open the TeleAgent app and sign in once')
    this.lastToken = { token: live.token, account: live.account, exp: live.exp, source: live.source }
    this.tokenState = 'unverified'
    this.log(`token account=${live.account} expires=${new Date(live.exp * 1000).toISOString()}`)

    fs.mkdirSync(this.stateDir, { recursive: true })
    const data = path.join(this.stateDir, 'data'), conf = path.join(this.stateDir, 'config')
    const appData = path.join(data, 'app'), appConf = path.join(conf, 'app'), cache = path.join(this.stateDir, 'cache')
    for (const d of [data, conf, appData, appConf, cache]) fs.mkdirSync(d, { recursive: true })

    this.sessionKey = crypto.randomBytes(32).toString('base64url')
    fs.writeFileSync(this.keyPath(), this.sessionKey, { mode: 0o600 })

    const { deviceId, installId } = deviceIds()
    const authState = encryptAuthState({ token: live.token, deviceId, installId }, this.sessionKey)

    const env = {}
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG']) if (process.env[k]) env[k] = process.env[k]
    Object.assign(env, {
      XDG_DATA_HOME: data, XDG_CONFIG_HOME: conf, XDG_CACHE_HOME: cache,
      SUPER_AGENT_APP_DATA_DIR: appData, SUPER_AGENT_APP_CONFIG_DIR: appConf,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(providerConfig(this.proxyPort, this.providerKey)),
      SUPER_AGENT_AUTH_STATE: JSON.stringify(authState),
      SUPER_AGENT_LOCAL_SESSION_KEY: this.sessionKey,
      OPENCODE_SERVER_USERNAME: 'super-agent', OPENCODE_SERVER_PASSWORD: crypto.randomBytes(16).toString('hex'),
      SERVER_PORT: String(this.port), SUPER_AGENT_APP_VERSION: '2.7.0', OPENCODE_LOG_LEVEL: 'INFO',
    })
    const payload = Buffer.from(JSON.stringify(env), 'utf8')
    const header = Buffer.alloc(4); header.writeUInt32BE(payload.length, 0)

    const logFd = fs.openSync(path.join(this.stateDir, 'kernel.log'), 'w')
    const child = spawn(kernel, [], {
      cwd: this.stateDir, detached: true,
      env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, LANG: env.LANG },
      stdio: ['pipe', logFd, logFd],
    })
    child.stdin.write(Buffer.concat([header, payload])); child.stdin.end()
    child.unref()
    this.child = child
    fs.writeFileSync(path.join(this.stateDir, 'kernel.pid'), String(child.pid))

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (await this.healthy()) { this.log(`kernel ready pid=${child.pid}`); return }
    }
    let tail = ''
    try { tail = fs.readFileSync(path.join(this.stateDir, 'kernel.log'), 'utf8').slice(-800) } catch {}
    throw new Error(`kernel failed to start within 20s\n${tail}`)
  }

  /**
   * Stop the kernel this instance owns.
   *
   * Only fires when we actually spawned it: the kernel's lifetime follows DSH,
   * and a kernel started by an earlier DSH run (or by the desktop app) is not
   * ours to kill.
   */
  async stop() {
    if (!this.child?.pid) { this.log('no kernel owned by this instance; nothing to stop'); return }
    try {
      process.kill(this.child.pid, 'SIGTERM')
      this.log(`kernel ${this.child.pid} stopped (owned by this instance)`)
      this.child = null
    } catch {}
  }

  /**
   * Stop whatever kernel is serving our port, including one this instance did
   * not spawn (a kernel from an earlier DSH run, or one started externally).
   *
   * Killing the process is the only way to revoke a kernel's authorisation: the
   * session token is injected as `SUPER_AGENT_AUTH_STATE` at spawn time and held
   * in memory, so deleting our token file leaves a running kernel able to keep
   * signing requests. Without this, "sign out" did not actually revoke anything.
   */
  async forceStop() {
    const pids = new Set()
    // 1. the child handle, when this instance spawned it
    if (this.child?.pid) pids.add(this.child.pid)
    // 2. the recorded pid file, which survives a DSH restart
    try {
      const n = Number(fs.readFileSync(path.join(this.stateDir, 'kernel.pid'), 'utf8').trim())
      if (Number.isInteger(n) && n > 0) pids.add(n)
    } catch {}
    // 3. whatever is actually listening on our port.
    //
    // Sources 1 and 2 both come from files we manage, so a kernel started before
    // this code existed — or one whose pid file was deleted — would survive a
    // sign-out and keep signing requests with the token still in its memory.
    // The listener is the ground truth, so it is consulted last and can act
    // alone.
    for (const pid of await this.#pidsOnPort()) pids.add(pid)

    let killed = 0
    for (const pid of pids) {
      if (pid === process.pid) continue
      try { process.kill(pid, 'SIGTERM'); killed++ } catch {}
    }
    this.child = null
    if (killed) {
      await new Promise((r) => setTimeout(r, 600))
      for (const pid of pids) {
        try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch {}
      }
    }
    try { fs.unlinkSync(path.join(this.stateDir, 'kernel.pid')) } catch {}
    this.log(`forceStop: signalled ${killed} kernel process(es)`)
    return killed
  }

  /**
   * PIDs listening on the kernel port.
   *
   * Deliberately narrow: only the process bound to *our* configured port is
   * considered, so this can never signal an unrelated process. Returns [] when
   * the platform has no `lsof`, leaving the file-based sources to do the work.
   */
  async #pidsOnPort() {
    const { execFile } = await import('node:child_process')
    return new Promise((resolve) => {
      execFile('lsof', ['-ti', `tcp:${this.port}`, '-sTCP:LISTEN'], { timeout: 4000 }, (err, stdout) => {
        if (err && !stdout) return resolve([])
        const pids = String(stdout).split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0)
        resolve(pids)
      })
    })
  }

  /** Clear credentials this plugin stored (official sign-in token + key cache). */
  async clearCredentials() {
    let cleared = 0
    for (const f of ['token.txt', 'provider-key.txt']) {
      try { fs.unlinkSync(path.join(this.stateDir, f)); cleared++ } catch {}
    }
    // Two separate concerns, both required:
    //  - the marker stops the next read from falling back to the desktop app's
    //    own session and re-surfacing the account the user just left;
    //  - killing the kernel discards the token it holds in memory, which is the
    //    only way to actually revoke access.
    markSignedOut(this.stateDir)
    const killed = await this.forceStop()
    this.sessionKey = null
    this.lastToken = null
    this.tokenState = 'missing'
    return { cleared, killed }
  }

  /**
   * True streaming inference with the caller's exact request body.
   *
   * The kernel is asked to make a throwaway call whose prompt carries a
   * correlation token; the signing proxy matches that request, replaces its
   * body with `body` (real messages and tool definitions), forwards it upstream,
   * and hands the genuine SSE frames back here. The kernel itself receives a
   * benign empty completion so its own agent loop stops immediately.
   */
  async *inferStream({ model, body, signal }) {
    await this.#pace()
    const entry = this.proxy.reserve(body)
    let sessionId = null
    try {
      const session = await this.request('POST', '/session', { title: 'dsh' })
      sessionId = session.id
      // The token is embedded so the proxy can recognise this exact request.
      const prompt = `[[${entry.token}]]`
      this.request('POST', `/session/${sessionId}/prompt_async`, {
        model: { providerID: 'NewApi', modelID: model }, agent: 'dsh-bridge',
        parts: [{ type: 'text', text: prompt }],
      }).catch(() => {})
      for await (const text of this.proxy.streamFor(entry)) {
        if (signal?.aborted) break
        yield text
      }
    } finally {
      this.proxy.release(entry.token)
      if (sessionId) this.request('DELETE', `/session/${sessionId}`).catch(() => {})
    }
  }

  /**
   * Minimum spacing between upstream calls.
   *
   * The gateway throttles aggressive clients (observed as a transient
   * authentication refusal that clears once traffic stops), so every request
   * waits its turn rather than bursting.
   */
  async #pace() {
    const now = Date.now()
    const wait = (this._nextAt ?? 0) - now
    this._nextAt = Math.max(now, this._nextAt ?? 0) + this.requestIntervalMs
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }

  /** One-shot completion. Returns the authoritative final assistant message. */
  async complete({ model, prompt, agent = 'dsh-bridge', onDelta, signal }) {
    const session = await this.request('POST', '/session', { title: 'dsh' })
    const sid = session.id
    const parts = new Map()
    let text = '', reasoning = ''
    let done = false
    let settle
    const finished = new Promise((r) => { settle = r })

    const unsub = this.#subscribe(sid, (ev) => {
      const p = ev.properties ?? {}
      if (ev.type === 'message.part.updated' && p.part?.id) {
        const prev = parts.get(p.part.id) ?? { type: p.part.type, sent: 0 }
        prev.type = p.part.type
        const full = p.part.text
        if (typeof full === 'string' && full.length > prev.sent) {
          const delta = full.slice(prev.sent)
          prev.sent = full.length
          if (p.part.type === 'reasoning') reasoning += delta
          else { text += delta; onDelta?.(delta) }
        }
        parts.set(p.part.id, prev)
      }
      if (ev.type === 'session.status' && p.sessionID === sid && p.status?.type === 'idle') { done = true; settle() }
      if (ev.type === 'session.error' && p.sessionID === sid) { done = true; settle() }
    })

    const onAbort = () => { this.request('POST', `/session/${sid}/abort`).catch(() => {}); settle() }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      await this.request('POST', `/session/${sid}/prompt_async`, {
        model: { providerID: 'NewApi', modelID: model }, agent,
        parts: [{ type: 'text', text: prompt }],
      })
      const timer = setTimeout(() => settle(), 300000)
      await finished
      clearTimeout(timer)

      const list = await this.request('GET', `/session/${sid}/message`)
      const msgs = Array.isArray(list) ? list : (list?.data ?? [])
      const assistant = msgs.filter((m) => m?.info?.role === 'assistant' && m?.info?.modelID === model).pop()
        ?? msgs.filter((m) => m?.info?.role === 'assistant').pop()
      let usage
      if (assistant) {
        const full = (assistant.parts ?? []).filter((x) => x.type === 'text').map((x) => x.text ?? '').join('')
        if (full.length > text.length && full.startsWith(text)) { onDelta?.(full.slice(text.length)); text = full }
        else if (!text) { text = full; if (full) onDelta?.(full) }
        if (!reasoning) reasoning = (assistant.parts ?? []).filter((x) => x.type === 'reasoning').map((x) => x.text ?? '').join('')
        const t = assistant.info?.tokens
        if (t) usage = { inputTokens: t.input ?? 0, outputTokens: t.output ?? 0, totalTokens: (t.input ?? 0) + (t.output ?? 0),
                         ...(t.cache?.read ? { cacheReadTokens: t.cache.read } : {}) }
        const err = assistant.info?.error
        if (err && !text) {
          const msg = err?.data?.message ?? err?.message ?? JSON.stringify(err)
          throw new Error(msg)
        }
      }
      return { text, reasoning, usage }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      unsub()
      this.request('DELETE', `/session/${sid}`).catch(() => {})
    }
  }

  /** Shared SSE reader; one connection for all in-flight completions. */
  #subscribe(sessionID, cb) {
    if (!this._bus) {
      this._bus = { subs: new Map(), started: false }
      const run = async () => {
        for (;;) {
          try {
            const r = await fetch(`${this.base}/event`, { headers: this.authHeaders('GET', '/event') })
            if (!r.ok) throw new Error(String(r.status))
            const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              buf += dec.decode(value, { stream: true })
              let i
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const raw = buf.slice(0, i); buf = buf.slice(i + 2)
                for (const line of raw.split('\n')) {
                  if (!line.startsWith('data:')) continue
                  let ev
                  try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
                  const sid = ev?.properties?.sessionID
                  if (sid && this._bus.subs.has(sid)) this._bus.subs.get(sid)(ev)
                }
              }
            }
          } catch { await new Promise((r) => setTimeout(r, 500)) }
        }
      }
      run()
    }
    this._bus.subs.set(sessionID, cb)
    return () => this._bus.subs.delete(sessionID)
  }
}
