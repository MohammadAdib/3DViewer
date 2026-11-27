import * as THREE from 'three'
import type { CadRequest, CadResponse, CadNode } from './cad.worker'

export type UpAxis = 'y' | 'z'

// Neutral Blender-style gray for models that carry no color of their own.
export const DEFAULT_COLOR = 0xcccccc

export interface LoadedModel {
  object: THREE.Object3D
  name: string
  format: string
  upAxis: UpAxis
  animations: THREE.AnimationClip[]
  bytes: number
}

export type Progress = (msg: string) => void

export const FORMATS: Record<string, { label: string; up: UpAxis; cad?: boolean }> = {
  stl: { label: 'STL', up: 'z' },
  step: { label: 'STEP', up: 'z', cad: true },
  stp: { label: 'STEP', up: 'z', cad: true },
  iges: { label: 'IGES', up: 'z', cad: true },
  igs: { label: 'IGES', up: 'z', cad: true },
  brep: { label: 'BREP', up: 'z', cad: true },
  brp: { label: 'BREP', up: 'z', cad: true },
  glb: { label: 'glTF', up: 'y' },
  gltf: { label: 'glTF', up: 'y' },
  obj: { label: 'OBJ', up: 'y' },
  fbx: { label: 'FBX', up: 'y' },
  '3mf': { label: '3MF', up: 'y' }, // loader already converts Z-up
  ply: { label: 'PLY', up: 'z' },
  dae: { label: 'Collada', up: 'y' },
  '3ds': { label: '3DS', up: 'z' },
  amf: { label: 'AMF', up: 'z' },
  wrl: { label: 'VRML', up: 'y' },
  vrml: { label: 'VRML', up: 'y' },
  usdz: { label: 'USDZ', up: 'y' },
  usda: { label: 'USD', up: 'y' },
  usdc: { label: 'USD', up: 'y' },
  usd: { label: 'USD', up: 'y' },
  pcd: { label: 'PCD', up: 'z' },
}

export const ACCEPT = [
  ...Object.keys(FORMATS).map((e) => '.' + e),
  '.mtl', '.bin', '.png', '.jpg', '.jpeg', '.webp', '.ktx2', '.tga',
].join(',')

export const extOf = (name: string) => name.toLowerCase().split('.').pop() ?? ''
const baseName = (url: string) => {
  try {
    url = decodeURIComponent(url)
  } catch { /* keep raw */ }
  return url.split(/[\\/]/).pop()!.split('?')[0].toLowerCase()
}

/** Loads a set of files (main model + optional sidecar resources: .mtl, .bin, textures). */
export async function loadFiles(files: File[], onProgress: Progress, cadQuality = 0.5): Promise<LoadedModel> {
  const primary = files.find((f) => extOf(f.name) in FORMATS)
  if (!primary) {
    const exts = [...new Set(files.map((f) => '.' + extOf(f.name)))].join(', ')
    throw new Error(`Unsupported file type (${exts}).`)
  }
  const ext = extOf(primary.name)

  // Map sidecar files by basename so references like "textures/wood.png" resolve to dropped files.
  const blobUrls = new Map<string, string>()
  for (const f of files) if (f !== primary) blobUrls.set(f.name.toLowerCase(), URL.createObjectURL(f))
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url
    return blobUrls.get(baseName(url)) ?? url
  })

  try {
    onProgress(`Reading ${primary.name}…`)
    const buffer = await primary.arrayBuffer()
    onProgress(`Parsing ${FORMATS[ext].label}…`)
    const { object, animations } = await parse(ext, buffer, manager, files, onProgress, cadQuality)
    object.name ||= primary.name
    return {
      object,
      name: primary.name,
      format: FORMATS[ext].label,
      upAxis: FORMATS[ext].up,
      animations,
      bytes: files.reduce((s, f) => s + f.size, 0),
    }
  } finally {
    // Textures are decoded asynchronously; give them a moment before revoking.
    setTimeout(() => blobUrls.forEach((u) => URL.revokeObjectURL(u)), 30_000)
  }
}

const text = (buf: ArrayBuffer) => new TextDecoder().decode(buf)

function meshFromGeometry(geometry: THREE.BufferGeometry, allowPoints = false): THREE.Object3D {
  const hasColor = !!geometry.attributes.color
  const isPoints = allowPoints && !geometry.index
  if (isPoints) {
    const pts = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: hasColor }))
    return pts
  }
  if (!geometry.attributes.normal) geometry.computeVertexNormals()
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: hasColor ? 0xffffff : DEFAULT_COLOR, vertexColors: hasColor, metalness: 0.1, roughness: 0.5 }),
  )
  return mesh
}

async function parse(
  ext: string,
  buffer: ArrayBuffer,
  manager: THREE.LoadingManager,
  files: File[],
  onProgress: Progress,
  cadQuality: number,
): Promise<{ object: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  const none: THREE.AnimationClip[] = []
  switch (ext) {
    case 'stl': {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js')
      const geom = new STLLoader().parse(buffer)
      // Some exporters write zero (or garbage) facet normals, which renders black. Derive them from the winding.
      const nrm = geom.attributes.normal
      if (nrm) {
        let bad = 0
        const step = Math.max(1, Math.floor(nrm.count / 2000))
        for (let i = 0; i < nrm.count; i += step) if (Math.abs(Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) - 1) > 0.01) bad++
        if (bad > nrm.count / step / 100) geom.computeVertexNormals()
      }
      const mesh = meshFromGeometry(geom) as THREE.Mesh
      // Binary STL with per-face colours
      const anyGeom = geom as any
      if (anyGeom.hasColors) (mesh.material as THREE.MeshStandardMaterial).vertexColors = true
      return { object: mesh, animations: none }
    }
    case 'glb':
    case 'gltf': {
      const [{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }, { MeshoptDecoder }] = await Promise.all([
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('three/examples/jsm/loaders/DRACOLoader.js'),
        import('three/examples/jsm/loaders/KTX2Loader.js'),
        import('three/examples/jsm/libs/meshopt_decoder.module.js'),
      ])
      // three.js bundles its own Draco / Basis decoders (served same-origin, cached offline)
      const loader = new GLTFLoader(manager)
      loader.setDRACOLoader(new DRACOLoader())
      const ktx2 = new KTX2Loader()
      ktx2.detectSupport(sharedRenderer!)
      loader.setKTX2Loader(ktx2)
      loader.setMeshoptDecoder(MeshoptDecoder)
      const gltf = await loader.parseAsync(buffer, '')
      return { object: gltf.scene, animations: gltf.animations }
    }
    case 'obj': {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js')
      const loader = new OBJLoader(manager)
      const mtlFile = files.find((f) => extOf(f.name) === 'mtl')
      if (mtlFile) {
        const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js')
        const materials = new MTLLoader(manager).parse(await mtlFile.text(), '')
        materials.preload()
        loader.setMaterials(materials)
      }
      const obj = loader.parse(text(buffer))
      if (!mtlFile) {
        obj.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            const m = o as THREE.Mesh
            m.material = new THREE.MeshStandardMaterial({ color: DEFAULT_COLOR, metalness: 0.1, roughness: 0.5 })
          }
        })
      }
      return { object: obj, animations: none }
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
      const obj = new FBXLoader(manager).parse(buffer, '')
      return { object: obj, animations: obj.animations }
    }
    case '3mf': {
      const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js')
      return { object: new ThreeMFLoader(manager).parse(buffer), animations: none }
    }
    case 'ply': {
      const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js')
      return { object: meshFromGeometry(new PLYLoader(manager).parse(buffer), true), animations: none }
    }
    case 'dae': {
      const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js')
      const res = new ColladaLoader(manager).parse(text(buffer), '')
      return { object: res!.scene, animations: res!.scene.animations ?? none }
    }
    case '3ds': {
      const { TDSLoader } = await import('three/examples/jsm/loaders/TDSLoader.js')
      return { object: new TDSLoader(manager).parse(buffer, ''), animations: none }
    }
    case 'amf': {
      const { AMFLoader } = await import('three/examples/jsm/loaders/AMFLoader.js')
      return { object: new AMFLoader(manager).parse(buffer), animations: none }
    }
    case 'wrl':
    case 'vrml': {
      const { VRMLLoader } = await import('three/examples/jsm/loaders/VRMLLoader.js')
      return { object: new VRMLLoader(manager).parse(text(buffer), ''), animations: none }
    }
    case 'usd':
    case 'usda':
    case 'usdc':
    case 'usdz': {
      const { USDLoader } = await import('three/examples/jsm/loaders/USDLoader.js')
      return { object: new USDLoader(manager).parse(buffer), animations: none }
    }
    case 'pcd': {
      const { PCDLoader } = await import('three/examples/jsm/loaders/PCDLoader.js')
      const pts = new PCDLoader(manager).parse(buffer)
      ;(pts.material as THREE.PointsMaterial).sizeAttenuation = false
      ;(pts.material as THREE.PointsMaterial).size = 2
      return { object: pts, animations: none }
    }
    case 'step':
    case 'stp':
    case 'iges':
    case 'igs':
    case 'brep':
    case 'brp':
      return { object: await parseCad(ext, buffer, onProgress, cadQuality), animations: none }
  }
  throw new Error(`No loader for .${ext}`)
}

/** Needed by KTX2Loader to pick a supported GPU texture format. */
let sharedRenderer: THREE.WebGLRenderer | null = null
export const setLoaderRenderer = (r: THREE.WebGLRenderer) => (sharedRenderer = r)

// ---------------------------------------------------------------- CAD (worker)
let worker: Worker | null = null
let reqId = 0

async function parseCad(ext: string, buffer: ArrayBuffer, onProgress: Progress, quality: number): Promise<THREE.Object3D> {
  worker ??= new Worker(new URL('./cad.worker.ts', import.meta.url), { type: 'module' })
  const id = ++reqId
  const w = worker
  const res = await new Promise<Extract<CadResponse, { ok: true }>>((resolve, reject) => {
    const onMsg = (e: MessageEvent<CadResponse>) => {
      const m = e.data
      if (m.id !== id) return
      if ('progress' in m) return onProgress(m.progress)
      w.removeEventListener('message', onMsg)
      w.removeEventListener('error', onErr)
      m.ok ? resolve(m) : reject(new Error(m.error))
    }
    const onErr = (e: ErrorEvent) => {
      w.removeEventListener('message', onMsg)
      worker = null
      w.terminate()
      reject(new Error(e.message || 'CAD worker crashed (file may be too large).'))
    }
    w.addEventListener('message', onMsg)
    w.addEventListener('error', onErr)
    w.postMessage({ id, ext, buffer, quality } satisfies CadRequest, [buffer])
  })

  onProgress('Building meshes…')
  const meshes = res.meshes.map((m, i) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(m.position, 3))
    if (m.normal) g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3))
    else g.computeVertexNormals()
    g.setIndex(new THREE.BufferAttribute(m.index, 1))

    const base = m.color ? new THREE.Color().setRGB(...m.color, THREE.SRGBColorSpace) : new THREE.Color(DEFAULT_COLOR)
    const mat = () => new THREE.MeshStandardMaterial({ color: base, metalness: 0.15, roughness: 0.45 })
    const faceColored = m.faces.some((f) => f.color)
    let material: THREE.Material | THREE.Material[] = mat()
    if (faceColored) {
      // Per-face colours → geometry groups with a material per distinct colour.
      const mats: THREE.MeshStandardMaterial[] = []
      const key = new Map<string, number>()
      for (const f of m.faces) {
        const c = f.color ?? m.color
        const k = c ? c.join(',') : 'default'
        let mi = key.get(k)
        if (mi === undefined) {
          mi = mats.length
          key.set(k, mi)
          const mm = mat()
          if (c) mm.color.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace)
          mats.push(mm)
        }
        g.addGroup(f.first * 3, (f.last - f.first + 1) * 3, mi)
      }
      material = mats
    }
    const mesh = new THREE.Mesh(g, material)
    mesh.name = m.name || `Part ${i + 1}`
    return mesh
  })

  const build = (node: CadNode): THREE.Object3D => {
    const group = new THREE.Group()
    group.name = node.name
    for (const mi of node.meshes) if (meshes[mi]) group.add(meshes[mi])
    for (const c of node.children) group.add(build(c))
    return group
  }
  if (res.root) return build(res.root)
  const g = new THREE.Group()
  meshes.forEach((m) => g.add(m))
  return g
}

// ---------------------------------------------------------------- Demo model
export function createDemoModel(): LoadedModel {
  const group = new THREE.Group()
  group.name = 'Demo'
  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1, 0.32, 400, 64, 2, 3),
    new THREE.MeshPhysicalMaterial({ color: 0x7dd3fc, metalness: 0.2, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1 }),
  )
  knot.name = 'Torus Knot'
  knot.position.y = 1.55
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.35, 1.5, 0.22, 96),
    new THREE.MeshStandardMaterial({ color: 0x1f2433, metalness: 0.8, roughness: 0.35 }),
  )
  base.name = 'Pedestal'
  base.position.y = 0.11
  group.add(knot, base)
  return { object: group, name: 'demo.glb', format: 'Demo', upAxis: 'y', animations: [], bytes: 0 }
}
