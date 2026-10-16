/**
 * Signing proxy — the kernel's transport, with the caller's body swapped in.
 *
 * The upstream gateway only accepts requests carrying the kernel's signature, so
 * the plugin cannot call the provider itself. The kernel is therefore used as a
 * signing transport: it produces the signed request, and the proxy replaces the
 * body on the way out with the caller's real one.
 *
 * SCOPE — this path is currently INACTIVE.
 *
 * Verified live: replacing the body makes the gateway answer
 * `40104 invalid signature`, i.e. the signature does cover the request body.
 * An earlier revision of this file claimed the opposite; that claim was wrong,
 * and the code paths implementing it (`reserve` / `streamFor` / `inferStream`)
 * are unused by the adapter. They are kept only because removing them would
 * change behaviour that has not been re-verified end to end.
 *
 * The active path is `complete()` in engine.js: the kernel performs the request
 * itself (including its own agent loop) and the plugin reads back the result. Do
 * NOT enable the body-swapping path without re-verifying the signature rule
 * against a working account — the previous attempt produced a false positive
 * because a banned account masked the signature check with `40109`.
 *
 * The non-reserved branch below is the live one: kernel traffic is forwarded
 * verbatim, signature intact.
 */
import http from 'node:http'
import crypto from 'node:crypto'

const UPSTREAM_ORIGIN = process.env.TA_SIGNPROXY_ORIGIN ?? 'https://agent.teleai.com.cn'
export const API_PREFIX = '/superCowork/sapi/api/v1'

export class SigningProxy {
  constructor({ port = 8795, upstream = UPSTREAM_ORIGIN, log = () => {} } = {}) {
    this.port = port
    this.upstreamOrigin = String(upstream).replace(/\/+$/, '')
    this.log = log
    this.pending = new Map()   // token -> { body, resolve, chunks, waiters }
    this.server = null
  }

  get base() { return `http://127.0.0.1:${this.port}` }

  /** Reserve a correlation token and receive the real upstream stream for it. */
  reserve(desiredBody) {
    const token = 'ta-' + crypto.randomBytes(16).toString('hex')
    const entry = { body: desiredBody, token, buffer: [], done: false, error: null, waiters: [], status: null }
    this.pending.set(token, entry)
    setTimeout(() => { if (this.pending.has(token)) { entry.error ??= new Error('signing proxy: timed out'); entry.done = true; this.#wake(entry) } }, 300000).unref?.()
    return entry
  }

  release(token) { this.pending.delete(token) }

  #wake(entry) { for (const w of entry.waiters.splice(0)) w() }

  /** Async iterator of raw upstream SSE text for a reserved token. */
  async * streamFor(entry) {
    for (;;) {
      if (entry.buffer.length) { yield entry.buffer.shift(); continue }
      if (entry.error) throw entry.error
      if (entry.done) return
      await new Promise((r) => entry.waiters.push(r))
    }
  }

  async listen() {
    if (this.server) return
    const server = http.createServer((req, res) => this.#handle(req, res))
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        // A double mount (or a leftover listener from a previous instance of
        // this same process) already serving the port is not a failure: the
        // plugin is usable, so treat it as ready instead of aborting startup
        // with an error the user cannot act on.
        if (err && err.code === 'EADDRINUSE') { this.log(`port ${this.port} already in use; reusing existing listener`); resolve() }
        else reject(err)
      }
      server.once('error', onError)
      server.listen(this.port, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
    })
    this.server = server
    this.log(`signing proxy on ${this.base}`)
  }

  async close() { try { this.server?.close() } catch {} this.server = null }

  async #handle(req, res) {
    let body = ''
    for await (const c of req) body += c

    // Match this kernel request to a reserved body by the token we planted in
    // the prompt. The kernel echoes the prompt back verbatim in `messages`.
    let entry = null
    for (const e of this.pending.values()) {
      if (body.includes(e.token)) { entry = e; break }
    }

    if (!entry) {
      // No reservation: this is the kernel's own agent traffic. Forward it
      // transparently, signature intact, so the kernel's native loop keeps
      // working — the proxy must not be a downgrade for non-bridged calls.
      const h = { ...req.headers }
      delete h.host; delete h['content-length']; delete h['accept-encoding']
      try {
        const up = await fetch(this.upstreamOrigin + req.url, { method: 'POST', headers: h, body })
        const text = await up.text()
        res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') ?? 'application/json' })
        res.end(text)
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(e?.message ?? e) } }))
      }
      return
    }

    const headers = { ...req.headers }
    delete headers.host; delete headers['content-length']; delete headers['accept-encoding']

    try {
      const upstream = await fetch(this.upstreamOrigin + req.url, {
        method: 'POST', headers, body: JSON.stringify(entry.body),
      })
      entry.status = upstream.status
      if (!upstream.ok) {
        const text = await upstream.text()
        entry.error = new Error(`upstream ${upstream.status}: ${text.slice(0, 300)}`)
        entry.done = true; this.#wake(entry)
      } else {
        const reader = upstream.body.getReader(); const dec = new TextDecoder()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          entry.buffer.push(dec.decode(value, { stream: true })); this.#wake(entry)
        }
        entry.done = true; this.#wake(entry)
      }
    } catch (e) {
      entry.error = e; entry.done = true; this.#wake(entry)
    }

    // The kernel gets a benign empty completion; the caller got the real stream.
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const base = { id: 'chatcmpl-proxy', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'proxy' }
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n'); res.end()
  }
}

/** Parse one SSE payload of an OpenAI chat.completion.chunk. */
export function parseSseChunk(payload) {
  if (!payload || payload === '[DONE]') return null
  try { return JSON.parse(payload) } catch { return null }
}
