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
    // Refuse to start while signed out. Spawning would re-inject the account's
    // token into a fresh kernel and rebuild session.key, quietly undoing the
    // sign-out the user asked for.
    if (isSignedOut(this.stateDir)) {
      this.tokenState = 'missing'
      this.log('signed out; not starting the kernel')
      return
    }

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
    // Do NOT clear the sign-out marker here.
    //
    // Spawning a kernel is not a sign-in: DSH restarts, autoStart and any other
    // call to start() all land here, and clearing the marker would silently
    // re-authenticate an account the user had signed out of — the panel would
    // show "signed in" again after a restart. The marker is cleared only by an
    // explicit sign-in (index.js, on a successful token submit).
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
    // Two stages, deliberately separated:
    //   1. decide *which* pids may be signalled (identity-checked)
    //   2. signal them, with self-protection on BOTH the SIGTERM and the SIGKILL
    //      pass
    //
    // Identity checking is not optional. The pid file outlives the kernel it
    // names — a kernel that exits on its own (DSH restart, crash) leaves the file
    // behind — and macOS reuses pids aggressively, so a stale file can name an
    // unrelated process. Killing that would be user-visible damage.
    const candidates = new Set()
    if (this.child?.pid) candidates.add(this.child.pid)
    try {
      const n = Number(fs.readFileSync(path.join(this.stateDir, 'kernel.pid'), 'utf8').trim())
      if (Number.isInteger(n) && n > 0) candidates.add(n)
    } catch {}
    const portPids = await this.#pidsOnPort()
    if (portPids === null) {
      // No port discovery available: revocation may be incomplete, because a
      // kernel we did not spawn and whose pid file is gone is only findable
      // through its listener. Recorded so the UI can say so rather than claim a
      // clean sign-out.
      this.revokeIncomplete = true
      this.log('warning: port lookup unavailable (lsof missing?); a kernel started outside this plugin may survive sign-out')
    } else {
      this.revokeIncomplete = false
      for (const pid of portPids) candidates.add(pid)
    }

    const targets = []
    for (const pid of candidates) {
      if (await this.#isSafelyOursKernel(pid)) targets.push(pid)
    }

    const self = new Set([process.pid, process.ppid].filter((n) => Number.isInteger(n)))
    const signal = (sig) => {
      let n = 0
      for (const pid of targets) {
        // Re-checked on both passes: the SIGKILL pass must never be able to
        // signal us even if the candidate set somehow contained our own pid.
        if (self.has(pid)) continue
        try { process.kill(pid, sig); n++ } catch {}
      }
      return n
    }

    const killed = signal('SIGTERM')
    this.child = null
    if (killed) {
      // The kernel shuts down gracefully, and its own ceiling is 5s (hertz logs
      // "wait at most num=5 seconds"; measured on its production log, 32% of
      // exits exceed 600ms and the p90 is 5001ms). A fixed short wait therefore
      // SIGKILLed roughly a third of real sign-outs mid-checkpoint. Poll instead:
      // return as soon as the processes are gone, and give a slow one its full
      // budget before escalating.
      await this.#waitForExit(targets.filter((pid) => !self.has(pid)), 5000, self)
      const survivors = targets.filter((pid) => {
        if (self.has(pid)) return false
        try { process.kill(pid, 0); return true } catch { return false }
      })
      for (const pid of survivors) {
        if (self.has(pid)) continue
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
    }

    // The file is now stale by definition: it named a pid we either killed or
    // refused to touch. Leaving it would re-arm the same hazard next time.
    try { fs.unlinkSync(path.join(this.stateDir, 'kernel.pid')) } catch {}
    this.log(`forceStop: signalled ${killed} kernel process(es) from ${candidates.size} candidate(s)`)
    return killed
  }

  /**
   * PIDs holding our engine port as a LISTEN socket.
   *
   * Resolves null when the lookup could not run at all (lsof absent), which is
   * kept distinct from [] ("ran, nothing listening") — the two mean different
   * things for revocation completeness.
   *
   * `-sTCP:LISTEN` is essential, not cosmetic: plain `lsof -ti:PORT` also lists
   * every process holding a *connection* to that port, including this plugin's
   * own long-lived /event subscription, and signalling those would kill DSH.
   *
   * Identity is deliberately not judged here; that happens once, in
   * #isSafelyOursKernel. Filtering by name at this stage would drop a
   * legitimately renamed kernel before it is ever considered.
   */
  async #pidsOnPort() {
    const { execFile } = await import('node:child_process')
    const out = await new Promise((resolve) => {
      execFile('lsof', ['-ti', `tcp:${this.port}`, '-sTCP:LISTEN'], { timeout: 4000 }, (err, stdout) => {
        if (err && /ENOENT/.test(String(err.code ?? err.message))) return resolve(null)
        resolve(err && !stdout ? '' : String(stdout))
      })
    })
    if (out === null) return null
    return out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  }

  /**
   * Resolve as soon as every pid is gone, or after the budget elapses.
   *
   * Polling rather than a fixed sleep keeps the common case fast (a kernel that
   * exits in ~50ms returns immediately) while still letting a slow graceful
   * shutdown finish instead of being killed mid-checkpoint.
   */
  async #waitForExit(pids, budgetMs, self) {
    const alive = (pid) => {
      if (self.has(pid)) return false
      try { process.kill(pid, 0); return true } catch { return false }
    }
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (!pids.some(alive)) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return !pids.some(alive)
  }

  /**
   * May we signal this pid?
   *
   * True only when the process is identifiably our kernel: either its command
   * name matches the kernel binary (or a user-configured kernelPath), or it holds
   * our engine port as a LISTEN socket. Anything else — including a pid whose
   * identity cannot be read at all — is refused, so a recycled pid is never
   * killed. Fail-closed on purpose.
   */
  async #isSafelyOursKernel(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    if (pid === process.pid || pid === process.ppid) return false

    const { execFile } = await import('node:child_process')
    const run = (cmd, args) => new Promise((resolve) => {
      execFile(cmd, args, { timeout: 4000 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)))
    })

    // Identity first, and fail-closed: an unreadable command name is a refusal,
    // never a pass. Both the port check and the name check below depend on this.
    const comm = (await run('ps', ['-o', 'comm=', '-p', String(pid)])).trim()
    if (!comm) return false

    // A name match is sufficient on its own: it covers the default kernel name
    // and a user-configured kernelPath, and it survives the kernel being on a
    // non-default port.
    const expected = this.kernelPath ? path.basename(this.kernelPath) : null
    if (expected && comm.includes(expected)) return true
    if (/TeleAgent/i.test(comm)) return true

    // Holding our port is NOT sufficient on its own. Treating it that way let any
    // process that happened to listen on enginePort be signalled — the same
    // class of harm as a stale pid file. It is corroborating evidence only: the
    // name must still match the kernel.
    return false
  }

  /** Clear credentials this plugin stored (official sign-in token + key cache). */
  async clearCredentials() {
    let cleared = 0
    // session.key must go too, not just the token: it is the local API signing
    // key, and while it remains on disk a freshly constructed engine can reload
    // it and keep minting valid HMACs against a kernel that survived the stop.
    for (const f of ['token.txt', 'provider-key.txt', 'session.key']) {
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

  /**
   * partID -> part type, read from the kernel's own database.
   *
   * The event stream's `message.part.delta` frames carry no type, and
   * `message.part.updated` is not always emitted (measured: zero such frames on
   * every live turn so far). Without a type map, reasoning deltas are
   * indistinguishable from answer deltas and leak into the visible response.
   *
   * The kernel persists parts to a local SQLite file, so the map is read from
   * there. Read-only, best-effort: on any failure the caller falls back to
   * treating everything as answer text.
   */
  async partTypeMap(sessionID) {
    try {
      const { execFile } = await import('node:child_process')
      const db = path.join(this.stateDir, 'data', 'teleagent.db')
      if (!fs.existsSync(db)) return null
      const out = await new Promise((resolve) => {
        execFile('sqlite3', ['-readonly', db,
          `select id, data from part where session_id='${String(sessionID).replace(/'/g, "''")}'`],
        { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)))
      })
      const map = new Map()
      for (const line of out.split('\n')) {
        if (!line) continue
        const sep = line.indexOf('|')
        if (sep < 0) continue
        const id = line.slice(0, sep)
        try {
          const type = JSON.parse(line.slice(sep + 1)).type
          if (type) map.set(id, type)
        } catch {}
      }
      return map.size ? map : null
    } catch { return null }
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

    this.partTypes = new Map()

    // The stream announces no types: `message.part.delta` carries only a partID
    // and `message.part.updated` is not emitted at all (measured). Parts are
    // persisted to the kernel's SQLite file instead, so types are read from
    // there — on demand, the first time a delta for an unknown part arrives.
    //
    // Reading once up-front is not enough: parts only exist after the request is
    // sent, so the map would be empty. Reading on every delta is wasteful, so we
    // resolve once and cache, then route unconditionally.
    let resolving = null
    const resolveTypes = () => {
      if (!resolving) {
        resolving = this.partTypeMap(sid)
          .then((m) => { if (m) for (const [k, v] of m) this.partTypes.set(k, v); return m })
          .catch(() => null)
      }
      return resolving
    }

    // Deltas for parts whose type is still unknown are held (briefly) rather than
    // emitted, because emitting a reasoning delta as answer text is the defect
    // this whole mechanism exists to prevent. Anything still held when the turn
    // ends is flushed as answer text so nothing is lost.
    const held = []
    let ready = false

    const emit = (kind, piece) => {
      if (kind === 'reasoning') reasoning += piece
      else { text += piece; onDelta?.(piece) }
    }

    const unsub = this.#subscribe(sid, (ev) => {
      const p = ev.properties ?? {}

      // Deltas are the primary source, and they ARE real streaming: measured on
      // live turns, tens of frames arrive within ~1.4s while `part.updated`
      // never carries text. An earlier revision trusted only `updated`, dropped
      // every chunk, and produced the "no answer, only thinking" symptom.
      if (ev.type === 'message.part.delta' && p.field === 'text') {
        const piece = p.delta ?? ''
        const kind = this.partTypes.get(p.partID)
        if (kind) { emit(kind, piece); return }
        if (ready) { emit('text', piece); return }
        // Unknown and not yet resolved: hold this piece and kick a resolution.
        held.push({ partID: p.partID, piece })
        resolveTypes().then(() => {
          if (!ready) {
            ready = true
            for (const h of held.splice(0)) emit(this.partTypes.get(h.partID) ?? 'text', h.piece)
          }
        })
        return
      }

      if (ev.type === 'message.part.updated' && p.part?.id) {
        this.partTypes.set(p.part.id, p.part.type)
        return
      }

      if (ev.type === 'session.status' && p.sessionID === sid && p.status?.type === 'idle') {
        ready = true
        for (const h of held.splice(0)) emit(this.partTypes.get(h.partID) ?? 'text', h.piece)
        done = true; settle()
      }
      if (ev.type === 'session.error' && p.sessionID === sid) {
        ready = true
        for (const h of held.splice(0)) emit(this.partTypes.get(h.partID) ?? 'text', h.piece)
        done = true; settle()
      }
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
