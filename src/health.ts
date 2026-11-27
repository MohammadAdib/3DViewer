// Main-thread side of the mesh doctor: collects triangles, talks to repair.worker, builds the repaired model.
import * as THREE from 'three'
import type { LoadedModel } from './loaders'
import { DEFAULT_COLOR, extOf } from './loaders'
import type { MeshTask, MeshTaskResult } from './repair.worker'
import type { IssueOverlay, MeshReport, RepairOptions } from './meshfix'

export type { IssueOverlay, MeshReport, RepairOptions }
export { DEFAULT_REPAIR } from './meshfix'

/** Formats people 3D-print from – these get checked automatically on open. */
export const PRINT_FORMATS = new Set(['stl', '3mf', 'obj', 'ply', 'amf'])
export const MAX_TRIANGLES = 8_000_000

/** All triangles of the model as a flat soup, in the model object's own coordinate frame. */
export function gatherTriangles(root: THREE.Object3D): Float32Array {
  root.updateMatrixWorld(true)
  const toRoot = root.matrixWorld.clone().invert()
  const meshes: [THREE.Mesh, THREE.Matrix4][] = []
  let total = 0
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || o.userData.isOverlay || !m.geometry.attributes.position) return
    meshes.push([m, toRoot.clone().multiply(m.matrixWorld)])
    total += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count
  })
  const out = new Float32Array(total * 3 - ((total * 3) % 9))
  const v = new THREE.Vector3()
  let o = 0
  for (const [m, mat] of meshes) {
    const pos = m.geometry.attributes.position
    const idx = m.geometry.index
    const n = idx ? idx.count : pos.count
    for (let i = 0; i + 2 < n && o < out.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k).applyMatrix4(mat)
        out[o++] = v.x
        out[o++] = v.y
        out[o++] = v.z
      }
    }
  }
  return out.length === o ? out : out.slice(0, o)
}

let worker: Worker | null = null
let nextId = 0

type Done<K extends MeshTask['op']> = Extract<MeshTaskResult, { ok: true; op: K }>
type Task = { op: 'analyze'; soup: Float32Array } | { op: 'repair'; soup: Float32Array; options: RepairOptions }

export const analyzeMesh = (soup: Float32Array) => run({ op: 'analyze', soup }) as Promise<Done<'analyze'>>
export const repairMesh = (soup: Float32Array, options: RepairOptions, onProgress: (msg: string, pct: number) => void) =>
  run({ op: 'repair', soup, options }, onProgress) as Promise<Done<'repair'>>

/** Runs a task on the mesh worker. Starting a new task cancels (terminates) any running one. */
function run(task: Task, onProgress: (msg: string, pct: number) => void = () => {}): Promise<MeshTaskResult> {
  if (busy) {
    // the previous model's analysis is stale – don't wait for it
    worker?.terminate()
    worker = null
    busy()
  }
  worker ??= new Worker(new URL('./repair.worker.ts', import.meta.url), { type: 'module' })
  const w = worker
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const finish = () => {
      busy = null
      w.removeEventListener('message', onMsg)
      w.removeEventListener('error', onErr)
    }
    busy = () => {
      finish()
      reject(new DOMException('Superseded', 'AbortError'))
    }
    const onMsg = (e: MessageEvent<MeshTaskResult>) => {
      const m = e.data
      if (m.id !== id) return
      if ('progress' in m) return onProgress(m.progress, m.pct)
      finish()
      if (m.ok) resolve(m)
      else reject(new Error(m.error))
    }
    const onErr = (e: ErrorEvent) => {
      finish()
      worker = null
      w.terminate()
      reject(new Error(e.message || 'Mesh worker crashed (model may be too large).'))
    }
    w.addEventListener('message', onMsg)
    w.addEventListener('error', onErr)
    w.postMessage({ ...task, id } satisfies MeshTask, [task.soup.buffer])
  })
}
let busy: (() => void) | null = null

/** Problems worth fixing before printing (degenerate slivers alone are harmless). */
export function issueCount(r: MeshReport) {
  return (
    (r.nakedEdges ? 1 : 0) +
    (r.nonManifoldEdges ? 1 : 0) +
    (r.invertedNormals ? 1 : 0) +
    (r.duplicateFaces ? 1 : 0) +
    (r.fragments ? 1 : 0)
  )
}

/** A single-mesh model built from the repaired triangles, placed exactly where the original was. */
export function repairedModel(original: LoadedModel, positions: Float32Array, index: Uint32Array): LoadedModel {
  let g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  // faceted like STL so edges stay crisp
  g = g.toNonIndexed()
  g.computeVertexNormals()
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: DEFAULT_COLOR, metalness: 0.1, roughness: 0.5 }))
  const src = original.object
  src.updateMatrix()
  src.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale)
  const base = original.name.replace(/(_repaired)?\.[^.]+$/, '')
  mesh.name = `${base}_repaired`
  const ext = extOf(original.name)
  return { ...original, object: mesh, name: `${base}_repaired.${ext}`, animations: [], bytes: 0 }
}
