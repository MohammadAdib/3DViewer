import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper.js'
import type { LoadedModel, UpAxis } from './loaders'
import { setLoaderRenderer } from './loaders'
import { download, exportObject } from './exporters'
import type { ExportFormat } from './exporters'

// ------------------------------------------------------------------ settings
export type EnvId = 'studio' | 'lightbox' | 'soft' | 'sunset' | 'neon' | 'night'
export type MaterialMode = 'original' | 'custom' | 'normals' | 'xray'
export type BgMode = 'gradient' | 'env' | 'solid' | 'transparent'
export type ToneMap = 'aces' | 'agx' | 'neutral' | 'none'
export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso'

export interface Settings {
  env: EnvId
  envIntensity: number
  envRotation: number
  background: BgMode
  bgColor: string
  keyIntensity: number
  keyColor: string
  keyAzimuth: number
  keyElevation: number
  ambient: number
  exposure: number
  toneMapping: ToneMap
  shadows: boolean
  grid: boolean
  materialMode: MaterialMode
  color: string
  metalness: number
  roughness: number
  clearcoat: number
  transmission: number
  wireframe: boolean
  edges: boolean
  edgeColor: string
  flatShading: boolean
  doubleSided: boolean
  autoRotate: boolean
  autoRotateSpeed: number
  section: 'off' | 'x' | 'y' | 'z'
  sectionPos: number
  sectionFlip: boolean
  projection: 'perspective' | 'orthographic'
  fov: number
  upAxis: 'auto' | UpAxis
  /** Part rotation in degrees, about the file's own X/Y/Z axes. Applied on export too. */
  rotX: number
  rotY: number
  rotZ: number
  cadQuality: number
}

export const DEFAULTS: Settings = {
  env: 'studio',
  envIntensity: 1,
  envRotation: 0,
  background: 'gradient',
  bgColor: '#15171f',
  keyIntensity: 2.2,
  keyColor: '#ffffff',
  keyAzimuth: 35,
  keyElevation: 55,
  ambient: 0.35,
  exposure: 0.5,
  toneMapping: 'agx',
  shadows: true,
  grid: true,
  materialMode: 'original',
  color: '#cccccc',
  metalness: 0.1,
  roughness: 0.35,
  clearcoat: 0.3,
  transmission: 0,
  wireframe: false,
  edges: false,
  edgeColor: '#0b0d12',
  flatShading: false,
  doubleSided: false,
  autoRotate: false,
  autoRotateSpeed: 1.5,
  section: 'off',
  sectionPos: 0.5,
  sectionFlip: false,
  projection: 'perspective',
  fov: 40,
  upAxis: 'auto',
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  cadQuality: 0.5,
}

interface EnvDef {
  label: string
  bg: [string, string] // radial gradient inner, outer
  build?: () => THREE.Scene
}

// ------------------------------------------------------------- environments
function gradientDome(top: string, horizon: string, bottom: string) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(50, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(top) },
        horizon: { value: new THREE.Color(horizon) },
        bottom: { value: new THREE.Color(bottom) },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; varying vec3 vDir;
        void main(){ float h = vDir.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.6)) : mix(horizon, bottom, pow(-h, 0.4)); gl_FragColor = vec4(c, 1.0); }`,
    }),
  )
}

function panel(scene: THREE.Scene, color: string, intensity: number, w: number, h: number, pos: [number, number, number]) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }),
  )
  m.position.set(...pos)
  m.lookAt(0, 0, 0)
  scene.add(m)
}

export const ENVS: Record<EnvId, EnvDef> = {
  studio: { label: 'Studio', bg: ['#2a2f3d', '#0b0c11'] },
  lightbox: {
    label: 'Lightbox',
    bg: ['#f4f6fa', '#c9ced8'],
    build: () => {
      const s = new THREE.Scene()
      s.add(gradientDome('#ffffff', '#e9edf3', '#b8bec9'))
      panel(s, '#ffffff', 5, 30, 8, [0, 20, 0])
      panel(s, '#ffffff', 3, 8, 30, [-20, 6, 4])
      panel(s, '#ffffff', 3, 8, 30, [20, 6, 4])
      panel(s, '#ffffff', 2, 30, 10, [0, 6, 20])
      return s
    },
  },
  soft: {
    label: 'Overcast',
    bg: ['#4b5566', '#171a21'],
    build: () => {
      const s = new THREE.Scene()
      s.add(gradientDome('#d9e2ef', '#8b97a8', '#2c313b'))
      panel(s, '#ffffff', 2.5, 40, 40, [0, 25, 0])
      return s
    },
  },
  sunset: {
    label: 'Sunset',
    bg: ['#5a2f3a', '#140b14'],
    build: () => {
      const s = new THREE.Scene()
      s.add(gradientDome('#2b2350', '#ff8a4c', '#1a1018'))
      panel(s, '#ffb36b', 30, 6, 4, [24, 5, -20])
      panel(s, '#6f7cff', 1.5, 30, 30, [-15, 25, 15])
      return s
    },
  },
  neon: {
    label: 'Neon',
    bg: ['#24123a', '#07050d'],
    build: () => {
      const s = new THREE.Scene()
      s.add(gradientDome('#0b0820', '#120a24', '#030208'))
      panel(s, '#ff2bd6', 10, 4, 30, [-22, 4, 6])
      panel(s, '#18e1ff', 10, 4, 30, [22, 4, -6])
      panel(s, '#7b5cff', 4, 24, 4, [0, 22, -10])
      return s
    },
  },
  night: {
    label: 'Moonlight',
    bg: ['#18223a', '#05070d'],
    build: () => {
      const s = new THREE.Scene()
      s.add(gradientDome('#0b1224', '#1a2440', '#030409'))
      panel(s, '#cfe0ff', 25, 3, 3, [-15, 22, -15])
      panel(s, '#3a5aa8', 1.5, 40, 12, [0, 4, 25])
      return s
    },
  },
}

const TONE: Record<ToneMap, THREE.ToneMapping> = {
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
  none: THREE.NoToneMapping,
}

export type Rotation = Pick<Settings, 'rotX' | 'rotY' | 'rotZ'>

/**
 * Turns a part rotation a further `deg` about one of the file's fixed axes, so a flip always spins
 * about that axis no matter how the part is already rotated (unlike bumping a single Euler angle).
 */
export function turnRotation(r: Rotation, axis: 'x' | 'y' | 'z', deg: number): Rotation {
  const { degToRad, radToDeg } = THREE.MathUtils
  const current = new THREE.Quaternion().setFromEuler(new THREE.Euler(degToRad(r.rotX), degToRad(r.rotY), degToRad(r.rotZ)))
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().setComponent('xyz'.indexOf(axis), 1), degToRad(deg))
  const e = new THREE.Euler().setFromQuaternion(turn.multiply(current))
  // Round away float noise (89.9999… → 90) and avoid showing "-0°".
  const clean = (rad: number) => Math.round(radToDeg(rad) * 100) / 100 || 0
  return { rotX: clean(e.x), rotY: clean(e.y), rotZ: clean(e.z) }
}

export interface Stats {
  meshes: number
  triangles: number
  vertices: number
  materials: number
  size: THREE.Vector3
}

export interface Part {
  id: number
  name: string
  object: THREE.Object3D
}

// ------------------------------------------------------------------- viewer
export class Viewer {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  private persp: THREE.PerspectiveCamera
  private ortho: THREE.OrthographicCamera
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
  readonly controls: OrbitControls
  private viewHelper: ViewHelper
  private pmrem: THREE.PMREMGenerator
  private envCache = new Map<EnvId, THREE.Texture>()

  private hemi = new THREE.HemisphereLight(0xffffff, 0x444455, 0.35)
  private key = new THREE.DirectionalLight(0xffffff, 2)
  private ground: THREE.Mesh
  private grid: THREE.GridHelper | null = null
  private clipPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)

  private modelRoot = new THREE.Group() // centering offset
  private upGroup = new THREE.Group() // Z-up → Y-up rotation
  private rotGroup = new THREE.Group() // user rotation, in the file's own axes
  model: LoadedModel | null = null
  private originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
  private edgeLines: THREE.LineSegments[] = []
  private customMat = new THREE.MeshPhysicalMaterial()
  private normalMat = new THREE.MeshNormalMaterial()
  private xrayMat: THREE.ShaderMaterial
  private edgeMat = new THREE.LineBasicMaterial({ color: 0x000000 })
  private mixer: THREE.AnimationMixer | null = null
  private action: THREE.AnimationAction | null = null

  radius = 1
  center = new THREE.Vector3()
  private bounds = new THREE.Box3()
  s: Settings = { ...DEFAULTS }
  private matKey = ''
  private needsRender = true
  private clock = new THREE.Clock()
  private tween: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t: number; dur: number } | null = null
  private hideHelper = false
  onChange: () => void = () => {}
  onError: (msg: string) => void = () => {}

  // measuring
  measuring = false
  private measurePts: THREE.Vector3[] = []
  private measureGroup = new THREE.Group()
  private measureLabel: HTMLDivElement
  onMeasure: (d: number | null) => void = () => {}

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.localClippingEnabled = true
    this.renderer.autoClear = false
    container.appendChild(this.renderer.domElement)
    setLoaderRenderer(this.renderer)

    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    this.persp = new THREE.PerspectiveCamera(40, 1, 0.01, 1000)
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000)
    this.camera = this.persp
    this.persp.position.set(3, 2, 4)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.screenSpacePanning = true
    this.controls.addEventListener('change', () => this.invalidate())

    this.viewHelper = new ViewHelper(this.camera, this.renderer.domElement)
    this.viewHelper.location = { top: null, right: 0, bottom: 0, left: 0 }
    this.viewHelper.setLabels('X', 'Y', 'Z')

    this.key.castShadow = true
    this.key.shadow.mapSize.set(2048, 2048)
    this.key.shadow.radius = 4
    this.scene.add(this.hemi, this.key, this.key.target)

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.32 }))
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    this.scene.add(this.ground)

    this.rotGroup.add(new THREE.Object3D())
    this.upGroup.add(this.rotGroup)
    this.modelRoot.add(this.upGroup)
    this.scene.add(this.modelRoot, this.measureGroup)

    this.xrayMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color('#5ad8ff') } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      clipping: true,
      vertexShader: /* glsl */ `
        #include <common>
        #include <clipping_planes_pars_vertex>
        varying vec3 vN; varying vec3 vV;
        void main() {
          #include <begin_vertex>
          #include <project_vertex>
          #include <clipping_planes_vertex>
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mvPosition.xyz);
        }`,
      fragmentShader: /* glsl */ `
        #include <clipping_planes_pars_fragment>
        uniform vec3 color; varying vec3 vN; varying vec3 vV;
        void main() {
          #include <clipping_planes_fragment>
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
          gl_FragColor = vec4(color * (0.06 + f * 1.1), 1.0);
        }`,
    })

    this.measureLabel = document.createElement('div')
    this.measureLabel.className = 'measure-label'
    this.measureLabel.hidden = true
    container.appendChild(this.measureLabel)

    this.bindPointer()
    new ResizeObserver(() => this.resize()).observe(container)
    this.layoutStage()
    this.resize()
    this.renderer.setAnimationLoop(() => this.loop())
  }

  // ---------------------------------------------------------------- loop
  invalidate() {
    this.needsRender = true
  }

  private loop() {
    const dt = this.clock.getDelta()
    let active = false
    if (this.tween) {
      const tw = this.tween
      tw.t = Math.min(1, tw.t + dt / tw.dur)
      const k = 1 - Math.pow(1 - tw.t, 3)
      this.camera.position.lerpVectors(tw.from[0], tw.to[0], k)
      this.controls.target.lerpVectors(tw.from[1], tw.to[1], k)
      if (tw.t >= 1) this.tween = null
      if (this.camera === this.ortho) this.updateOrthoFrustum()
      active = true
    }
    if (this.viewHelper.animating) {
      this.viewHelper.update(dt)
      if (!this.viewHelper.animating) this.controls.update()
      active = true
    } else if (this.controls.update() || this.s.autoRotate) {
      active = true
    }
    if (this.mixer && this.action && !this.action.paused) {
      this.mixer.update(dt)
      active = true
    }
    if (active || this.needsRender) this.render()
  }

  render() {
    this.needsRender = false
    const r = this.renderer
    r.clear()
    r.render(this.scene, this.camera)
    if (!this.hideHelper && this.model) this.viewHelper.render(r)
    this.updateMeasureLabel()
  }

  private resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.persp.aspect = w / h
    this.persp.updateProjectionMatrix()
    this.updateOrthoFrustum()
    this.invalidate()
  }

  private updateOrthoFrustum() {
    const aspect = this.persp.aspect
    const dist = this.camera.position.distanceTo(this.controls?.target ?? new THREE.Vector3())
    const h = dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2))
    this.ortho.left = -h * aspect
    this.ortho.right = h * aspect
    this.ortho.top = h
    this.ortho.bottom = -h
    this.ortho.updateProjectionMatrix()
  }

  // --------------------------------------------------------------- model
  setModel(model: LoadedModel) {
    this.clearModel()
    this.model = model
    const content = model.object
    content.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.castShadow = true
        m.receiveShadow = true
        this.originals.set(m, m.material)
      }
    })
    this.rotGroup.clear()
    this.rotGroup.add(content)
    if (model.animations.length) {
      this.mixer = new THREE.AnimationMixer(content)
      this.action = this.mixer.clipAction(model.animations[0])
      this.action.play()
    }
    this.matKey = ''
    this.applyOrientation()
    this.apply(this.s)
    this.fit(false)
  }

  private clearModel() {
    this.removeEdges()
    this.clearMeasure()
    this.mixer?.stopAllAction()
    this.mixer = null
    this.action = null
    const old = this.model?.object
    if (old) {
      old.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh || (o as THREE.Points).isPoints) {
          m.geometry?.dispose()
          const mats = this.originals.get(m) ?? m.material
          for (const mat of Array.isArray(mats) ? mats : [mats]) {
            if (!mat) continue
            for (const v of Object.values(mat)) if ((v as THREE.Texture)?.isTexture) (v as THREE.Texture).dispose()
            mat.dispose()
          }
        }
      })
    }
    this.originals.clear()
    this.model = null
  }

  get effectiveUp(): UpAxis {
    return this.s.upAxis === 'auto' ? (this.model?.upAxis ?? 'y') : this.s.upAxis
  }

  private applyOrientation() {
    const s = this.s
    const rad = THREE.MathUtils.degToRad
    this.upGroup.rotation.set(this.effectiveUp === 'z' ? -Math.PI / 2 : 0, 0, 0)
    this.rotGroup.rotation.set(rad(s.rotX), rad(s.rotY), rad(s.rotZ))
    this.modelRoot.position.set(0, 0, 0)
    this.modelRoot.updateMatrixWorld(true)
    // Off-axis angles make the cheap (transformed bounding box) estimate loose, so the part would float.
    const precise = [s.rotX, s.rotY, s.rotZ].some((a) => a % 90 !== 0)
    const box = new THREE.Box3().setFromObject(this.upGroup, precise)
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))
    const c = box.getCenter(new THREE.Vector3())
    // centre on X/Z, sit on the ground plane
    this.modelRoot.position.set(-c.x, -box.min.y, -c.z)
    this.modelRoot.updateMatrixWorld(true)
    this.bounds.setFromObject(this.modelRoot)
    const sphere = this.bounds.getBoundingSphere(new THREE.Sphere())
    this.radius = Math.max(sphere.radius, 1e-6)
    this.center.copy(sphere.center)
    this.layoutStage()
    this.clearMeasure()
  }

  /** Sizes ground, grid, shadow camera & clip range to the model. */
  private layoutStage() {
    const r = this.radius
    this.ground.scale.setScalar(r * 40)
    this.ground.position.y = 0
    const sc = this.key.shadow.camera
    sc.left = sc.bottom = -r * 1.6
    sc.right = sc.top = r * 1.6
    sc.near = r * 0.1
    sc.far = r * 10
    sc.updateProjectionMatrix()
    this.key.shadow.bias = -0.0004
    this.key.shadow.normalBias = r * 0.004
    this.key.target.position.copy(this.center)

    if (this.grid) {
      this.scene.remove(this.grid)
      this.grid.dispose()
    }
    const step = Math.pow(10, Math.floor(Math.log10(r * 0.6)))
    const divisions = 40
    this.grid = new THREE.GridHelper(step * divisions, divisions, 0x7f8aa3, 0x3a4255)
    const gm = this.grid.material as THREE.Material
    gm.transparent = true
    gm.opacity = 0.45
    gm.depthWrite = false
    this.grid.position.y = r * 0.0005
    this.scene.add(this.grid)
    this.gridStep = step

    this.persp.near = r / 200
    this.persp.far = r * 200
    this.persp.updateProjectionMatrix()
    this.ortho.near = -r * 100
    this.ortho.far = r * 200
    this.ortho.updateProjectionMatrix()
    this.controls.minDistance = r * 0.02
    this.controls.maxDistance = r * 50
  }
  gridStep = 1

  // ------------------------------------------------------------- settings
  apply(next: Partial<Settings>) {
    const prev = this.s
    this.s = { ...this.s, ...next }
    const s = this.s
    const r = this.renderer

    if (this.model) {
      const upChanged = s.upAxis !== prev.upAxis
      if (upChanged || s.rotX !== prev.rotX || s.rotY !== prev.rotY || s.rotZ !== prev.rotZ) this.applyOrientation()
      if (upChanged) this.fit(true)
    }

    // environment
    this.scene.environment = this.getEnv(s.env)
    this.scene.environmentIntensity = s.envIntensity
    this.scene.environmentRotation.set(0, THREE.MathUtils.degToRad(s.envRotation), 0)
    this.scene.backgroundRotation.copy(this.scene.environmentRotation)

    // background
    this.scene.background = null
    r.setClearColor(0x000000, 0)
    if (s.background === 'env') {
      this.scene.background = this.scene.environment
      this.scene.backgroundBlurriness = 0.35
      this.scene.backgroundIntensity = s.envIntensity
    } else if (s.background === 'solid') {
      r.setClearColor(new THREE.Color(s.bgColor), 1)
    }

    r.toneMapping = TONE[s.toneMapping]
    r.toneMappingExposure = s.exposure

    // lights
    this.hemi.intensity = s.ambient
    this.key.intensity = s.keyIntensity
    this.key.color.set(s.keyColor)
    const az = THREE.MathUtils.degToRad(s.keyAzimuth)
    const el = THREE.MathUtils.degToRad(s.keyElevation)
    const d = this.radius * 4
    this.key.position.set(
      this.center.x + d * Math.cos(el) * Math.sin(az),
      this.center.y + d * Math.sin(el),
      this.center.z + d * Math.cos(el) * Math.cos(az),
    )
    this.key.castShadow = s.shadows
    this.ground.visible = s.shadows && s.background !== 'env'
    if (this.grid) this.grid.visible = s.grid

    // camera
    this.controls.autoRotate = s.autoRotate
    this.controls.autoRotateSpeed = s.autoRotateSpeed
    if (this.persp.fov !== s.fov) {
      this.persp.fov = s.fov
      this.persp.updateProjectionMatrix()
    }
    if ((s.projection === 'orthographic') !== (this.camera === this.ortho)) this.setProjection(s.projection)

    // section plane
    this.updateClipPlane()

    // materials
    const key = [s.materialMode, s.color, s.metalness, s.roughness, s.clearcoat, s.transmission, s.wireframe, s.flatShading, s.doubleSided, s.section].join('|')
    if (key !== this.matKey) {
      this.matKey = key
      this.applyMaterials()
    }
    this.edgeMat.color.set(s.edgeColor)
    if (s.edges && !this.edgeLines.length) {
      try {
        this.buildEdges()
      } catch (e) {
        this.onError((e as Error).message)
      }
    }
    if (!s.edges && this.edgeLines.length) this.removeEdges()

    this.invalidate()
    this.onChange()
  }

  private getEnv(id: EnvId) {
    let tex = this.envCache.get(id)
    if (!tex) {
      const def = ENVS[id]
      const scene = def.build ? def.build() : new RoomEnvironment()
      tex = this.pmrem.fromScene(scene, 0.035).texture
      this.envCache.set(id, tex)
    }
    return tex
  }

  private updateClipPlane() {
    const s = this.s
    if (s.section === 'off') return
    const axis = { x: 0, y: 1, z: 2 }[s.section]
    const n = new THREE.Vector3().setComponent(axis, s.sectionFlip ? 1 : -1)
    const min = this.bounds.min.getComponent(axis)
    const max = this.bounds.max.getComponent(axis)
    const pos = min + (max - min) * s.sectionPos
    this.clipPlane.normal.copy(n)
    this.clipPlane.constant = s.sectionFlip ? -pos : pos
  }

  private applyMaterials() {
    const s = this.s
    const planes = s.section !== 'off' ? [this.clipPlane] : null
    const cm = this.customMat
    cm.color.set(s.color)
    cm.metalness = s.metalness
    cm.roughness = s.roughness
    cm.clearcoat = s.clearcoat
    cm.clearcoatRoughness = 0.08
    cm.transmission = s.transmission
    cm.thickness = this.radius * 0.2
    cm.ior = 1.5

    const touched = new Set<THREE.Material>()
    const tune = (mat: THREE.Material) => {
      if (touched.has(mat)) return
      touched.add(mat)
      mat.userData.origSide ??= mat.side
      mat.side = s.doubleSided || planes ? THREE.DoubleSide : mat.userData.origSide
      mat.clippingPlanes = planes
      mat.clipShadows = true
      if ('wireframe' in mat) (mat as THREE.MeshStandardMaterial).wireframe = s.wireframe
      if ('flatShading' in mat && !(mat as unknown as THREE.ShaderMaterial).isShaderMaterial) (mat as THREE.MeshStandardMaterial).flatShading = s.flatShading
      mat.needsUpdate = true
    }

    for (const [mesh, orig] of this.originals) {
      let mat: THREE.Material | THREE.Material[]
      switch (s.materialMode) {
        case 'custom':
          mat = cm
          break
        case 'normals':
          mat = this.normalMat
          break
        case 'xray':
          mat = this.xrayMat
          break
        default:
          mat = orig
      }
      mesh.material = mat
      mesh.castShadow = s.materialMode !== 'xray'
      for (const m of Array.isArray(mat) ? mat : [mat]) tune(m)
    }
    // point clouds etc.
    this.model?.object.traverse((o) => {
      if ((o as THREE.Points).isPoints) tune((o as THREE.Points).material as THREE.Material)
    })
    this.edgeMat.clippingPlanes = planes
    this.invalidate()
  }

  // ---------------------------------------------------------------- edges
  private buildEdges() {
    let tris = 0
    for (const mesh of this.originals.keys()) tris += triCount(mesh.geometry)
    if (tris > 3_000_000) {
      this.s.edges = false
      throw new Error('Model too dense for edge overlay (>3M triangles).')
    }
    for (const mesh of this.originals.keys()) {
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) continue
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 28), this.edgeMat)
      lines.userData.isOverlay = true
      lines.raycast = () => {}
      mesh.add(lines)
      this.edgeLines.push(lines)
    }
    this.invalidate()
  }

  private removeEdges() {
    for (const l of this.edgeLines) {
      l.removeFromParent()
      l.geometry.dispose()
    }
    this.edgeLines = []
  }

  // --------------------------------------------------------------- camera
  private setProjection(p: Settings['projection']) {
    const t = this.controls.target
    if (p === 'orthographic') {
      this.ortho.position.copy(this.persp.position)
      this.ortho.quaternion.copy(this.persp.quaternion)
      this.ortho.up.copy(this.persp.up)
      this.ortho.zoom = 1
      this.camera = this.ortho
      this.updateOrthoFrustum()
    } else {
      // carry the ortho zoom back into a perspective dolly distance
      const dir = this.ortho.position.clone().sub(t).divideScalar(this.ortho.zoom || 1)
      this.persp.position.copy(t).add(dir)
      this.persp.quaternion.copy(this.ortho.quaternion)
      this.persp.up.copy(this.ortho.up)
      this.camera = this.persp
    }
    this.controls.object = this.camera
    const vh = this.viewHelper as unknown as { camera: THREE.Camera }
    vh.camera = this.camera
    this.controls.update()
  }

  fit(animate = true) {
    this.flyTo(this.viewDir('iso'), animate)
  }

  private viewDir(v: ViewName) {
    const dirs: Record<ViewName, [number, number, number]> = {
      front: [0, 0, 1],
      back: [0, 0, -1],
      left: [-1, 0, 0],
      right: [1, 0, 0],
      top: [0, 1, 0.0001],
      bottom: [0, -1, 0.0001],
      iso: [1, 0.75, 1.25],
    }
    return new THREE.Vector3(...dirs[v]).normalize()
  }

  view(v: ViewName) {
    this.flyTo(this.viewDir(v), true)
  }

  private flyTo(dir: THREE.Vector3, animate: boolean) {
    const fov = THREE.MathUtils.degToRad(this.persp.fov)
    const aspect = Math.min(1, this.persp.aspect)
    const dist = ((this.radius / Math.sin(fov / 2)) * 1.3) / Math.sqrt(aspect)
    const pos = this.center.clone().addScaledVector(dir, dist)
    if (this.camera === this.ortho) {
      this.ortho.zoom = 1
      this.ortho.updateProjectionMatrix()
    }
    if (!animate) {
      this.camera.position.copy(pos)
      this.controls.target.copy(this.center)
      this.controls.update()
      if (this.camera === this.ortho) this.updateOrthoFrustum()
      this.invalidate()
      return
    }
    this.tween = {
      from: [this.camera.position.clone(), this.controls.target.clone()],
      to: [pos, this.center.clone()],
      t: 0,
      dur: 0.6,
    }
  }

  // ----------------------------------------------------------- pointer
  private bindPointer() {
    const el = this.renderer.domElement
    let down: { x: number; y: number; t: number } | null = null
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }))
    el.addEventListener('pointerup', (e) => {
      if (!down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
      const quick = performance.now() - down.t < 350
      down = null
      if (moved > 5 || !quick) return
      if (this.viewHelper.handleClick(e)) return this.invalidate()
      if (this.measuring) this.measureClick(e)
    })
    el.addEventListener('dblclick', (e) => {
      const hit = this.pick(e)
      if (!hit) return
      this.tween = {
        from: [this.camera.position.clone(), this.controls.target.clone()],
        to: [this.camera.position.clone().add(hit.point.clone().sub(this.controls.target)), hit.point.clone()],
        t: 0,
        dur: 0.45,
      }
    })
  }

  private pick(e: MouseEvent) {
    if (!this.model) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const hits = ray.intersectObject(this.model.object, true).filter((h) => {
      if (!h.object.visible || h.object.userData.isOverlay) return false
      if (this.s.section !== 'off' && this.clipPlane.distanceToPoint(h.point) < 0) return false
      return true
    })
    return hits[0] ?? null
  }

  // ------------------------------------------------------------ measure
  setMeasuring(on: boolean) {
    this.measuring = on
    this.renderer.domElement.style.cursor = on ? 'crosshair' : ''
    if (!on) this.clearMeasure()
  }

  clearMeasure() {
    this.measurePts = []
    this.measureGroup.clear()
    this.measureLabel.hidden = true
    this.onMeasure(null)
    this.invalidate()
  }

  private measureClick(e: MouseEvent) {
    const hit = this.pick(e)
    if (!hit) return
    if (this.measurePts.length >= 2) this.clearMeasure()
    this.measurePts.push(hit.point.clone())
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(this.radius * 0.012, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd166, depthTest: false, toneMapped: false }),
    )
    dot.renderOrder = 999
    dot.position.copy(hit.point)
    this.measureGroup.add(dot)
    if (this.measurePts.length === 2) {
      const [a, b] = this.measurePts
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false, toneMapped: false }),
      )
      line.renderOrder = 998
      this.measureGroup.add(line)
      this.measureLabel.hidden = false
      const dist = a.distanceTo(b)
      this.measureLabel.textContent = formatLen(dist)
      this.onMeasure(dist)
    }
    this.invalidate()
  }

  private updateMeasureLabel() {
    if (this.measurePts.length !== 2) return
    const mid = this.measurePts[0].clone().add(this.measurePts[1]).multiplyScalar(0.5).project(this.camera)
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.measureLabel.style.transform = `translate(${(mid.x * 0.5 + 0.5) * w}px, ${(-mid.y * 0.5 + 0.5) * h}px) translate(-50%, -140%)`
  }

  // -------------------------------------------------------------- info
  stats(): Stats {
    let meshes = 0
    let triangles = 0
    let vertices = 0
    const mats = new Set<THREE.Material>()
    this.model?.object.traverse((o) => {
      const m = o as THREE.Mesh
      if ((m.isMesh || (o as THREE.Points).isPoints) && !o.userData.isOverlay) {
        meshes++
        if (m.isMesh) triangles += triCount(m.geometry)
        vertices += m.geometry.attributes.position?.count ?? 0
        const om = this.originals.get(m) ?? m.material
        for (const x of Array.isArray(om) ? om : [om]) mats.add(x)
      }
    })
    // Report size in the file's own axes
    const size = this.bounds.getSize(new THREE.Vector3())
    if (this.effectiveUp === 'z') size.set(size.x, size.z, size.y)
    return { meshes, triangles, vertices, materials: mats.size, size }
  }

  parts(): Part[] {
    const out: Part[] = []
    this.model?.object.traverse((o) => {
      if (((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) && !o.userData.isOverlay) {
        out.push({ id: o.id, name: o.name || o.parent?.name || `Mesh ${out.length + 1}`, object: o })
      }
    })
    return out
  }

  get animationClips() {
    return this.model?.animations ?? []
  }
  playClip(i: number) {
    if (!this.mixer || !this.model) return
    this.mixer.stopAllAction()
    this.action = this.mixer.clipAction(this.model.animations[i])
    this.action.reset().play()
  }
  get animPaused() {
    return !this.action || this.action.paused
  }
  toggleAnim() {
    if (this.action) this.action.paused = !this.action.paused
  }

  // ------------------------------------------------------------- capture
  private bgCss(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const s = this.s
    if (s.background === 'gradient') {
      const [a, b] = ENVS[s.env].bg
      const g = ctx.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.hypot(w, h) * 0.6)
      g.addColorStop(0, a)
      g.addColorStop(1, b)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
    }
  }

  async screenshot(name: string) {
    const r = this.renderer
    const prevRatio = r.getPixelRatio()
    r.setPixelRatio(Math.max(2, window.devicePixelRatio))
    r.setSize(this.container.clientWidth, this.container.clientHeight)
    this.hideHelper = true
    this.render()
    const src = r.domElement
    const out = document.createElement('canvas')
    out.width = src.width
    out.height = src.height
    const ctx = out.getContext('2d')!
    this.bgCss(ctx, out.width, out.height)
    ctx.drawImage(src, 0, 0)
    this.hideHelper = false
    r.setPixelRatio(prevRatio)
    this.resize()
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'))
    if (blob) download(blob, `${name}.png`)
  }

  /** Records a 360° turntable around the model and downloads it as a video. */
  async recordTurntable(name: string, seconds = 6, onProgress?: (p: number) => void) {
    const src = this.renderer.domElement
    // Composite into a 2D canvas so the CSS gradient background is captured too.
    const out = document.createElement('canvas')
    out.width = src.width - (src.width % 2)
    out.height = src.height - (src.height % 2)
    const ctx = out.getContext('2d')!
    const stream = out.captureStream(60)
    const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16_000_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    const done = new Promise<void>((res) => (rec.onstop = () => res()))

    const t = this.controls.target.clone()
    const off = this.camera.position.clone().sub(t)
    const wasAuto = this.s.autoRotate
    this.controls.autoRotate = false
    this.controls.enabled = false
    this.hideHelper = true
    this.renderer.setAnimationLoop(null)
    rec.start()
    const start = performance.now()
    await new Promise<void>((res) => {
      const frame = () => {
        const p = Math.min(1, (performance.now() - start) / (seconds * 1000))
        const a = p * Math.PI * 2
        this.camera.position.copy(t).add(off.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a))
        this.camera.lookAt(t)
        this.render()
        ctx.clearRect(0, 0, out.width, out.height)
        this.bgCss(ctx, out.width, out.height)
        if (this.s.background === 'transparent') {
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, out.width, out.height)
        }
        ctx.drawImage(src, 0, 0)
        onProgress?.(p)
        if (p < 1) requestAnimationFrame(frame)
        else res()
      }
      requestAnimationFrame(frame)
    })
    rec.stop()
    await done
    this.camera.position.copy(t).add(off)
    this.controls.enabled = true
    this.controls.autoRotate = wasAuto
    this.hideHelper = false
    this.renderer.setAnimationLoop(() => this.loop())
    this.invalidate()
    const ext = mime.includes('mp4') ? 'mp4' : 'webm'
    download(new Blob(chunks, { type: mime.split(';')[0] || 'video/webm' }), `${name}-turntable.${ext}`)
  }

  /** Exports the model with the part rotation applied. Mesh formats stay in the file's own axes; glTF/USDZ are written Y-up. */
  async export(fmt: ExportFormat, name: string) {
    if (!this.model) return
    const content = this.model.object
    const keepUp = fmt === 'glb' || fmt === 'gltf' || fmt === 'usdz'
    // Temporarily detach viewer-only state (overlays, centering, debug materials).
    const edges = this.edgeLines.map((l) => [l, l.parent!] as const)
    edges.forEach(([l]) => l.removeFromParent())
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = []
    if (this.s.materialMode === 'normals' || this.s.materialMode === 'xray') {
      for (const [m, orig] of this.originals) {
        swapped.push([m, m.material])
        m.material = orig
      }
    }
    const pos = this.modelRoot.position.clone()
    const rot = this.upGroup.rotation.clone()
    this.modelRoot.position.set(0, 0, 0)
    if (!keepUp) this.upGroup.rotation.set(0, 0, 0)
    this.modelRoot.updateMatrixWorld(true)
    try {
      await exportObject(keepUp ? this.upGroup : content, fmt, name)
    } finally {
      this.modelRoot.position.copy(pos)
      this.upGroup.rotation.copy(rot)
      this.modelRoot.updateMatrixWorld(true)
      swapped.forEach(([m, mat]) => (m.material = mat))
      edges.forEach(([l, p]) => p.add(l))
      this.invalidate()
    }
  }
}

function triCount(g: THREE.BufferGeometry) {
  return Math.floor((g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3)
}

export function formatLen(v: number) {
  const a = Math.abs(v)
  const digits = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 4
  return v.toLocaleString(undefined, { maximumFractionDigits: digits })
}
