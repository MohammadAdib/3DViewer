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
