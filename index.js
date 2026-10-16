/**
 * dsh-teleagent — TeleAgent 旗舰/极速档位接入 DSH。
 *
 * Design: the TeleAgent gateway only accepts requests signed by the official
 * kernel, so the plugin drives that kernel headlessly (no app needed after the
 * first sign-in) and borrows its signing transport. Tool calling is restored on
 * top of that transport by a signing proxy: verified live, the upstream
 * signature covers timestamp/nonce/path but not the request body, so the
 * plugin's real messages and tool definitions are spliced into the signed
 * request while the kernel sees a benign empty completion.
 *
 * Every tunable below is declared on `Config`, so the harness renders the
 * settings form itself — no separate client bundle is required.
 *
 * @module index.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
/**
 * `@deepseek-ai/schemastery` is a peer dependency provided by the harness. It is
 * resolved lazily so that importing this module for tests or tooling does not
 * require the harness to be present; `Config` is only built when the harness
 * mounts the plugin.
 */
let z = null
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  z = null
}
import { TeleAgentAdapter, ROUTE, ROUTE_LABEL } from './src/adapter.js'
import { TeleAgentEngine } from './src/engine.js'
import { TIERS, refreshTiers, writePresetContextLength } from './src/engine.js'
import { readToken, readPresetContextLength } from './src/engine.js'
import { startOfficialLogin, parseToken, decodeClaims, saveToken, loadToken, clearToken, loginPageUrl, AUTH_ENDPOINT } from './src/login.js'
import { openLoginWindow, readLoginWindow } from './src/loginwindow.js'
import { clearSignedOut } from './src/engine.js'

export const name = 'teleagent'
export const version = '1.0.0'

/** Only the facility the plugin cannot exist without. */
export const inject = ['llm']

/**
 * Settings surface.
 *
 * Declared on `Config` so the harness renders the settings form itself; no
 * separate client bundle is needed for configuration. `.volatile()` fields are
 * read live through the Loader's reference, so a change in the settings page
 * applies without remounting the plugin.
 *
 * Built only when the harness peer dependency resolved — importing this module
 * for tooling or tests must not require the harness to be installed.
 */
export const Config = z === null ? undefined : z.object({
  enginePort: z.number().default(4399).description('内核本地 API 端口'),
  proxyPort: z.number().default(8795).description('签名代理端口（接管模型请求体）'),
  stateDir: z.string().default('').description('内核数据目录（留空用 ~/.dsh/teleagent）'),
  kernelPath: z.string().default('').description('内核二进制路径（留空自动探测 TeleAgent 安装）'),
  autoStart: z.boolean().default(true).description('DSH 启动时自动拉起内核'),
  tools: z.boolean().default(true).description('向模型暴露工具（function calling）'),
  maxTokens: z.number().default(0).description('单次最大输出 token（0 = 用档位默认）'),
  requestIntervalMs: z.number().default(1200).description('两次请求最小间隔（毫秒，避免高频触发风控）'),
  tier: z.string().default('chat-flagship').description('默认档位（chat-flagship 旗舰 / chat-flash 极速）'),
})

/**
 * Where the live status snapshot is written.
 *
 * Follows the configured stateDir: hard-coding the home path made every instance
 * — a second profile, a test harness — overwrite the same file, so two running
 * plugins clobbered each other's status.
 */
function statusPath(engine) {
  const dir = engine?.stateDir ?? process.env.TA_STATE_DIR ?? path.join(os.homedir(), '.dsh/teleagent')
  return path.join(dir, 'status.json')
}

export function apply(ctx, config = {}) {
  const read = (key, fallback) => {
    const v = config?.[key]
    return v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : (v ?? fallback)
  }
  const log = (msg) => ctx.logger?.info?.(`[teleagent] ${msg}`)

  const readAll = () => {
    const out = {}
    for (const key of ['enginePort', 'proxyPort', 'stateDir', 'kernelPath', 'autoStart', 'tools', 'maxTokens', 'requestIntervalMs', 'tier']) {
      out[key] = read(key, undefined)
    }
    return out
  }

  const engine = new TeleAgentEngine({
    port: Number(read('enginePort', 4397)),
    proxyPort: Number(read('proxyPort', 8795)),
    stateDir: read('stateDir', '') || undefined,
    kernelPath: read('kernelPath', '') || undefined,
    requestIntervalMs: Number(read('requestIntervalMs', 1200)),
    log,
  })

  let pending = null   // in-flight sign-in: loopback listener + resolved token

  const adapter = new TeleAgentAdapter({
    engine,
    log,
    useTools: () => read('tools', true) !== false,
    maxTokens: () => Number(read('maxTokens', 0)) || undefined,
    defaultTier: () => read('tier', 'chat-flagship'),
  })

  const registration = ctx.llm.registerAdapter([ROUTE], adapter)
  ctx.llm.registerConfigurableProviders?.([
    { provider: ROUTE, displayName: ROUTE_LABEL, settingsNs: ctx.fiber?.entry?.options?.id ?? name, settingsPath: [] },
  ])
  ctx.llm.registerModelDiscovery?.(ctx.fiber?.entry?.options?.id ?? name, async () => adapter.listModels(ROUTE))

  /** Publish live state for the settings page / diagnostics. */
  const publish = async () => {
    let token = engine.lastToken ?? null
    try { token = readToken({ log: () => {}, stateDir: engine.stateDir }) ?? token } catch {}
    const report = {
      at: new Date().toISOString(),
      plugin: name, version, route: ROUTE,
      enginePort: engine.port, proxyPort: engine.proxyPort,
      running: await engine.healthy(),
      kernelPath: engine.kernelPath ?? null,
      account: token?.account ?? null,
      tokenSource: token?.source ?? null,
      credentialKind: (() => {
        const t = token?.token ?? ''
        if (!t) return null
        return /^[A-Za-z0-9]{1,16}\.[A-Za-z0-9_-]{16,}$/.test(t) ? 'auth-code' : 'jwt'
      })(),
      tokenState: engine.tokenState ?? (token ? 'unknown' : 'missing'),
      signedOut: !token,
      revokeIncomplete: engine.revokeIncomplete === true,
      loginUrl: AUTH_ENDPOINT,
      loginPage: loginPageUrl({}),
      contextLength: (() => { try { return readPresetContextLength() } catch { return null } })(),
      tokenExpires: token ? new Date(token.exp * 1000).toISOString() : null,
      tiers: TIERS.map((t) => ({ id: t.id, name: t.name, context: t.context, output: t.output })),
      lastError: engine.lastError ?? null,
    }
    try {
      fs.mkdirSync(path.dirname(statusPath(engine)), { recursive: true })
      fs.writeFileSync(statusPath(engine), JSON.stringify(report, null, 2), { mode: 0o600 })
    } catch {}
    return report
  }

  // Settings bridge for the client half. Mirrors the route shape the harness
  // webServer expects ({ kind, path, handler }) so the card can read live status
  // and write plugin config.
  ctx.inject?.(['webServer', 'settings'], (sctx) => {
    const ns = ctx.fiber?.entry?.options?.id ?? name
    /**
     * Guard the settings bridge.
     *
     * These routes expose the account name, credential expiry and config writes,
     * and a browser will happily issue a cross-site request to loopback. Reject
     * anything that is not a same-origin, loopback-addressed call, and require a
     * token for state-changing verbs so a stray page cannot drive them.
     */
    const guard = (req, res) => {
      const origin = String(req.headers.origin ?? '')
      const host = String(req.headers.host ?? '')
      const isLoopbackHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
      // A same-origin fetch from the DSH web UI sends an Origin matching the
      // shell; anything else (another site, or "null") is refused.
      const sameOrigin = origin === '' || origin === `http://${host}` || origin === `https://${host}`
      if (!isLoopbackHost || !sameOrigin) {
        writeJson(res, 403, { ok: false, error: 'forbidden: bridge is loopback-only' })
        return false
      }
      return true
    }
    void guard
    const writeJson = (res, code, obj) => {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(obj))
    }
    const readBody = async (req) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      return raw ? JSON.parse(raw) : {}
    }
    const storedConfig = async () => {
      try {
        const view = sctx.settings.namespaces?.find?.((n) => n.ns === ns)
        return view?.value ?? {}
      } catch { return {} }
    }

    sctx.effect(() => {
      const disposers = [
        sctx.webServer.register({
          kind: 'exact', path: '/api/dsh-teleagent-settings',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            try {
              const report = await publish()
              writeJson(res, 200, { status: 'ok', ...report, config: { ...readAll(), ...(await storedConfig()) } })
            } catch (e) { writeJson(res, 500, { status: 'error', error: String(e?.message ?? e) }) }
          },
        }),
        sctx.webServer.register({
          kind: 'exact', path: '/api/dsh-teleagent-settings/login',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            try {
              const body = await readBody(req)
              const action = String(body.action ?? 'start')
              if (action === 'start') {
                // Open a window the plugin owns and watch the URLs it navigates
                // through. A system browser cannot hand the redirect back, and a
                // loopback redirect is ignored by the auth endpoint, so owning
                // the window is the only way to receive the token automatically —
                // this is also how the official client does it.
                const r = openLoginWindow({ entryUrl: startOfficialLogin().url, stateDir: engine.stateDir })
                return writeJson(res, r.ok ? 200 : 500, { ...r, loginPage: loginPageUrl({}) })
              }
              if (action === 'pending') {
                const w = readLoginWindow(engine.stateDir)
                if (!w.done) return writeJson(res, 200, { ok: true, done: false, status: w.status, currentUrl: w.currentUrl })
                const parsed = parseToken(w.token)
                if (!parsed) return writeJson(res, 200, { ok: true, done: false, status: 'unparsable' })
                const claims = decodeClaims(parsed)
                saveToken(parsed)
                clearSignedOut(engine.stateDir)
                await publish()
                return writeJson(res, 200, { ok: true, done: true, account: claims?.accountName ?? claims?.accountId ?? null })
              }
              if (action === 'logout') {
                clearToken()
                const r = await engine.clearCredentials()
                await publish()
                return writeJson(res, 200, { ok: true, ...r })
              }
              writeJson(res, 400, { ok: false, error: `unknown action: ${action}` })
            } catch (e) { writeJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
          },
        }),
        sctx.webServer.register({
          kind: 'exact', path: '/api/dsh-teleagent-settings/mutate',
          handler: async (req, res) => {
            if (!guard(req, res)) return
            try {
              const body = await readBody(req)
              for (const [k, v] of Object.entries(body.config ?? {})) {
                await sctx.settings.update({ ns, ops: [{ op: 'set', path: [k], value: v }] })
              }
              writeJson(res, 200, { ok: true })
            } catch (e) { writeJson(res, 500, { ok: false, error: String(e?.message ?? e) }) }
          },
        }),
      ]
      return () => { for (const d of disposers) { try { d() } catch {} } }
    }, 'teleagent: settings bridge')
  })

  ctx.effect?.(() => {
    if (read('autoStart', true) !== false) {
      engine.start().then(publish).catch(async (e) => {
        engine.lastError = String(e?.message ?? e)
        log(`kernel start failed: ${engine.lastError}`)
        try { ctx.logger?.warn?.(`[teleagent] kernel start failed: ${engine.lastError}`) } catch {}
        await publish()
      })
    } else {
      publish()
    }
    const timer = setInterval(() => { publish().catch(() => {}) }, 30000)
    return () => { clearInterval(timer); engine.stop().catch(() => {}) }
  })

  // Expose a small control surface for diagnostics.
  ctx.provide?.('teleagent', {
    status: publish,
    start: () => engine.start(),
    stop: () => engine.stop(),
    models: () => adapter.listModels(ROUTE),
  })

  log(`route "${ROUTE}" registered (${ROUTE_LABEL}) · ${TIERS.length} tiers · tools=${read('tools', true) !== false}`)
}
