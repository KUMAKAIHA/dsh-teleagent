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
  // Accept a bare token: `tenant:jwt`, a raw JWT, or an auth code.
  //
  // The callback normally carries only `code` (e.g. `ucc.<hex>`), never a token,
  // and the official client treats that code as the credential itself — it reads
  // `code` and passes it straight through. Rejecting it here made every real
  // sign-in look unparseable.
  if (/^[A-Za-z0-9]{4,12}:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)) return s
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)) return s
  if (/^[A-Za-z0-9]{1,16}\.[A-Za-z0-9_-]{16,}$/.test(s)) return s
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
 * Step 1 of the flow: send the user to the official page.
 *
 * `redirectUrl` uses the WEB flow, which is the only flow that honours a
 * caller-supplied redirect. Without it the page targets its own default and the
 * token never reaches us.
 */
/**
 * Build the start URL for sign-in.
 *
 * Deliberately does NOT open anything: the plugin opens its own window and reads
 * the navigation it performs. Opening a browser here as well produced two
 * windows side by side, and the browser one could never hand the credential back.
 * `openBrowser` remains exported for callers that genuinely want a browser.
 */
export function startOfficialLogin(redirectUrl) {
  return { url: loginPageUrl({ redirectUrl }) }
}

/** Open a URL in the user's default browser. Only for explicit browser flows. */
export function openInBrowser(url) {
  return openBrowser(url)
}

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

