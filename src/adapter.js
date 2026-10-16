/**
 * DSH LLM adapter for the TeleAgent tier models.
 *
 * Satisfies the harness adapter contract structurally (`registerAdapter`
 * validates by calling the methods, not by an `instanceof` test), so it does
 * not import a version-pinned adapter base class.
 *
 * Chunk protocol (harness StreamChunk):
 *   { type: 'block-start', index, blockType }
 *   { type: 'text-delta', index, text }
 *   { type: 'reasoning-delta', index, text }
 *   { type: 'block-end', index, block: { type:'text'|'reasoning', text } }
 *   { type: 'usage', usage }
 *   { type: 'finish', reason: { kind: 'stop'|'max-tokens'|'tool-calls'|'error'|'aborted', failure? } }
 *
 * Correctness note: the kernel's `message.part.delta` frames are lossy (measured
 * live: empty or truncated on most turns), while `message.part.updated` carries
 * the complete accumulated text for each part. Deltas are therefore derived by
 * diffing successive accumulated snapshots, which is both identical to the final
 * message and genuinely incremental.
 */
import { TIERS } from './engine.js'
import { parseSseChunk } from './signproxy.js'

export const ROUTE = 'teleagent'
export const ROUTE_LABEL = 'TeleAgent'

const tierOf = (id) => TIERS.find((t) => t.id === id)
const bare = (model) => String(model ?? '').replace(/^NewApi\//, '').replace(/^teleagent\//, '')


/** Map DSH tool definitions to the OpenAI wire shape the upstream expects. */
function toWireTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name ?? t.function?.name,
      description: t.description ?? t.function?.description ?? '',
      parameters: t.parameters ?? t.inputSchema ?? t.function?.parameters ?? { type: 'object', properties: {} },
    },
  })).filter((t) => typeof t.function.name === 'string' && t.function.name !== '')
}

/** DSH messages -> OpenAI wire messages (tool calls and results preserved). */
function toWireMessages(options) {
  const out = []
  if (options.system) out.push({ role: 'system', content: String(options.system) })
  for (const m of options.messages ?? []) {
    const content = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('') : ''
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId ?? m.tool_call_id ?? '', content })
      continue
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      out.push({
        role: 'assistant', content: content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id ?? '', type: 'function',
          function: { name: c.name ?? c.function?.name ?? '', arguments: c.arguments ?? c.function?.arguments ?? '{}' },
        })),
      })
      continue
    }
    out.push({ role: m.role, content })
  }
  return out
}

export class TeleAgentAdapter {
  constructor({ engine, log = () => {}, useTools = () => true, maxTokens = () => undefined, defaultTier = () => 'chat-flagship' }) {
    this.engine = engine
    this.log = log
    this.useTools = useTools
    this.maxTokens = maxTokens
    this.defaultTier = defaultTier
  }

  providerInfo(provider) {
    return { id: provider, name: ROUTE_LABEL }
  }

  /**
   * A fully resolved policy, not a config fragment: the backoff scheduler reads
   * delay fields off the top level, so nesting them under `backoff` would make
   * every delay NaN and turn a transient failure into an aborted turn.
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
      initialDelayMs: 700,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    })
  }

  /** Must stay synchronous: the token meter resolves it with no I/O window. */
  imageRequestPricing() { return undefined }

  async listModels(provider) {
    return TIERS.map((t) => ({
      provider, id: t.id, name: t.name, description: t.description,
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider, model) {
    const t = tierOf(bare(model)) ?? tierOf(this.defaultTier()) ?? TIERS[0]
    return {
      provider, id: t.id, name: t.name, inputModalities: ['text'],
      context: { contextWindow: t.context },
      defaultMaxTokens: t.output,
    }
  }

  async prepareCall(provider, model) {
    const id = bare(model)
    return {
      model: await this.resolveModel(provider, id),
      stream: (options) => this.#stream(id, options),
    }
  }

  /**
   * Streaming completion.
   *
   * Tool calling is NOT implemented by injecting tool definitions into the
   * upstream request: verified live with a working account, the client signature
   * covers the request body (substituting it yields 40104 "invalid signature"),
   * so the signed call must be produced by the kernel itself. See the note at the
   * top of signproxy.js — the body-swapping path there predates this finding and
   * is inactive.
   *
   * Instead the kernel runs its own agent loop with its read-only tool set and
   * streams its progress back; this adapter re-emits that progress as harness
   * chunks. The user's tool definitions cannot be honoured (the model is never
   * told about them), which is why `capabilities.toolCall` is not advertised.
   */
  #stream(modelId, options) {
    const self = this
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    const queue = []
    let notify = null, finished = false
    const push = (c) => { queue.push(c); notify?.(); notify = null }

    // Flatten the conversation into one prompt; the kernel owns the loop.
    const prompt = toWireMessages(options)
      .map((m) => (m.role === 'assistant' ? `Assistant: ${m.content ?? ''}` : m.content ?? ''))
      .filter((t) => String(t).trim() !== '')
      .join('\n\n')

    ;(async () => {
      try {
        await self.engine.start()
        if (!prompt.trim()) {
          push({ type: 'finish', reason: { kind: 'error', failure: { message: 'empty prompt', code: 'EMPTY_PROMPT' } } })
          return
        }
        const textIndex = 0
        let started = false
        const result = await self.engine.complete({
          model: modelId,
          prompt,
          agent: self.useTools() ? 'dsh-tools' : 'dsh-bridge',
          signal: controller.signal,
          onDelta: (delta) => {
            if (!started) { push({ type: 'block-start', index: textIndex, blockType: 'text' }); started = true }
            push({ type: 'text-delta', index: textIndex, text: delta })
          },
        })
        if (!started && result.text) push({ type: 'block-start', index: textIndex, blockType: 'text' })
        if (result.text) push({ type: 'block-end', index: textIndex, block: { type: 'text', text: result.text } })
        if (result.usage) push({ type: 'usage', usage: result.usage })
        push({ type: 'finish', reason: { kind: controller.signal.aborted ? 'aborted' : 'stop' } })
      } catch (error) {
        const aborted = controller.signal.aborted
        push({ type: 'finish', reason: aborted
          ? { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } }
          : { kind: 'error', failure: { message: String(error?.message ?? error), code: 'TELEAGENT' } } })
      } finally {
        finished = true; notify?.(); notify = null
      }
    })()

    return {
      [Symbol.asyncIterator]() { return this },
      async next() {
        for (;;) {
          if (queue.length) return { value: queue.shift(), done: false }
          if (finished) return { value: undefined, done: true }
          await new Promise((r) => { notify = r })
        }
      },
      async return() {
        controller.abort(); options.signal?.removeEventListener('abort', onAbort)
        finished = true; notify?.(); notify = null
        return { value: undefined, done: true }
      },
      async throw(error) {
        controller.abort(error); options.signal?.removeEventListener('abort', onAbort)
        finished = true; notify?.(); notify = null
        throw error
      },
    }
  }

}
