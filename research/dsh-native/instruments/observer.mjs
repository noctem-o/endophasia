// Study instrument (scratch, not shipped): a passive Cordis observer. It registers ONLY on emit-mode events (session/event,
// agent/status, agent/assistant-stream, agent/error); never on a waterfall hook and never on the awaited session/flush checkpoint.
import { appendFileSync } from 'node:fs'
export const name = 'endo-study-observer'
export const inject = []
export function apply(ctx) {
  const out = process.env.DSH_OBS_OUT
  const write = (record) => appendFileSync(out, JSON.stringify({ wall: Date.now(), ...record }) + '\n')
  ctx.on('session/event', (session, event) => write({ feed: 'session/event', sessionId: String(session.id), event }))
  ctx.on('agent/assistant-stream', ({ frame }) => write({ feed: 'agent/assistant-stream', kind: frame?.kind ?? frame?.type, keys: Object.keys(frame ?? {}) }))
  ctx.on('agent/error', ({ turn, step, error }) => write({ feed: 'agent/error', turn, step, error: String(error?.message ?? error) }))
  ctx.on('agent/status', ({ status }) => write({ feed: 'agent/status', status }))
}
