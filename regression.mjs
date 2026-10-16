/**
 * Offline self-check. Makes no upstream requests and needs no credentials:
 * it only exercises the adapter contract and the request-building logic.
 *
 *   node regression.mjs
 */
const P = new URL('.', import.meta.url).pathname.replace(/\/$/, '')
const mod = await import(P + '/index.js')
const { TeleAgentAdapter } = await import(P + '/src/adapter.js')

// Config only exists when the harness peer dependency is resolvable; without it
// the plugin still loads, the settings form just is not declared.
if (typeof mod.Config === 'function') {
  console.log('1. config fields      :', Object.keys(mod.Config({})).join(', '))
} else {
  console.log('1. config fields      : (harness peer dependency absent — Config not built)')
}

const seen = {}
const ctx = {
  logger: { info: () => {} },
  fiber: { entry: { options: { id: 'teleagent' } } },
  llm: {
    registerAdapter: (r, a) => { seen.routes = r; seen.adapter = a; return { replace() {} } },
    registerConfigurableProviders: (l) => { seen.providers = l },
    registerModelDiscovery: (ns, fn) => { seen.discovery = fn },
  },
  effect: (fn) => { const d = fn(); return d },
  provide: (k, v) => { seen.control = v },
}
mod.apply(ctx, { autoStart: { get: () => false } })
console.log('2. routes registered  :', JSON.stringify(seen.routes))
console.log('3. control surface    :', Object.keys(seen.control).join(','))

const capture = {}
const engine = {
  start: async () => {},
  complete: async ({ agent, prompt }) => { capture.agent = agent; capture.prompt = prompt; return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
}
const drain = async (it) => { for await (const _ of it) {} }

const withTools = new TeleAgentAdapter({ engine, useTools: () => true })
await drain((await withTools.prepareCall('teleagent', 'chat-flagship')).stream({ messages: [{ role: 'user', content: 'hi' }] }))
console.log('4. tools ON  -> agent :', capture.agent)

const noTools = new TeleAgentAdapter({ engine, useTools: () => false })
await drain((await noTools.prepareCall('teleagent', 'chat-flash')).stream({ messages: [{ role: 'user', content: 'hi' }] }))
console.log('5. tools OFF -> agent :', capture.agent)

const models = await new TeleAgentAdapter({ engine }).listModels('teleagent')
console.log('6. tier list          :', models.map((m) => m.id).join(', '))

const { parseToken } = await import(P + '/src/login.js')
console.log('7. token parsing      :',
  parseToken('https://example/cb?token=AB12:aaa.bbb.ccc') === 'AB12:aaa.bbb.ccc' ? 'url OK' : 'url FAIL',
  '|', parseToken('garbage') === null ? 'reject OK' : 'reject FAIL')

// 8. Client half: actually render the settings section.
//
// The section crashed the whole slot with a ReferenceError (an identifier used
// before its declaration), which made the panel silently disappear in the GUI.
// A load-only check does not catch that, so the component is rendered here.
try {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const file = path.join(P, 'lib/client.js')
  let mod = null
  global.window = { __ModuleLoader__: { load: (m) => { mod = m } }, addEventListener: () => {}, removeEventListener: () => {} }
  const src = fs.readFileSync(file, 'utf8')
  // eslint-disable-next-line no-eval
  ;(0, eval)(src)
  const react = {
    createElement: (t, p, ...c) => (typeof t === 'function' ? { type: t, props: p } : { type: t, props: p, children: c }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: (fn) => { try { fn() } catch {} },
    useCallback: (fn) => fn,
  }
  const out = mod.factory((id) => (id === 'react' ? react : {}))
  let section = null
  out.apply({ slots: { inject: (n, gen) => { for (const _ of gen()) {} }, register: (a, b) => { section = b; return () => {} } } })
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return
    if (typeof node.type === 'function') { walk(node.type(node.props ?? {}), depth + 1); return }
    const kids = node.children ?? (node.props && node.props.children)
    for (const k of Array.isArray(kids) ? kids : [kids]) walk(k, depth + 1)
  }
  walk(section({}))
  console.log('8. client section    : renders OK')
} catch (e) {
  console.log('8. client section    : RENDER FAILED -', e.message)
  process.exitCode = 1
}

console.log('\nall offline checks done')
// The plugin installs a status interval; exit explicitly rather than waiting.
process.exit(0)
