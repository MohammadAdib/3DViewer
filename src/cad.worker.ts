/// <reference lib="webworker" />
// Off-main-thread CAD tessellation (STEP / IGES / BREP) via OpenCascade compiled to WASM.
// The ~7 MB WASM is only fetched the first time a CAD file is opened.
import occtimportjs from 'occt-import-js'
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url'

export interface CadRequest {
  id: number
  ext: string
  buffer: ArrayBuffer
  quality: number // 0 (coarse) .. 1 (fine)
  countOnly?: boolean // reply with triangle/vertex totals instead of meshes
}

export interface CadMesh {
  name: string
  color: [number, number, number] | null
  position: Float32Array
  normal: Float32Array | null
  index: Uint32Array
  faces: { first: number; last: number; color: [number, number, number] | null }[]
}

export interface CadNode {
  name: string
  meshes: number[]
  children: CadNode[]
}

export interface CadCount {
  triangles: number
  vertices: number
}

export type CadResponse =
  | { id: number; ok: true; meshes: CadMesh[]; root: CadNode | null }
  | { id: number; ok: true; count: CadCount }
  | { id: number; ok: false; error: string }
  | { id: number; progress: string }

let occtPromise: Promise<any> | null = null

self.onmessage = async (e: MessageEvent<CadRequest>) => {
  const { id, ext, buffer, quality, countOnly } = e.data
  const post = (msg: CadResponse, transfer: Transferable[] = []) =>
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer)
  try {
    if (!occtPromise) {
      post({ id, progress: 'Loading CAD kernel…' })
      occtPromise = occtimportjs({ locateFile: () => wasmUrl })
    }
    const occt = await occtPromise
    post({ id, progress: 'Tessellating B-Rep…' })

    // quality 0..1 -> bounding box ratio 0.01 .. 0.0005
    const linearDeflection = 0.01 * Math.pow(0.05, quality)
    const params = {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection,
      angularDeflection: 0.5 - 0.35 * quality,
    }
    const data = new Uint8Array(buffer)
    const res =
      ext === 'igs' || ext === 'iges'
        ? occt.ReadIgesFile(data, params)
        : ext === 'brep' || ext === 'brp'
          ? occt.ReadBrepFile(data, params)
          : occt.ReadStepFile(data, params)

    if (!res || !res.success) throw new Error('OpenCascade could not read this file.')

    if (countOnly) {
      let triangles = 0
      let vertices = 0
      for (const m of res.meshes) {
        triangles += m.index.array.length / 3
        vertices += m.attributes.position.array.length / 3
      }
      return post({ id, ok: true, count: { triangles, vertices } })
    }

    const transfer: Transferable[] = []
    const meshes: CadMesh[] = res.meshes.map((m: any) => {
      const position = new Float32Array(m.attributes.position.array)
      const normal = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null
      const index = new Uint32Array(m.index.array)
      transfer.push(position.buffer, index.buffer)
      if (normal) transfer.push(normal.buffer)
      return {
        name: m.name ?? '',
        color: m.color ?? null,
        position,
        normal,
        index,
        faces: (m.brep_faces ?? []).map((f: any) => ({ first: f.first, last: f.last, color: f.color ?? null })),
      }
    })
    post({ id, ok: true, meshes, root: res.root ?? null }, transfer)
  } catch (err) {
    post({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
