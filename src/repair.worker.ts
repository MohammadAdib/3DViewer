/// <reference lib="webworker" />
// Mesh health check & repair, off the main thread.
import { analyze, repair } from './meshfix'
import type { IssueOverlay, MeshReport, RepairOptions } from './meshfix'

export type MeshTask =
  | { id: number; op: 'analyze'; soup: Float32Array }
  | { id: number; op: 'repair'; soup: Float32Array; options: RepairOptions }

export type MeshTaskResult =
  | { id: number; progress: string; pct: number }
  | { id: number; ok: true; op: 'analyze'; report: MeshReport; overlay: IssueOverlay; ms: number }
  | {
      id: number
      ok: true
      op: 'repair'
      before: MeshReport
      after: MeshReport
      positions: Float32Array
      index: Uint32Array
      overlay: IssueOverlay
      log: string[]
      ms: number
    }
  | { id: number; ok: false; error: string }

const post = (m: MeshTaskResult, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)
const buffers = (o: IssueOverlay) => [o.naked.buffer, o.nonManifold.buffer, o.inverted.buffer]

self.onmessage = (e: MessageEvent<MeshTask>) => {
  const task = e.data
  const t0 = performance.now()
  try {
    if (task.op === 'analyze') {
      const { report, overlay } = analyze(task.soup)
      post({ id: task.id, ok: true, op: 'analyze', report, overlay, ms: performance.now() - t0 }, buffers(overlay))
    } else {
      const r = repair(task.soup, task.options, (progress, pct = 0) => post({ id: task.id, progress, pct }))
      post(
        { id: task.id, ok: true, op: 'repair', ...r, ms: performance.now() - t0 },
        [r.positions.buffer, r.index.buffer, ...buffers(r.overlay)],
      )
    }
  } catch (err) {
    post({ id: task.id, ok: false, error: (err as Error).message || String(err) })
  }
}
