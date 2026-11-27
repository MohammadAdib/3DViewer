/**
 * Mesh health check & repair for printable triangle meshes (STL, 3MF, OBJ…).
 *
 * Pure, dependency-free functions so they run in a worker (repair.worker.ts) and under plain Node for testing.
 *
 * Analysis reports the same defects slicers and repair services flag: naked (boundary) edges, holes
 * (planar / non-planar), non-manifold edges, inverted normals, duplicate faces, degenerate faces and shells.
 *
 * Repair pipeline:
 *  1. weld coincident vertices (STL stores every triangle separately)
 *  2. fix degenerate faces: collapse micro-edges, split the neighbour of needle triangles (no new cracks)
 *  3. remove duplicate faces (coincident opposite pairs are internal walls → both go)
 *  4. orient every patch consistently, then point each shell outwards by ray parity (cavities respected)
 *  5. remove internal sheets hanging off non-manifold edges
 *  6. remove loose fragments
 *  7. fill holes (planar ear-clipping, minimum-area for warped holes)
 *  8. clean up any slivers the fill produced, then re-analyse the result
 */

export interface MeshReport {
  vertices: number
  triangles: number
  nakedEdges: number
  planarHoles: number
  nonPlanarHoles: number
  nonManifoldEdges: number
  invertedNormals: number
  duplicateFaces: number
  degenerateFaces: number
  shells: number
  fragments: number
  watertight: boolean
  /** Enclosed volume (model units³); only meaningful when watertight. */
  volume: number
  area: number
}

export interface IssueOverlay {
  /** xyz pairs, one segment per naked edge */
  naked: Float32Array
  /** xyz pairs, one segment per non-manifold edge */
  nonManifold: Float32Array
  /** xyz triangles that face the wrong way */
  inverted: Float32Array
}

export interface RepairOptions {
  fillHoles: boolean
  fixNormals: boolean
  removeInternal: boolean
  removeFragments: boolean
}

export const DEFAULT_REPAIR: RepairOptions = { fillHoles: true, fixNormals: true, removeInternal: true, removeFragments: true }

export interface RepairResult {
  before: MeshReport
  after: MeshReport
  positions: Float32Array
  index: Uint32Array
  overlay: IssueOverlay
  log: string[]
}

export type Progress = (msg: string, pct?: number) => void

interface Work {
  verts: Float64Array
  V: number
  tris: Uint32Array
  F: number
  /** weld tolerance */
  tol: number
  /** degenerate-face height threshold */
  degTol: number
  diag: number
}

const nextSlot = (s: number) => (s % 3 === 2 ? s - 2 : s + 1)

// ------------------------------------------------------------------ weld
/** Merges coincident vertices of a triangle soup (9 floats per triangle). */
export function weld(soup: Float32Array | Float64Array): Work {
  const n = Math.floor(soup.length / 3)
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let i = 0; i < n * 3; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2]
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (z < z0) z0 = z
    if (x > x1) x1 = x
    if (y > y1) y1 = y
    if (z > z1) z1 = z
  }
  const diag = n ? Math.hypot(x1 - x0, y1 - y0, z1 - z0) || 1 : 1
  const tol = diag * 1e-7
  const inv = 1 / tol
  let cap = 1
  while (cap < n * 2) cap <<= 1
  const mask = cap - 1
  const table = new Int32Array(cap).fill(-1)
  const q = new Float64Array(n * 3)
  const verts = new Float64Array(n * 3)
  const tris = new Uint32Array(n - (n % 3))
  let V = 0
  for (let i = 0; i < tris.length; i++) {
    const x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2]
    const qx = Math.round((x - x0) * inv), qy = Math.round((y - y0) * inv), qz = Math.round((z - z0) * inv)
    let h = (Math.imul(qx | 0, 73856093) ^ Math.imul(qy | 0, 19349663) ^ Math.imul(qz | 0, 83492791)) & mask
    for (;;) {
      const j = table[h]
      if (j < 0) {
        table[h] = V
        q[V * 3] = qx
        q[V * 3 + 1] = qy
        q[V * 3 + 2] = qz
        verts[V * 3] = x
        verts[V * 3 + 1] = y
        verts[V * 3 + 2] = z
        tris[i] = V++
        break
      }
      if (q[j * 3] === qx && q[j * 3 + 1] === qy && q[j * 3 + 2] === qz) {
        tris[i] = j
        break
      }
      h = (h + 1) & mask
    }
  }
  return { verts: verts.slice(0, V * 3), V, tris, F: tris.length / 3, tol, degTol: diag * 1e-7, diag }
}

// ------------------------------------------------------------------ edges
interface Edges {
  E: number
  /** edge id per face slot (slot s = edge tris[s] → tris[nextSlot(s)]), -1 for collapsed slots */
  fe: Int32Array
  count: Int32Array
  start: Int32Array
  /** face slots grouped by edge (CSR via start) */
  slots: Int32Array
  /** lo, hi vertex per edge */
  ev: Int32Array
}

function buildEdges(tris: Uint32Array, F: number, V: number): Edges {
  const S = F * 3
  const off = new Int32Array(V + 1)
  for (let s = 0; s < S; s++) {
    const a = tris[s], b = tris[nextSlot(s)]
    if (a !== b) off[(a < b ? a : b) + 1]++
  }
  for (let v = 0; v < V; v++) off[v + 1] += off[v]
  const fill = off.slice(0, V)
  const bucket = new Int32Array(off[V])
  for (let s = 0; s < S; s++) {
    const a = tris[s], b = tris[nextSlot(s)]
    if (a !== b) bucket[fill[a < b ? a : b]++] = s
  }
  const fe = new Int32Array(S).fill(-1)
  const ev = new Int32Array(2 * off[V])
  let E = 0
  for (let v = 0; v < V; v++) {
    const end = off[v + 1]
    for (let i = off[v]; i < end; i++) {
      const s = bucket[i]
      if (fe[s] >= 0) continue
      const a = tris[s], b = tris[nextSlot(s)]
      const hi = a === v ? b : a
      const id = E++
      ev[2 * id] = v
      ev[2 * id + 1] = hi
      fe[s] = id
      for (let j = i + 1; j < end; j++) {
        const s2 = bucket[j]
        if (fe[s2] >= 0) continue
        const a2 = tris[s2], b2 = tris[nextSlot(s2)]
        if ((a2 === v ? b2 : a2) === hi) fe[s2] = id
      }
    }
  }
  const count = new Int32Array(E)
  for (let s = 0; s < S; s++) if (fe[s] >= 0) count[fe[s]]++
  const start = new Int32Array(E + 1)
  for (let e = 0; e < E; e++) start[e + 1] = start[e] + count[e]
  const pos = start.slice(0, E)
  const slots = new Int32Array(start[E])
  for (let s = 0; s < S; s++) if (fe[s] >= 0) slots[pos[fe[s]]++] = s
  return { E, fe, count, start, slots, ev: ev.slice(0, 2 * E) }
}

/** 0 if the slot runs lo→hi, 1 if hi→lo */
const dirOf = (tris: Uint32Array, s: number) => (tris[s] < tris[nextSlot(s)] ? 0 : 1)

// ------------------------------------------------------------------ geometry helpers
function faceNormal(w: Work, f: number, out: number[]) {
  const t = w.tris, p = w.verts
  const a = t[f * 3] * 3, b = t[f * 3 + 1] * 3, c = t[f * 3 + 2] * 3
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
  out[0] = uy * vz - uz * vy
  out[1] = uz * vx - ux * vz
  out[2] = ux * vy - uy * vx
  return Math.hypot(out[0], out[1], out[2]) // = 2 × area
}

function centroid(w: Work, f: number, out: number[]) {
  const t = w.tris, p = w.verts
  const a = t[f * 3] * 3, b = t[f * 3 + 1] * 3, c = t[f * 3 + 2] * 3
  out[0] = (p[a] + p[b] + p[c]) / 3
  out[1] = (p[a + 1] + p[b + 1] + p[c + 1]) / 3
  out[2] = (p[a + 2] + p[b + 2] + p[c + 2]) / 3
}

/** Height of the triangle over its longest edge – ~0 for needles and caps. */
function faceHeight(w: Work, f: number) {
  const t = w.tris, p = w.verts
  const a = t[f * 3], b = t[f * 3 + 1], c = t[f * 3 + 2]
  if (a === b || b === c || a === c) return 0
  const n = [0, 0, 0]
  const area2 = faceNormal(w, f, n)
  const l = Math.max(dist(p, a, b), dist(p, b, c), dist(p, c, a))
  return l > 0 ? area2 / l : 0
}

const dist = (p: Float64Array, a: number, b: number) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2])

function isDegenerate(w: Work, f: number) {
  return faceHeight(w, f) <= w.degTol
}

/** Keeps faces where keep[f] is set, plus `extra` new faces. */
function compact(w: Work, keep: Uint8Array, extra: number[] = []) {
  let F = 0
  for (let f = 0; f < w.F; f++) if (keep[f]) F++
  const tris = new Uint32Array((F + extra.length / 3) * 3)
  let o = 0
  for (let f = 0; f < w.F; f++) {
    if (!keep[f]) continue
    tris[o++] = w.tris[f * 3]
    tris[o++] = w.tris[f * 3 + 1]
    tris[o++] = w.tris[f * 3 + 2]
  }
  tris.set(extra, o)
  w.tris = tris
  w.F = tris.length / 3
}

// ------------------------------------------------------------------ BVH (ray parity queries)
class BVH {
  private bmin: Float64Array
  private bmax: Float64Array
  private left: Int32Array
  private first: Int32Array
  private cnt: Int32Array
  private order: Int32Array
  private nodes = 0
  private stack = new Int32Array(128)
  private w: Work

  constructor(w: Work, include?: Uint8Array) {
    this.w = w
    const { F, tris, verts: p } = w
    let n = 0
    const order = new Int32Array(F)
    for (let f = 0; f < F; f++) if (!include || include[f]) order[n++] = f
    this.order = order.subarray(0, n)
    const cen = new Float32Array(F * 3)
    for (let i = 0; i < n; i++) {
      const f = this.order[i]
      for (let k = 0; k < 3; k++) cen[f * 3 + k] = (p[tris[f * 3] * 3 + k] + p[tris[f * 3 + 1] * 3 + k] + p[tris[f * 3 + 2] * 3 + k]) / 3
    }
    const max = Math.max(1, 2 * n)
    this.bmin = new Float64Array(max * 3)
    this.bmax = new Float64Array(max * 3)
    this.left = new Int32Array(max)
    this.first = new Int32Array(max)
    this.cnt = new Int32Array(max)
    const todo: number[] = [this.alloc(0, n)]
    while (todo.length) {
      const node = todo.pop()!
      const s = this.first[node], e = s + this.cnt[node]
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
      let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity
      for (let i = s; i < e; i++) {
        const f = this.order[i]
        for (let k = 0; k < 3; k++) {
          const v = tris[f * 3 + k] * 3
          const x = p[v], y = p[v + 1], z = p[v + 2]
          if (x < x0) x0 = x
          if (y < y0) y0 = y
          if (z < z0) z0 = z
          if (x > x1) x1 = x
          if (y > y1) y1 = y
          if (z > z1) z1 = z
        }
        const cx = cen[f * 3], cy = cen[f * 3 + 1], cz = cen[f * 3 + 2]
        if (cx < cx0) cx0 = cx
        if (cy < cy0) cy0 = cy
        if (cz < cz0) cz0 = cz
        if (cx > cx1) cx1 = cx
        if (cy > cy1) cy1 = cy
        if (cz > cz1) cz1 = cz
      }
      const pad = w.diag * 1e-9
      this.bmin.set([x0 - pad, y0 - pad, z0 - pad], node * 3)
      this.bmax.set([x1 + pad, y1 + pad, z1 + pad], node * 3)
      this.left[node] = -1
      if (e - s <= 4) continue
      const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2
      const mid = axis === 0 ? (cx0 + cx1) / 2 : axis === 1 ? (cy0 + cy1) / 2 : (cz0 + cz1) / 2
      let i = s, j = e - 1
      while (i <= j) {
        if (cen[this.order[i] * 3 + axis] < mid) i++
        else {
          const t = this.order[i]
          this.order[i] = this.order[j]
          this.order[j--] = t
        }
      }
      let split = i
      if (split === s || split === e) split = (s + e) >> 1 // all centroids coincide
      const l = this.alloc(s, split - s)
      this.alloc(split, e - split)
      this.left[node] = l
      todo.push(l, l + 1)
    }
  }

  private alloc(first: number, count: number) {
    const id = this.nodes++
    this.first[id] = first
    this.cnt[id] = count
    return id
  }

  /** Calls onHit(face) for every triangle the ray crosses (t > 0), except `skip`. */
  cast(o: number[], d: number[], skip: number, onHit: (f: number) => void) {
    if (!this.order.length) return
    const { bmin, bmax, left, first, cnt, order } = this
    const { tris, verts: p } = this.w
    const ix = 1 / d[0], iy = 1 / d[1], iz = 1 / d[2]
    const st = this.stack
    let sp = 0
    st[sp++] = 0
    while (sp) {
      const node = st[--sp]
      const n3 = node * 3
      let t0 = (bmin[n3] - o[0]) * ix, t1 = (bmax[n3] - o[0]) * ix
      let tmin = Math.min(t0, t1), tmax = Math.max(t0, t1)
      t0 = (bmin[n3 + 1] - o[1]) * iy
      t1 = (bmax[n3 + 1] - o[1]) * iy
      tmin = Math.max(tmin, Math.min(t0, t1))
      tmax = Math.min(tmax, Math.max(t0, t1))
      t0 = (bmin[n3 + 2] - o[2]) * iz
      t1 = (bmax[n3 + 2] - o[2]) * iz
      tmin = Math.max(tmin, Math.min(t0, t1))
      tmax = Math.min(tmax, Math.max(t0, t1))
      if (!(tmax >= 0 && tmin <= tmax)) continue
      if (left[node] >= 0) {
        if (sp + 2 > st.length) this.stack = new Int32Array(st.length * 2)
        st[sp++] = left[node]
        st[sp++] = left[node] + 1
        continue
      }
      for (let i = first[node], e = i + cnt[node]; i < e; i++) {
        const f = order[i]
        if (f === skip) continue
        const a = tris[f * 3] * 3, b = tris[f * 3 + 1] * 3, c = tris[f * 3 + 2] * 3
        const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2]
        const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2]
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x
        const det = e1x * px + e1y * py + e1z * pz
        if (det > -1e-30 && det < 1e-30) continue
        const inv = 1 / det
        const sx = o[0] - p[a], sy = o[1] - p[a + 1], sz = o[2] - p[a + 2]
        const u = (sx * px + sy * py + sz * pz) * inv
        if (u < 0 || u > 1) continue
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv
        if (v < 0 || u + v > 1) continue
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv
        if (t > 0) onHit(f)
      }
    }
  }
}

/** Well-spread, deliberately non-axis-aligned ray directions (Fibonacci sphere). */
const DIRS: number[][] = (() => {
  const out: number[][] = []
  const n = 14
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2
    const r = Math.sqrt(1 - y * y)
    const a = i * 2.399963229728653 + 0.3127
    const v = [Math.cos(a) * r, y, Math.sin(a) * r]
    // tiny irrational skew keeps rays off exact edges/vertices of axis-aligned CAD meshes
    v[0] += 0.0123
    v[2] -= 0.0071
    const l = Math.hypot(v[0], v[1], v[2])
    out.push([v[0] / l, v[1] / l, v[2] / l])
  }
  return out
})()

// ------------------------------------------------------------------ connectivity
interface Components {
  C: number
  comp: Int32Array
  /** orientation relative to each component's seed face (1 = flip) */
  rel: Uint8Array
  order: Int32Array
  cstart: Int32Array
}

/** Faces connected through manifold (2-face) edges, with a consistent relative orientation. */
function manifoldComponents(w: Work, ed: Edges): Components {
  const { F, tris } = w
  const { fe, count, start, slots } = ed
  const comp = new Int32Array(F).fill(-1)
  const rel = new Uint8Array(F)
  const order = new Int32Array(F)
  const cstart: number[] = []
  let head = 0, tail = 0, C = 0
  for (let seed = 0; seed < F; seed++) {
    if (comp[seed] >= 0) continue
    cstart.push(tail)
    comp[seed] = C
    order[tail++] = seed
    while (head < tail) {
      const f = order[head++]
      for (let k = 0; k < 3; k++) {
        const s = f * 3 + k
        const e = fe[s]
        if (e < 0 || count[e] !== 2) continue
        const s2 = slots[start[e]] === s ? slots[start[e] + 1] : slots[start[e]]
        const g = (s2 / 3) | 0
        if (comp[g] >= 0) continue
        comp[g] = C
        rel[g] = rel[f] ^ (dirOf(tris, s) === dirOf(tris, s2) ? 1 : 0)
        order[tail++] = g
      }
    }
    C++
  }
  cstart.push(F)
  return { C, comp, rel, order, cstart: Int32Array.from(cstart) }
}

/** Vertex-connected shells. */
function shells(w: Work) {
  const parent = new Int32Array(w.V)
  for (let i = 0; i < w.V; i++) parent[i] = i
  const find = (x: number) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]]
    return x
  }
  for (let f = 0; f < w.F; f++) {
    const a = find(w.tris[f * 3]), b = find(w.tris[f * 3 + 1]), c = find(w.tris[f * 3 + 2])
    if (a !== b) parent[b] = a
    if (a !== c) parent[find(c)] = find(a)
  }
  const id = new Int32Array(w.V).fill(-1)
  const shellOf = new Int32Array(w.F)
  let n = 0
  for (let f = 0; f < w.F; f++) {
    const r = find(w.tris[f * 3])
    if (id[r] < 0) id[r] = n++
    shellOf[f] = id[r]
  }
  return { shellOf, count: n }
}

// ------------------------------------------------------------------ orientation
/**
 * Returns flip[f] = 1 for every face that should be reversed: each manifold patch is made consistent, then
 * pointed outward using ray parity against its own shell. Shells enclosed by another shell (cavities, nested
 * bodies) keep the orientation the file gave them.
 */
function orientation(w: Work, ed: Edges, include?: Uint8Array): Uint8Array {
  const cc = manifoldComponents(w, ed)
  const { shellOf, count: nShells } = shells(w)
  const bvh = new BVH(w, include)
  const depth = nestingDepth(w, shellOf, nShells, bvh)
  const flip = new Uint8Array(w.F)
  const n = [0, 0, 0], c = [0, 0, 0], d = [0, 0, 0]
  for (let k = 0; k < cc.C; k++) {
    const s = cc.cstart[k], e = cc.cstart[k + 1]
    const size = e - s
    let relFlips = 0
    for (let i = s; i < e; i++) relFlips += cc.rel[cc.order[i]]
    const shell = shellOf[cc.order[s]]
    let vote = 0
    if (!depth[shell]) {
      // sample up to 8 well-sized faces spread across the patch
      const samples = Math.min(8, size)
      for (let j = 0; j < samples; j++) {
        let f = cc.order[s + Math.floor(((j + 0.5) * size) / samples)]
        // prefer a non-sliver face near the chosen spot
        for (let t = 0; t < 4 && faceNormal(w, f, n) < w.degTol * w.diag; t++) f = cc.order[s + ((f + t * 7919) % size)]
        const len = faceNormal(w, f, n)
        if (len <= 0 || (include && !include[f])) continue
        const sign = cc.rel[f] ? -1 : 1
        n[0] *= sign / len
        n[1] *= sign / len
        n[2] *= sign / len
        centroid(w, f, c)
        for (const dir of DIRS) {
          const dd = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2]
          if (Math.abs(dd) < 0.2) continue
          // Parity on both sides: a real skin is outside on one side and inside on the other. Internal walls
          // (inside on both) and loose fins (outside on both) have no "right" side, so they don't vote.
          const k2 = dd > 0 ? 1 : -1
          let front = 0, back = 0
          d[0] = dir[0] * k2
          d[1] = dir[1] * k2
          d[2] = dir[2] * k2
          bvh.cast(c, d, f, (g) => {
            if (shellOf[g] === shell) front++
          })
          d[0] = -d[0]
          d[1] = -d[1]
          d[2] = -d[2]
          bvh.cast(c, d, f, (g) => {
            if (shellOf[g] === shell) back++
          })
          if ((front & 1) !== (back & 1)) vote += front & 1 ? -1 : 1
        }
      }
    }
    // outward wins; ties and nested shells keep whatever most of the file already had
    const sign = vote < 0 ? 1 : vote > 0 ? 0 : relFlips * 2 > size ? 1 : 0
    for (let i = s; i < e; i++) flip[cc.order[i]] = cc.rel[cc.order[i]] ^ sign
  }
  return flip
}

/** How many other shells fully enclose each shell. */
function nestingDepth(w: Work, shellOf: Int32Array, n: number, bvh: BVH): Uint8Array {
  const depth = new Uint8Array(n)
  if (n < 2 || n > 4000) return depth
  const bb = new Float64Array(n * 6)
  for (let i = 0; i < n; i++) bb.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], i * 6)
  const firstFaces: number[][] = Array.from({ length: n }, () => [])
  for (let f = 0; f < w.F; f++) {
    const s = shellOf[f]
    if (firstFaces[s].length < 64) firstFaces[s].push(f)
    for (let k = 0; k < 3; k++) {
      const v = w.tris[f * 3 + k] * 3
      for (let a = 0; a < 3; a++) {
        const x = w.verts[v + a]
        if (x < bb[s * 6 + a]) bb[s * 6 + a] = x
        if (x > bb[s * 6 + 3 + a]) bb[s * 6 + 3 + a] = x
      }
    }
  }
  const inside = (a: number, b: number) => {
    for (let k = 0; k < 3; k++) if (bb[a * 6 + k] < bb[b * 6 + k] || bb[a * 6 + 3 + k] > bb[b * 6 + 3 + k]) return false
    return true
  }
  const c = [0, 0, 0]
  const hits = new Int32Array(n)
  for (let a = 0; a < n; a++) {
    const cand: number[] = []
    for (let b = 0; b < n; b++) if (b !== a && inside(a, b)) cand.push(b)
    if (!cand.length) continue
    const faces = firstFaces[a]
    const samples = Math.min(5, faces.length)
    const insideCount = new Int32Array(cand.length)
    for (let j = 0; j < samples; j++) {
      const f = faces[Math.floor((j * faces.length) / samples)]
      centroid(w, f, c)
      const odd = new Int32Array(cand.length)
      for (let r = 0; r < 3; r++) {
        for (const b of cand) hits[b] = 0
        bvh.cast(c, DIRS[r * 4 + 1], f, (g) => hits[shellOf[g]]++)
        cand.forEach((b, i) => (odd[i] += hits[b] & 1))
      }
      cand.forEach((_, i) => (insideCount[i] += odd[i] >= 2 ? 1 : 0))
    }
    for (let i = 0; i < cand.length; i++) if (insideCount[i] >= Math.max(1, samples - (samples >= 4 ? 1 : 0))) depth[a]++
  }
  return depth
}

// ------------------------------------------------------------------ boundary loops
interface Loop {
  verts: number[]
  /** edge ids along the loop (edge i joins verts[i] → verts[i+1]) */
  edges: number[]
}

function boundaryLoops(w: Work, ed: Edges): Loop[] {
  const { E, count, ev } = ed
  const deg = new Int32Array(w.V + 1)
  for (let e = 0; e < E; e++) {
    if (count[e] !== 1) continue
    deg[ev[2 * e] + 1]++
    deg[ev[2 * e + 1] + 1]++
  }
  for (let v = 0; v < w.V; v++) deg[v + 1] += deg[v]
  const adjStart = deg.slice()
  const fill = deg.slice(0, w.V)
  const adj = new Int32Array(deg[w.V])
  for (let e = 0; e < E; e++) {
    if (count[e] !== 1) continue
    adj[fill[ev[2 * e]]++] = e
    adj[fill[ev[2 * e + 1]]++] = e
  }
  const used = new Uint8Array(E)
  const cursor = adjStart.slice(0, w.V)
  const nextEdge = (v: number) => {
    while (cursor[v] < adjStart[v + 1]) {
      const e = adj[cursor[v]]
      if (!used[e]) return e
      cursor[v]++
    }
    return -1
  }
  const loops: Loop[] = []
  const pos = new Map<number, number>()
  for (let e0 = 0; e0 < E; e0++) {
    if (count[e0] !== 1 || used[e0]) continue
    const path = [ev[2 * e0]]
    const pe: number[] = [e0]
    pos.clear()
    pos.set(path[0], 0)
    used[e0] = 1
    let cur = ev[2 * e0 + 1]
    for (;;) {
      const at = pos.get(cur)
      if (at !== undefined) {
        const verts = path.slice(at)
        const edges = pe.slice(at)
        if (verts.length >= 3) loops.push({ verts, edges })
        for (let i = at + 1; i < path.length; i++) pos.delete(path[i])
        path.length = at + 1
        pe.length = at
      } else {
        pos.set(cur, path.length)
        path.push(cur)
      }
      const e = nextEdge(cur)
      if (e < 0) break
      used[e] = 1
      pe.push(e)
      cur = ev[2 * e] === cur ? ev[2 * e + 1] : ev[2 * e]
    }
  }
  return loops
}

function loopIsPlanar(w: Work, loop: number[]) {
  const p = w.verts
  const n = newell(w, loop)
  const l = Math.hypot(n[0], n[1], n[2])
  let cx = 0, cy = 0, cz = 0
  for (const v of loop) {
    cx += p[v * 3]
    cy += p[v * 3 + 1]
    cz += p[v * 3 + 2]
  }
  cx /= loop.length
  cy /= loop.length
  cz /= loop.length
  let size = 0
  for (const v of loop) size = Math.max(size, Math.hypot(p[v * 3] - cx, p[v * 3 + 1] - cy, p[v * 3 + 2] - cz))
  if (l < 1e-30) return true // zero-area slit
  let dev = 0
  for (const v of loop) dev = Math.max(dev, Math.abs((p[v * 3] - cx) * n[0] + (p[v * 3 + 1] - cy) * n[1] + (p[v * 3 + 2] - cz) * n[2]) / l)
  return dev <= Math.max(size * 0.01, w.tol * 10)
}

function newell(w: Work, loop: number[]) {
  const p = w.verts
  let nx = 0, ny = 0, nz = 0
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3
    nx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2])
    ny += (p[a + 2] - p[b + 2]) * (p[a] + p[b])
    nz += (p[a] - p[b]) * (p[a + 1] + p[b + 1])
  }
  return [nx, ny, nz]
}

// ------------------------------------------------------------------ analysis
interface Analysis {
  report: MeshReport
  overlay: IssueOverlay
}

export function analyze(soup: Float32Array | Float64Array): Analysis {
  return analyzeWork(weld(soup))
}

function analyzeWork(w: Work): Analysis {
  const { F, tris, verts: p } = w
  // degenerate faces
  let degenerate = 0
  const valid = new Uint8Array(F)
  for (let f = 0; f < F; f++) {
    if (isDegenerate(w, f)) degenerate++
    else valid[f] = 1
  }
  const ed = buildEdges(tris, F, w.V)

  // duplicate faces (same three vertices, either winding)
  let duplicates = 0
  const dup = new Uint8Array(F)
  for (let f = 0; f < F; f++) {
    const e = ed.fe[f * 3]
    if (e < 0 || ed.count[e] < 2) continue
    for (let i = ed.start[e]; i < ed.start[e + 1]; i++) {
      const g = (ed.slots[i] / 3) | 0
      if (g <= f || dup[g] || !sameTriangle(tris, f, g)) continue
      dup[g] = 1
      duplicates++
    }
  }

  let naked = 0, nonManifold = 0
  for (let e = 0; e < ed.E; e++) {
    if (ed.count[e] === 1) naked++
    else if (ed.count[e] > 2) nonManifold++
  }

  let planar = 0, nonPlanar = 0
  for (const loop of boundaryLoops(w, ed)) loopIsPlanar(w, loop.verts) ? planar++ : nonPlanar++

  const include = new Uint8Array(F)
  for (let f = 0; f < F; f++) include[f] = valid[f] && !dup[f] ? 1 : 0
  const flip = orientation(w, ed, include)
  let inverted = 0
  for (let f = 0; f < F; f++) if (flip[f] && include[f]) inverted++

  const sh = shells(w)
  const fragments = countFragments(w, sh.shellOf, sh.count)

  let volume = 0, area = 0
  const n = [0, 0, 0]
  for (let f = 0; f < F; f++) {
    if (!include[f]) continue
    const a = tris[f * 3] * 3, b = tris[f * 3 + 1] * 3, c = tris[f * 3 + 2] * 3
    const v =
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
    volume += (flip[f] ? -v : v) / 6
    area += faceNormal(w, f, n) / 2
  }

  // overlay geometry
  const seg = (e: number, out: Float32Array, i: number) => {
    const a = ed.ev[2 * e] * 3, b = ed.ev[2 * e + 1] * 3
    out.set([p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2]], i * 6)
  }
  const nakedSeg = new Float32Array(naked * 6)
  const nmSeg = new Float32Array(nonManifold * 6)
  for (let e = 0, i = 0, j = 0; e < ed.E; e++) {
    if (ed.count[e] === 1) seg(e, nakedSeg, i++)
    else if (ed.count[e] > 2) seg(e, nmSeg, j++)
  }
  const inv = new Float32Array(inverted * 9)
  for (let f = 0, i = 0; f < F; f++) {
    if (!flip[f] || !include[f]) continue
    for (let k = 0; k < 3; k++) inv.set([p[tris[f * 3 + k] * 3], p[tris[f * 3 + k] * 3 + 1], p[tris[f * 3 + k] * 3 + 2]], i * 9 + k * 3)
    i++
  }

  return {
    report: {
      vertices: w.V,
      triangles: F,
      nakedEdges: naked,
      planarHoles: planar,
      nonPlanarHoles: nonPlanar,
      nonManifoldEdges: nonManifold,
      invertedNormals: inverted,
      duplicateFaces: duplicates,
      degenerateFaces: degenerate,
      shells: sh.count,
      fragments,
      watertight: naked === 0 && nonManifold === 0,
      volume: Math.abs(volume),
      area,
    },
    overlay: { naked: nakedSeg, nonManifold: nmSeg, inverted: inv },
  }
}

function sameTriangle(t: Uint32Array, f: number, g: number) {
  const a = t[f * 3], b = t[f * 3 + 1], c = t[f * 3 + 2]
  const x = t[g * 3], y = t[g * 3 + 1], z = t[g * 3 + 2]
  return (x === a || x === b || x === c) && (y === a || y === b || y === c) && (z === a || z === b || z === c)
}
/** Same vertices and the same cyclic winding. */
function sameWinding(t: Uint32Array, f: number, g: number) {
  const a = t[f * 3], b = t[f * 3 + 1]
  const g0 = t[g * 3], g1 = t[g * 3 + 1], g2 = t[g * 3 + 2]
  return (g0 === a && g1 === b) || (g1 === a && g2 === b) || (g2 === a && g0 === b)
}

/** Tiny loose bits: shells under 4 faces, or smaller than 0.2 % of the model. */
function fragmentShells(w: Work, shellOf: Int32Array, n: number) {
  const faces = new Int32Array(n)
  const bb = new Float64Array(n * 6)
  for (let i = 0; i < n; i++) bb.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], i * 6)
  for (let f = 0; f < w.F; f++) {
    const s = shellOf[f]
    faces[s]++
    for (let k = 0; k < 3; k++) {
      const v = w.tris[f * 3 + k] * 3
      for (let a = 0; a < 3; a++) {
        const x = w.verts[v + a]
        if (x < bb[s * 6 + a]) bb[s * 6 + a] = x
        if (x > bb[s * 6 + 3 + a]) bb[s * 6 + 3 + a] = x
      }
    }
  }
  const frag = new Uint8Array(n)
  if (n < 2) return frag
  for (let s = 0; s < n; s++) {
    const d = Math.hypot(bb[s * 6 + 3] - bb[s * 6], bb[s * 6 + 4] - bb[s * 6 + 1], bb[s * 6 + 5] - bb[s * 6 + 2])
    if (faces[s] < 4 || d < w.diag * 0.002) frag[s] = 1
  }
  return frag
}
function countFragments(w: Work, shellOf: Int32Array, n: number) {
  return fragmentShells(w, shellOf, n).reduce((a, b) => a + b, 0)
}

// ------------------------------------------------------------------ repair steps
/** Naked + non-manifold edge count – the measure no repair step is allowed to make worse. */
function edgeDefects(w: Work) {
  const ed = buildEdges(w.tris, w.F, w.V)
  let n = 0
  for (let e = 0; e < ed.E; e++) if (ed.count[e] !== 2) n++
  return n
}

/**
 * Fixes zero-area faces without opening cracks: micro-edges are collapsed, and for needles (a vertex lying on
 * the opposite edge) the neighbour across that edge is split at the vertex before the needle is dropped.
 * Each round is rolled back if it would leave more naked / non-manifold edges than before. Slivers that
 * can't be fixed safely are left alone – a zero-area face is harmless to a slicer, a crack is not.
 */
function fixDegenerates(w: Work): { removed: number; split: number; collapsed: number } {
  let removed = 0, split = 0, collapsed = 0
  let baseline = edgeDefects(w)
  for (let round = 0; round < 6; round++) {
    const deg: number[] = []
    for (let f = 0; f < w.F; f++) if (isDegenerate(w, f)) deg.push(f)
    if (!deg.length) break
    const snapshot = w.tris.slice()
    const F0 = w.F
    const t = w.tris
    const ed = buildEdges(t, w.F, w.V)
    const touched = new Uint8Array(w.F)
    const keep = new Uint8Array(w.F).fill(1)
    const extra: number[] = []
    const rep = new Int32Array(w.V)
    for (let i = 0; i < w.V; i++) rep[i] = i
    let r = 0, sp = 0, co = 0
    const p = w.verts
    for (const f of deg) {
      if (touched[f]) continue
      const a = t[f * 3], b = t[f * 3 + 1], c = t[f * 3 + 2]
      if (a === b || b === c || a === c) {
        keep[f] = 0
        touched[f] = 1
        r++
        continue
      }
      const l = [dist(p, a, b), dist(p, b, c), dist(p, c, a)]
      const shortK = l[0] <= l[1] && l[0] <= l[2] ? 0 : l[1] <= l[2] ? 1 : 2
      if (l[shortK] <= w.degTol * 10) {
        // micro edge → merge its endpoints (every face using them follows)
        const u = t[f * 3 + shortK], v = t[f * 3 + ((shortK + 1) % 3)]
        if (rep[u] === u && rep[v] === v) {
          rep[v] = u
          touched[f] = 1
          co++
        }
        continue
      }
      // needle: the vertex opposite the longest edge lies on it → split the face across that edge there
      const longK = l[0] >= l[1] && l[0] >= l[2] ? 0 : l[1] >= l[2] ? 1 : 2
      const s = f * 3 + longK
      const mid = t[f * 3 + ((longK + 2) % 3)]
      const e = ed.fe[s]
      if (e < 0 || ed.count[e] !== 2) continue
      const s2 = ed.slots[ed.start[e]] === s ? ed.slots[ed.start[e] + 1] : ed.slots[ed.start[e]]
      const g = (s2 / 3) | 0
      if (touched[g] || isDegenerate(w, g)) continue
      const pv = t[s2], qv = t[nextSlot(s2)], xv = t[nextSlot(nextSlot(s2))]
      if (xv === mid) continue
      keep[f] = 0
      touched[f] = 1
      touched[g] = 1
      t[g * 3] = pv
      t[g * 3 + 1] = mid
      t[g * 3 + 2] = xv
      extra.push(mid, qv, xv)
      r++
      sp++
    }
    if (!r && !co) break
    if (co) {
      for (let i = 0; i < t.length; i++) {
        let v = t[i]
        while (rep[v] !== v) v = rep[v]
        t[i] = v
      }
      // faces squashed by the collapse
      for (let f = 0; f < w.F; f++) {
        if (keep[f] && (t[f * 3] === t[f * 3 + 1] || t[f * 3 + 1] === t[f * 3 + 2] || t[f * 3] === t[f * 3 + 2])) {
          keep[f] = 0
          r++
        }
      }
    }
    compact(w, keep, extra)
    const now = edgeDefects(w)
    if (now > baseline) {
      w.tris = snapshot
      w.F = F0
      break
    }
    baseline = now
    removed += r
    split += sp
    collapsed += co
  }
  return { removed, split, collapsed }
}

function removeDuplicates(w: Work) {
  const ed = buildEdges(w.tris, w.F, w.V)
  const keep = new Uint8Array(w.F).fill(1)
  let removed = 0
  for (let f = 0; f < w.F; f++) {
    if (!keep[f]) continue
    const e = ed.fe[f * 3]
    if (e < 0 || ed.count[e] < 2) continue
    for (let i = ed.start[e]; i < ed.start[e + 1]; i++) {
      const g = (ed.slots[i] / 3) | 0
      if (g === f || !keep[g] || !sameTriangle(w.tris, f, g)) continue
      keep[g] = 0
      removed++
      if (!sameWinding(w.tris, f, g)) {
        // back-to-back pair = zero-thickness internal wall (e.g. two bodies sharing a face) → drop both
        keep[f] = 0
        removed++
        break
      }
    }
  }
  if (removed) compact(w, keep)
  return removed
}

function applyFlips(w: Work, flip: Uint8Array) {
  let n = 0
  for (let f = 0; f < w.F; f++) {
    if (!flip[f]) continue
    const t = w.tris[f * 3 + 1]
    w.tris[f * 3 + 1] = w.tris[f * 3 + 2]
    w.tris[f * 3 + 2] = t
    n++
  }
  return n
}

/**
 * Sheets that hang off a non-manifold edge (one face of the patch on that edge) and sit entirely inside
 * their shell are internal walls – remove them so the outer skin becomes manifold.
 */
function removeInternalSheets(w: Work) {
  const ed = buildEdges(w.tris, w.F, w.V)
  const cc = manifoldComponents(w, ed)
  const cand = new Set<number>()
  const tally = new Map<number, number>()
  for (let e = 0; e < ed.E; e++) {
    if (ed.count[e] <= 2) continue
    tally.clear()
    for (let i = ed.start[e]; i < ed.start[e + 1]; i++) {
      const c = cc.comp[(ed.slots[i] / 3) | 0]
      tally.set(c, (tally.get(c) ?? 0) + 1)
    }
    for (const [c, k] of tally) if (k === 1) cand.add(c)
  }
  if (!cand.size) return 0
  const { shellOf } = shells(w)
  const bvh = new BVH(w)
  const shellArea = new Map<number, number>()
  const n = [0, 0, 0]
  for (let f = 0; f < w.F; f++) shellArea.set(shellOf[f], (shellArea.get(shellOf[f]) ?? 0) + faceNormal(w, f, n))
  const keep = new Uint8Array(w.F).fill(1)
  const c = [0, 0, 0]
  let removed = 0
  let budget = 4000
  for (const k of cand) {
    if (budget-- <= 0) break
    const s = cc.cstart[k], e = cc.cstart[k + 1]
    const size = e - s
    const shell = shellOf[cc.order[s]]
    let area = 0
    for (let i = s; i < e; i++) area += faceNormal(w, cc.order[i], n)
    if (area > shellArea.get(shell)! * 0.5) continue // never strip the bulk of a body
    let odd = 0, total = 0
    const samples = Math.min(4, size)
    for (let j = 0; j < samples; j++) {
      const f = cc.order[s + Math.floor(((j + 0.5) * size) / samples)]
      centroid(w, f, c)
      for (let r = 0; r < 8; r++) {
        let hits = 0
        bvh.cast(c, DIRS[(r * 5 + j) % DIRS.length], f, (g) => {
          if (shellOf[g] === shell && cc.comp[g] !== k) hits++
        })
        odd += hits & 1
        total++
      }
    }
    if (total && odd / total >= 0.85) {
      for (let i = s; i < e; i++) keep[cc.order[i]] = 0
      removed += size
    }
  }
  if (removed) compact(w, keep)
  return removed
}

function removeFragments(w: Work) {
  const sh = shells(w)
  const frag = fragmentShells(w, sh.shellOf, sh.count)
  const keep = new Uint8Array(w.F)
  let shellsRemoved = 0
  const seen = new Uint8Array(sh.count)
  for (let f = 0; f < w.F; f++) {
    const s = sh.shellOf[f]
    keep[f] = frag[s] ? 0 : 1
    if (frag[s] && !seen[s]) {
      seen[s] = 1
      shellsRemoved++
    }
  }
  if (shellsRemoved) compact(w, keep)
  return shellsRemoved
}

// ------------------------------------------------------------------ hole filling
function fillHoles(w: Work): { holes: number; faces: number } {
  const ed = buildEdges(w.tris, w.F, w.V)
  const loops = boundaryLoops(w, ed)
  if (!loops.length) return { holes: 0, faces: 0 }
  // existing edges among boundary vertices, so fill diagonals never duplicate one (→ non-manifold)
  const onBoundary = new Uint8Array(w.V)
  for (const l of loops) for (const v of l.verts) onBoundary[v] = 1
  const existing = new Set<number>()
  const key = (a: number, b: number) => (a < b ? a * w.V + b : b * w.V + a)
  for (let e = 0; e < ed.E; e++) if (onBoundary[ed.ev[2 * e]] && onBoundary[ed.ev[2 * e + 1]]) existing.add(key(ed.ev[2 * e], ed.ev[2 * e + 1]))
  const has = (a: number, b: number) => existing.has(key(a, b))

  const out: number[] = []
  const ranges: number[] = []
  for (const loop of loops) {
    // The fill must run against the existing faces along the rim.
    const s = ed.slots[ed.start[loop.edges[0]]]
    const runsForward = w.tris[s] === loop.verts[0] // existing face goes verts[0] → verts[1]
    const ring = runsForward ? loop.verts.slice().reverse() : loop.verts.slice()
    const before = out.length
    triangulate(w, ring, has, out)
    for (let i = before; i < out.length; i += 3) {
      existing.add(key(out[i], out[i + 1]))
      existing.add(key(out[i + 1], out[i + 2]))
      existing.add(key(out[i + 2], out[i]))
    }
    ranges.push(before, out.length)
  }
  // Verify each patch: every one of its edges must end up shared by exactly two faces, else drop that patch.
  const F0 = w.F
  compact(w, new Uint8Array(w.F).fill(1), out)
  const check = buildEdges(w.tris, w.F, w.V)
  const keep = new Uint8Array(w.F).fill(1)
  let holes = 0, faces = 0
  for (let r = 0; r < ranges.length; r += 2) {
    const f0 = F0 + ranges[r] / 3, f1 = F0 + ranges[r + 1] / 3
    let ok = f1 > f0
    for (let f = f0; f < f1 && ok; f++) for (let k = 0; k < 3; k++) if (check.count[check.fe[f * 3 + k]] !== 2) ok = false
    if (ok) {
      holes++
      faces += f1 - f0
    } else for (let f = f0; f < f1; f++) keep[f] = 0
  }
  if (holes * 2 < ranges.length) compact(w, keep)
  return { holes, faces }
}

function triangulate(w: Work, ring: number[], has: (a: number, b: number) => boolean, out: number[]) {
  const n = ring.length
  if (n < 3) return
  if (n === 3) {
    out.push(ring[0], ring[1], ring[2])
    return
  }
  const N = newell(w, ring)
  const len = Math.hypot(N[0], N[1], N[2])
  if (len > 1e-30) {
    N[0] /= len
    N[1] /= len
    N[2] /= len
    // planar basis u, v with u × v = N, so the ring is counter-clockwise in 2D
    const a = Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const u = norm(cross(a, N))
    const v = cross(N, u)
    const xs = new Float64Array(n), ys = new Float64Array(n)
    const p = w.verts
    for (let i = 0; i < n; i++) {
      const o = ring[i] * 3
      xs[i] = p[o] * u[0] + p[o + 1] * u[1] + p[o + 2] * u[2]
      ys[i] = p[o] * v[0] + p[o + 1] * v[1] + p[o + 2] * v[2]
    }
    if (n <= 3000 && isSimple(xs, ys) && earClip(ring, xs, ys, has, out)) return
  }
  if (n <= 160) minAreaFill(w, ring, has, out)
  else greedyFill(w, ring, N, out)
}

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: number[]) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

function segsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx)
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax)
  return d1 * d2 < 0 && d3 * d4 < 0
}

function isSimple(xs: Float64Array, ys: Float64Array) {
  const n = xs.length
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n
    for (let j = i + 2; j < n; j++) {
      const j2 = (j + 1) % n
      if (j2 === i) continue
      if (segsCross(xs[i], ys[i], xs[i2], ys[i2], xs[j], ys[j], xs[j2], ys[j2])) return false
    }
  }
  return true
}

/**
 * Ear clipping on the projected (simple, CCW) ring, best-shaped ear first. Ear status is cached on a linked
 * ring and only refreshed around each clip, so it stays O(n²). Returns false if it gets stuck.
 */
function earClip(ring: number[], xs: Float64Array, ys: Float64Array, has: (a: number, b: number) => boolean, out: number[]) {
  const n = ring.length
  const start = out.length
  const prev = new Int32Array(n), next = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    prev[i] = (i + n - 1) % n
    next[i] = (i + 1) % n
  }
  let scale = 0
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(xs[i] - xs[0]), Math.abs(ys[i] - ys[0]))
  const eps = scale * scale * 1e-14
  const area2 = (i: number, j: number, k: number) => (xs[j] - xs[i]) * (ys[k] - ys[i]) - (ys[j] - ys[i]) * (xs[k] - xs[i])
  const alive = new Uint8Array(n).fill(1)
  const score = new Float64Array(n)
  let strict = true
  let remaining = n
  const evaluate = (j: number) => {
    const i = prev[j], k = next[j]
    score[j] = -Infinity
    if (area2(i, j, k) <= eps) return
    if (strict && has(ring[i], ring[k])) return
    for (let m = next[k]; m !== i; m = next[m]) {
      // only reflex vertices can sit inside an ear
      if (area2(prev[m], m, next[m]) > eps) continue
      if (area2(i, j, m) >= 0 && area2(j, k, m) >= 0 && area2(k, i, m) >= 0) return
    }
    // smallest interior angle first → fewer slivers
    const ax = xs[i] - xs[j], ay = ys[i] - ys[j], bx = xs[k] - xs[j], by = ys[k] - ys[j]
    score[j] = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1)
  }
  for (let j = 0; j < n; j++) evaluate(j)
  while (remaining > 3) {
    let best = -1
    for (let j = 0; j < n; j++) if (alive[j] && score[j] > -Infinity && (best < 0 || score[j] > score[best])) best = j
    if (best < 0) {
      // cached statuses can go stale when a clip unblocks a distant ear – refresh everything, then relax
      for (let j = 0; j < n; j++) if (alive[j]) evaluate(j)
      for (let j = 0; j < n; j++) if (alive[j] && score[j] > -Infinity && (best < 0 || score[j] > score[best])) best = j
      if (best < 0 && strict) {
        strict = false
        continue
      }
      if (best < 0) {
        out.length = start
        return false
      }
    }
    const i = prev[best], k = next[best]
    out.push(ring[i], ring[best], ring[k])
    alive[best] = 0
    next[i] = k
    prev[k] = i
    remaining--
    evaluate(i)
    evaluate(k)
  }
  let j = 0
  while (!alive[j]) j++
  out.push(ring[prev[j]], ring[j], ring[next[j]])
  return true
}

/** Minimum-total-area triangulation of a (possibly warped) hole – Liepa's dynamic programme. */
function minAreaFill(w: Work, ring: number[], has: (a: number, b: number) => boolean, out: number[]) {
  const n = ring.length
  const p = w.verts
  const triArea = (i: number, j: number, k: number) => {
    const a = ring[i] * 3, b = ring[j] * 3, c = ring[k] * 3
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
  }
  const W = new Float64Array(n * n)
  const O = new Int32Array(n * n)
  const penalty = w.diag * w.diag * 10
  for (let gap = 2; gap < n; gap++) {
    for (let i = 0; i + gap < n; i++) {
      const j = i + gap
      let best = Infinity, bm = i + 1
      const diag = gap < n - 1 && has(ring[i], ring[j]) ? penalty : 0
      for (let m = i + 1; m < j; m++) {
        const c = W[i * n + m] + W[m * n + j] + triArea(i, m, j)
        if (c < best) {
          best = c
          bm = m
        }
      }
      W[i * n + j] = best + diag
      O[i * n + j] = bm
    }
  }
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [i, j] = stack.pop()!
    if (j - i < 2) continue
    const m = O[i * n + j]
    out.push(ring[i], ring[m], ring[j])
    stack.push([i, m], [m, j])
  }
}

/** Large warped holes: repeatedly clip the sharpest well-oriented corner. */
function greedyFill(w: Work, ring: number[], N: number[], out: number[]) {
  const p = w.verts
  const idx = ring.slice()
  while (idx.length > 3) {
    let best = 0, bestScore = -Infinity
    for (let t = 0; t < idx.length; t++) {
      const i = idx[(t + idx.length - 1) % idx.length] * 3, j = idx[t] * 3, k = idx[(t + 1) % idx.length] * 3
      const a = [p[i] - p[j], p[i + 1] - p[j + 1], p[i + 2] - p[j + 2]]
      const b = [p[k] - p[j], p[k + 1] - p[j + 1], p[k + 2] - p[j + 2]]
      const c = cross(b, a)
      const facing = c[0] * N[0] + c[1] * N[1] + c[2] * N[2]
      const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b) || 1)
      const score = cos + (facing > 0 ? 1 : -1)
      if (score > bestScore) {
        bestScore = score
        best = t
      }
    }
    out.push(idx[(best + idx.length - 1) % idx.length], idx[best], idx[(best + 1) % idx.length])
    idx.splice(best, 1)
  }
  out.push(idx[0], idx[1], idx[2])
}

/** Drops vertices no face uses; returns float32 positions + index. */
function finish(w: Work) {
  const map = new Int32Array(w.V).fill(-1)
  let V = 0
  for (let i = 0; i < w.tris.length; i++) if (map[w.tris[i]] < 0) map[w.tris[i]] = V++
  const verts = new Float64Array(V * 3)
  for (let v = 0; v < w.V; v++) if (map[v] >= 0) verts.set(w.verts.subarray(v * 3, v * 3 + 3), map[v] * 3)
  const tris = new Uint32Array(w.tris.length)
  for (let i = 0; i < tris.length; i++) tris[i] = map[w.tris[i]]
  w.verts = verts
  w.V = V
  w.tris = tris
}

// ------------------------------------------------------------------ repair
/** Runs a step and rolls it back if it leaves more naked / non-manifold edges than it found. */
function guarded<T>(w: Work, step: (w: Work) => T, fallback: T): T {
  const tris = w.tris.slice()
  const F = w.F
  const before = edgeDefects(w)
  const res = step(w)
  if (w.tris.length !== tris.length || w.tris.some((v, i) => v !== tris[i])) {
    if (edgeDefects(w) > before) {
      w.tris = tris
      w.F = F
      return fallback
    }
  }
  return res
}

export function repair(soup: Float32Array | Float64Array, opts: RepairOptions = DEFAULT_REPAIR, progress: Progress = () => {}): RepairResult {
  const log: string[] = []
  progress('Welding vertices', 0.02)
  const w = weld(soup)
  progress('Analysing', 0.08)
  const before = analyzeWork({ ...w, tris: w.tris.slice() }).report

  progress('Fixing degenerate faces', 0.25)
  const deg = fixDegenerates(w)
  if (deg.removed) log.push(`Removed ${deg.removed} degenerate faces` + (deg.split ? ` (${deg.split} neighbours split to stay sealed)` : ''))
  if (deg.collapsed) log.push(`Collapsed ${deg.collapsed} micro edges`)

  progress('Removing duplicate faces', 0.35)
  const dups = guarded(w, removeDuplicates, 0)
  if (dups) log.push(`Removed ${dups} duplicate faces`)

  if (opts.fixNormals || opts.removeInternal) {
    progress('Orienting normals', 0.45)
    const flipped = applyFlips(w, orientation(w, buildEdges(w.tris, w.F, w.V)))
    if (flipped && opts.fixNormals) log.push(`Flipped ${flipped} inverted faces`)
  }

  if (opts.removeInternal) {
    progress('Removing internal walls', 0.55)
    const internal = guarded(w, removeInternalSheets, 0)
    if (internal) log.push(`Removed ${internal} internal wall faces`)
  }

  if (opts.removeFragments) {
    progress('Removing loose fragments', 0.62)
    const frags = guarded(w, removeFragments, 0)
    if (frags) log.push(`Removed ${frags} loose fragment${frags > 1 ? 's' : ''}`)
  }

  if (opts.fillHoles) {
    progress('Filling holes', 0.7)
    // a filled hole can expose another rim (e.g. holes sharing a vertex) – go a few rounds
    let holes = 0, faces = 0
    for (let round = 0; round < 3; round++) {
      const r = fillHoles(w)
      if (!r.holes) break
      holes += r.holes
      faces += r.faces
    }
    if (holes) {
      log.push(`Filled ${holes} hole${holes > 1 ? 's' : ''} with ${faces} faces`)
      progress('Cleaning up', 0.85)
      const post = fixDegenerates(w)
      if (post.removed) log.push(`Cleaned up ${post.removed} slivers left by hole filling`)
    }
  }

  if (opts.fixNormals) {
    progress('Final orientation pass', 0.9)
    applyFlips(w, orientation(w, buildEdges(w.tris, w.F, w.V)))
  }

  finish(w)
  progress('Verifying', 0.95)
  const res = analyzeWork({ ...w, tris: w.tris.slice() })
  const positions = new Float32Array(w.verts)
  return { before, after: res.report, positions, index: w.tris, overlay: res.overlay, log }
}

/** @internal test hooks */
export const _internal = { weld, analyzeWork, fixDegenerates, removeDuplicates, fillHoles, buildEdges, isDegenerate, faceHeight }
