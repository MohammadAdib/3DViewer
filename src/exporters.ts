import type * as THREE from 'three'

export type ExportFormat = 'stl' | 'stl-ascii' | 'obj' | 'glb' | 'gltf' | 'ply' | 'usdz'

export const EXPORTS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'stl', label: 'STL', hint: 'Binary · 3D printing' },
  { id: 'stl-ascii', label: 'STL ASCII', hint: 'Text · universal' },
  { id: 'obj', label: 'OBJ', hint: 'Wavefront · geometry' },
  { id: 'glb', label: 'GLB', hint: 'glTF binary · materials' },
  { id: 'gltf', label: 'glTF', hint: 'glTF JSON · embedded' },
  { id: 'ply', label: 'PLY', hint: 'Binary · vertex colors' },
  { id: 'usdz', label: 'USDZ', hint: 'Apple AR Quick Look' },
]

/**
 * Rough output size, for previews, of a mesh with `t` triangles and `v` vertices (normals, no UVs).
 * Binary STL is exact; text formats assume typical number lengths.
 */
export function estimateSize(fmt: ExportFormat, t: number, v: number) {
  const NUM = 12 // average JS number as text: long doubles mixed with round CAD values like "25" (measured)
  const NUM7 = 9 // USDZ writes toPrecision(7)
  const d = String(Math.max(1, Math.round(v))).length // digits in a vertex index
  switch (fmt) {
    case 'stl':
      return 84 + 50 * t
    case 'stl-ascii': // facet normal + outer loop + 3 vertex lines + endloop + endfacet
      return 32 + t * (77 + 4 * (3 * NUM + 3))
    case 'obj': // "v x y z" + "vn x y z" per vertex, "f a//a b//b c//c" per triangle
      return v * (6 * NUM + 11) + t * (6 * d + 11)
    case 'ply': // float32 position + normal, uchar count + 3 int32 indices
      return 300 + 24 * v + 13 * t
    case 'glb':
      return 2048 + 24 * v + 12 * t
    case 'gltf': // same buffers, base64-embedded
      return 2048 + Math.ceil(((24 * v + 12 * t) * 4) / 3)
    case 'usdz': // text points + normals, then face indices and counts
      return 4096 + v * 2 * (3 * NUM7 + 6) + t * (3 * (d + 2) + 3)
  }
}

export async function exportObject(obj: THREE.Object3D, fmt: ExportFormat, baseName: string) {
  obj.updateMatrixWorld(true)
  let data: BlobPart
  let ext: string
  let mime = 'application/octet-stream'
  switch (fmt) {
    case 'stl':
    case 'stl-ascii': {
      const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js')
      const binary = fmt === 'stl'
      const out = new STLExporter().parse(obj, { binary } as any)
      data = binary ? ((out as unknown as DataView).buffer as ArrayBuffer) : (out as unknown as string)
      ext = 'stl'
      break
    }
    case 'obj': {
      const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js')
      data = new OBJExporter().parse(obj)
      ext = 'obj'
      mime = 'text/plain'
      break
    }
    case 'glb':
    case 'gltf': {
      const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
      const binary = fmt === 'glb'
      const out = await new GLTFExporter().parseAsync(obj, { binary, onlyVisible: true })
      data = binary ? (out as ArrayBuffer) : JSON.stringify(out)
      ext = fmt
      mime = binary ? 'model/gltf-binary' : 'model/gltf+json'
      break
    }
    case 'ply': {
      const { PLYExporter } = await import('three/examples/jsm/exporters/PLYExporter.js')
      data = await new Promise<ArrayBuffer>((res) =>
        new PLYExporter().parse(obj, (r) => res(r as ArrayBuffer), { binary: true } as any),
      )
      ext = 'ply'
      break
    }
    case 'usdz': {
      const { USDZExporter } = await import('three/examples/jsm/exporters/USDZExporter.js')
      const out = await new USDZExporter().parseAsync(obj)
      data = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
      ext = 'usdz'
      mime = 'model/vnd.usdz+zip'
      break
    }
  }
  download(new Blob([data], { type: mime }), `${baseName}.${ext}`)
}

export function download(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}
