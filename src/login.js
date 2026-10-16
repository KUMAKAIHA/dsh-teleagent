/**
 * Official sign-in flow.
 *
 * No credentials are harvested and no auth protocol is re-implemented: this
 * opens the real TeleAgent OAuth page in a system browser, and the user signs in
 * with their own phone number and SMS code on the provider's own page. We only
 * receive the callback the same way the desktop app does — by reading the
 * redirected URL, whose `token` parameter is the issued session token.
 *
 * Flow (identical to the app's login window):
 *   1. open  https://agent.teleai.com.cn/superCowork/sapi/cowork/auth
 *   2. user authenticates on the official page
 *   3. provider redirects to  .../cowork/auth?code=...&token=<session token>
 *   4. we capture `token` and hand it to the engine
 *
 * Step 3 needs a local listener to receive the redirect, because a plain
 * browser cannot hand a URL back to a CLI process.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const AUTH_URL = 'https://agent.teleai.com.cn/superCowork/sapi/cowork/auth'

/** Open a URL in the user's default browser without shell interpolation. */
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); return true } catch { return false }
}

/**
 * The provider only redirects to its own registered callback, so a local
 * listener cannot receive the token directly from the redirect. Instead the user
 * finishes on the official page and pastes the resulting URL (or just the token)
 * back to us. That is a copy of a value the user already legitimately holds —
 * we never see their phone number, password or SMS code.
 */
export function parseToken(input) {
  const s = String(input ?? '').trim()
  if (!s) return null
  try {
    const u = new URL(s)
    const t = u.searchParams.get('token')
    if (t) return t
    const c = u.searchParams.get('code')
    if (c && c.includes('.')) return c
  } catch {}
  // Accept a bare token (JWT with a tenant prefix, or a raw JWT).
  if (/^[A-Za-z0-9]{4,12}:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)) return s
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)) return s
  return null
}

export function decodeClaims(token) {
  try {
    const jwt = token.includes(':') ? token.split(':', 2)[1] : token
    const p = jwt.split('.')[1]
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch { return null }
}

/** Where the plugin keeps a token obtained through the official page. */
export function tokenPath() { return path.join(os.homedir(), '.dsh/teleagent/token.txt') }

export function saveToken(token) {
  const p = tokenPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, token, { mode: 0o600 })
  try { fs.chmodSync(p, 0o600) } catch {}
  return p
}

export function loadToken() {
  try { return fs.readFileSync(tokenPath(), 'utf8').trim() || null } catch { return null }
}

export function clearToken() {
  try { fs.unlinkSync(tokenPath()); return true } catch { return false }
}

/**
 * Local callback listener.
 *
 * The WEB flow accepts a caller-supplied redirect (`redirect_url`), which the
 * page forwards as `state` to the official callback endpoint. Pointing that at a
 * loopback address lets the issued token arrive here directly, so sign-in
 * completes without the user copying anything.
 *
 * Embedding the official page instead does NOT work: the page validates the
 * message origin against a whitelist (`teleai.com.cn`, `www.teleai.com.cn`,
 * `ai-pre.teleagi.cn`, `agent-pre.teleai.com.cn`) and silently drops the relay
 * from any other parent — which is why the embedded iframe only ever showed a
 * timeout regardless of `source`.
 */
export async function startCallbackListener({ port = 0, signal } = {}) {
  const http = await import('node:http')
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${server.address()?.port ?? 0}`)
      const token = u.searchParams.get('token')
      const code = u.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset="utf-8"><title>已完成</title>'
        + '<body style="font:14px -apple-system,sans-serif;padding:40px">登录已完成，可以关闭此页面并回到 DSH。</body>')
      if (token || code) {
        // Expose on the server object: the listener outlives this request, and
        // callers poll it rather than holding a promise open for minutes.
        server.token = token ?? code
        server.emit('token', server.token)
      }
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({ server, port: actual, close: () => server.close(), wait: null })
    })
    signal?.addEventListener('abort', () => { try { server.close() } catch {} }, { once: true })
  })
}

/**
 * Step 1 of the flow: send the user to the official page.
 *
 * `redirectUrl` uses the WEB flow, which is the only flow that honours a
 * caller-supplied redirect. Without it the page targets its own default and the
 * token never reaches us.
 */
export function startOfficialLogin(redirectUrl) {
  const url = loginPageUrl({ redirectUrl })
  return { url, opened: openBrowser(url) }
}

/**
 * The official login page relays its own redirect back to whoever embeds it.
 *
 * Verified in the shipped client: the page embeds a relay script that listens
 * for `{ type: 'loginRedirect', url }` from a nested frame and re-posts it to
 * `window.parent`. That is what lets the desktop app read the issued token
 * without the user doing anything — and it means an embedded iframe can receive
 * the token directly, with no copy/paste step.
 */
export const LOGIN_MESSAGE_TYPE = 'loginRedirect'

/**
 * Where sign-in actually starts.
 *
 * This is the *auth endpoint* `/superCowork/sapi/cowork/auth`, which answers 302
 * to the provider's unified sign-in page. The `/meter/teleagent-login/login` URL
 * is only the login SHELL that the desktop app embeds; pointing a browser at it
 * with an auth `source` does nothing useful — it tries to render an embedded
 * auth frame, suspends, and leaves a blank page (React error #426).
 *
 * Verified: the auth endpoint responds 302 to
 * `teleai.com.cn/aicloud-api/upms/public/auth/authorize?...`, which is the real
 * sign-in form.
 *
 *   source: DESKTOP = '01'   CLOUD_PC = '02'   WEB = '03'
 */
export const AUTH_ENDPOINT = 'https://agent.teleai.com.cn/superCowork/sapi/cowork/auth'

/** The app's embedded login shell. Kept for reference; not used to start sign-in. */
export const LOGIN_PAGE_URL = 'https://agent.teleai.com.cn/meter/teleagent-login/login'

/** `source` values accepted by the login page. */
export const LOGIN_SOURCE = { DESKTOP: '01', CLOUD_PC: '02', WEB: '03' }

/**
 * Build the login page URL.
 *
 * `redirectUrl` is only honoured by the WEB flow; passing it with DESKTOP
 * silently does nothing, and the token then goes to the desktop app instead of
 * back to us — which is why an earlier revision opened a page that could never
 * complete. `source` is therefore forced to WEB whenever a redirect is given.
 */
export function loginPageUrl({ tokenCode, source, redirectUrl } = {}) {
  const u = new URL(AUTH_ENDPOINT)
  u.searchParams.set('source', redirectUrl ? LOGIN_SOURCE.WEB : (source ?? LOGIN_SOURCE.DESKTOP))
  if (redirectUrl) u.searchParams.set('redirect_url', redirectUrl)
  if (tokenCode) u.searchParams.set('tokenCode', tokenCode)
  return u.toString()
}

export const LOGIN_URL = AUTH_URL
