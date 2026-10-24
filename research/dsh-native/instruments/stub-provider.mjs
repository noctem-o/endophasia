// Study instrument: deterministic stub provider (same technique as the upstream retry snapshot backend, MIT).
// The DSH runtime is real; only the model is replaced. First request fails with a retryable RATE_LIMIT, the second streams "STUB_OK".
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
class StubAdapter extends LlmAdapter {
  requests = 0
  policy = resolveRetryPolicy({ mode: 'normal', maxRetries: 1, retryableCodes: ['RATE_LIMIT'], backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'study-stub.retryPolicy')
  providerRetryPolicy() { return this.policy }
  async * stream() {
    this.requests++
    if (this.requests === 1) throw new LlmError('stub transient failure', 'RATE_LIMIT', { status: 429 })
    const text = 'STUB_OK'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export const name = 'endo-study-stub-provider'
export const inject = ['llm']
export function apply(ctx) { ctx.llm.registerAdapter(['deepseek-official'], new StubAdapter()) }
