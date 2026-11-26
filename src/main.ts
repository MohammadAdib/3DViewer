import './style.css'
import { registerSW } from 'virtual:pwa-register'
import { Viewer, DEFAULTS, ENVS, formatLen, turnRotation } from './viewer'
import type { Settings, EnvId, ViewName } from './viewer'
import { ACCEPT, FORMATS, createDemoModel, extOf, loadFiles } from './loaders'
import { EXPORTS } from './exporters'
import type { ExportFormat } from './exporters'

registerSW({ immediate: true })

// ------------------------------------------------------------------- helpers
type Attrs = Record<string, any>
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | false)[]) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'html') el.innerHTML = v
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids) if (c != null && c !== false) el.append(c)
  return el
}
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T

const ICON: Record<string, string> = {
  open: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/>',
  export: '<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M4 20h16"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  video: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3"/>',
  ruler: '<path d="M3 17 17 3l4 4L7 21zM7.5 12.5l2 2M10.5 9.5l2 2M13.5 6.5l2 2"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  sliders: '<path d="M4 6h9m4 0h3M4 12h3m4 0h9M4 18h11m4 0h1M15 4v4M9 10v4M17 16v4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  fit: '<path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="2.5"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5"/>',
  grid: '<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/>',
  cube: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5"/>',
  section: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" opacity=".45"/><path d="M2 12h20" stroke-dasharray="2.5 2.5"/>',
  edges: '<path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  wire: '<path d="M4 4h16v16H4zM4 4l16 16M12 4v16M4 12h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  paint: '<path d="M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2a2 2 0 0 0-1.5 3.3A1.7 1.7 0 0 1 12 21z"/><circle cx="7.5" cy="11" r=".6"/><circle cx="10" cy="7" r=".6"/><circle cx="15" cy="7.5" r=".6"/>',
  tools: '<path d="M12 3 2 8l10 5 10-5zM2 16l10 5 10-5M2 12l10 5 10-5"/>',
  install: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>',
  reload: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
}
const icon = (n: string) => `<svg viewBox="0 0 24 24">${ICON[n]}</svg>`
const LOGO = $('.hero-logo')!.innerHTML

// ------------------------------------------------------------------- state
const STORE = 'viewer3d.settings.v2'
// v1 saved every setting, so untouched ones pinned that era's defaults; drop the ones that have since changed.
const STORE_V1 = 'viewer3d.settings.v1'
const V1_DEFAULTS: Partial<Settings> = { grid: false, color: '#8ab4f8', exposure: 1 }
/** Settings that belong to one model; reset on page load and when a new model opens. */
const PER_MODEL = { section: 'off', upAxis: 'auto', rotX: 0, rotY: 0, rotZ: 0 } satisfies Partial<Settings>
function loadSettings(): Settings {
  try {
    let saved = JSON.parse(localStorage.getItem(STORE) || 'null')
    if (!saved) {
      saved = JSON.parse(localStorage.getItem(STORE_V1) || '{}')
      for (const [k, v] of Object.entries(V1_DEFAULTS)) if (saved[k] === v) delete saved[k]
    }
    return { ...DEFAULTS, ...saved, ...PER_MODEL }
  } catch {
    return { ...DEFAULTS }
  }
}
let saveTimer = 0
const save = () => {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      // Only store what differs from the defaults, so a changed default reaches everyone who never touched it.
      const changed = Object.fromEntries(Object.entries(viewer.s).filter(([k, v]) => v !== DEFAULTS[k as keyof Settings]))
      localStorage.setItem(STORE, JSON.stringify(changed))
      localStorage.removeItem(STORE_V1)
    } catch { /* private mode */ }
  }, 300)
}

const app = $('#app')
const stage = $('#stage')
const viewer = new Viewer(stage)
let currentFiles: File[] = []
let loadMs = 0

const syncers: (() => void)[] = []
const sync = () => syncers.forEach((f) => f())
const set = (patch: Partial<Settings>) => {
  viewer.apply(patch)
  save()
  sync()
}

// ------------------------------------------------------------------- controls
function slider(label: string, key: keyof Settings, min: number, max: number, step: number, fmt: (v: number) => string = (v) => String(+v.toFixed(2))) {
  const val = h('span', { class: 'val' })
  const input = h('input', { type: 'range', min, max, step }) as HTMLInputElement
  const paint = () => input.style.setProperty('--p', `${((+input.value - min) / (max - min)) * 100}%`)
  input.addEventListener('input', () => {
    paint()
    val.textContent = fmt(+input.value)
    set({ [key]: +input.value } as Partial<Settings>)
  })
  input.addEventListener('dblclick', () => set({ [key]: DEFAULTS[key] } as Partial<Settings>))
  syncers.push(() => {
    input.value = String(viewer.s[key])
    val.textContent = fmt(+input.value)
    paint()
  })
  return h('div', { class: 'ctl col', title: 'Double-click to reset' }, h('div', { class: 'head' }, h('label', {}, label), val), input)
}

function toggle(label: string, key: keyof Settings) {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement
  input.addEventListener('change', () => set({ [key]: input.checked } as Partial<Settings>))
  syncers.push(() => (input.checked = !!viewer.s[key]))
  return h('label', { class: 'ctl' }, h('label', {}, label), h('span', { class: 'switch' }, input, h('i')))
}

function seg<K extends keyof Settings>(label: string | null, key: K, opts: [Settings[K], string][], col = false) {
  const wrap = h('div', { class: 'seg' })
  const btns = opts.map(([v, text]) => {
    const b = h('button', { onclick: () => set({ [key]: v } as Partial<Settings>) }, text)
    wrap.append(b)
    return [v, b] as const
  })
  syncers.push(() => btns.forEach(([v, b]) => b.classList.toggle('active', viewer.s[key] === v)))
  if (!label) return wrap
  return h('div', { class: col ? 'ctl col' : 'ctl' }, col ? h('div', { class: 'head' }, h('label', {}, label)) : h('label', {}, label), wrap)
}

function color(label: string, key: keyof Settings) {
  const input = h('input', { type: 'color' }) as HTMLInputElement
  input.addEventListener('input', () => set({ [key]: input.value } as Partial<Settings>))
  syncers.push(() => (input.value = String(viewer.s[key])))
  return h('div', { class: 'ctl' }, h('label', {}, label), h('span', { class: 'colorpick' }, input))
}

const group = (title: string | Node, ...kids: (Node | null | false)[]) =>
  h('div', { class: 'group' }, typeof title === 'string' ? h('h5', {}, title) : title, ...kids)

// ------------------------------------------------------------------- topbar
const fileInput = h('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true }) as HTMLInputElement
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) openFiles([...fileInput.files])
  fileInput.value = ''
})

const titleEl = h('span', { class: 'title' }, '3D Viewer')
const badgeEl = h('span', { class: 'badge' })
const btn = (name: string, title: string, onclick: (e: MouseEvent) => void, cls = '') =>
  h('button', { class: `btn icon ${cls}`, title, 'aria-label': title, html: icon(name), onclick })

const exportMenu = h(
  'div',
  { class: 'menu glass' },
  h('h6', {}, 'Export model'),
  ...EXPORTS.map((e) => h('button', { onclick: () => doExport(e.id) }, h('b', {}, e.label), h('span', {}, e.hint))),
  h('hr'),
  h('h6', {}, 'Capture'),
  h('button', { onclick: () => doScreenshot() }, h('b', {}, 'PNG'), h('span', {}, 'Hi-res screenshot · S')),
  h('button', { onclick: () => doRecord() }, h('b', {}, 'Turntable'), h('span', {}, '360° video · 6 s')),
)
const exportBtn = h('button', { class: 'btn primary needs-model', html: icon('export') + '<span class="hide-sm">Export</span>' })
exportBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  exportMenu.classList.toggle('open')
})
document.addEventListener('click', (e) => {
  if (!exportMenu.contains(e.target as Node)) exportMenu.classList.remove('open')
})

const installBtn = btn('install', 'Install app', () => installPrompt?.prompt(), 'hide-sm')
installBtn.hidden = true
const measureBtn = btn('ruler', 'Measure distance (M)', () => toggleMeasure(), 'needs-model')
const statsBtn = btn('info', 'Model info (I)', () => toggleStats(), 'needs-model')
const panelBtn = btn('sliders', 'Settings panel (H)', () => togglePanel(), 'needs-model')

const topbar = h(
  'header',
  { class: 'topbar' },
  h('div', { class: 'brand glass' }, h('span', { class: 'logo', html: LOGO }), titleEl, badgeEl),
  h('div', { class: 'spacer' }),
  h(
    'div',
    { class: 'toolbar glass' },
    btn('open', 'Open file (O)', () => fileInput.click()),
    installBtn,
    btn('help', 'Shortcuts (?)', () => help.classList.add('show'), 'hide-sm'),
    btn('full', 'Fullscreen', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()), 'hide-sm'),
    measureBtn,
    statsBtn,
    panelBtn,
    h('span', { class: 'sep needs-model' }),
    h('div', { class: 'menu-wrap needs-model' }, exportBtn, exportMenu),
  ),
)

// ------------------------------------------------------------------- stats card
const stats = h('aside', { class: 'stats glass needs-model' })
function renderStats() {
  const m = viewer.model
  if (!m) return
  const s = viewer.stats()
  const n = (v: number) => v.toLocaleString()
  const unit = FORMATS[extOf(m.name)]?.cad ? 'millimetres' : 'model units'
  const row = (a: string, b: string) => h('div', { class: 'row' }, h('span', {}, a), h('span', {}, b))
  stats.replaceChildren(
    row('Format', m.format),
    m.bytes ? row('File size', fmtBytes(m.bytes)) : '',
    loadMs ? row('Load time', `${loadMs.toFixed(0)} ms`) : '',
    row('Triangles', n(s.triangles)),
    row('Vertices', n(s.vertices)),
    row('Meshes', n(s.meshes)),
    row('Materials', n(s.materials)),
    h(
      'div',
      { class: 'dims' },
      h('div', { class: 'dim' }, h('i', {}, 'X'), h('b', {}, formatLen(s.size.x))),
      h('div', { class: 'dim' }, h('i', {}, 'Y'), h('b', {}, formatLen(s.size.y))),
      h('div', { class: 'dim' }, h('i', {}, 'Z'), h('b', {}, formatLen(s.size.z))),
    ),
    h('div', { class: 'unit' }, `Bounding box · ${unit}`),
  )
}
const fmtBytes = (b: number) => (b > 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`)
let statsOpen = matchMedia('(min-width: 761px)').matches
function toggleStats(force?: boolean) {
  statsOpen = force ?? !statsOpen
  stats.classList.toggle('hidden', !statsOpen)
  stats.classList.toggle('mobile-show', statsOpen)
  statsBtn.classList.toggle('on', statsOpen)
}

// ------------------------------------------------------------------- dock
const dockBtn = (label: string, title: string, onclick: () => void, isIcon = true, cls = '') =>
  h('button', { class: `btn ${isIcon ? 'icon' : 'txt'} ${cls}`, title, html: isIcon ? icon(label) : label, onclick })
const rotateBtn = dockBtn('rotate', 'Auto-rotate (R)', () => set({ autoRotate: !viewer.s.autoRotate }))
const gridBtn = dockBtn('grid', 'Grid (G)', () => set({ grid: !viewer.s.grid }))
const edgesBtn = dockBtn('edges', 'Edge lines (E)', () => set({ edges: !viewer.s.edges }))
const wireBtn = dockBtn('wire', 'Wireframe (W)', () => set({ wireframe: !viewer.s.wireframe }))
const projBtn = dockBtn('cube', 'Perspective / Orthographic (P)', () =>
  set({ projection: viewer.s.projection === 'perspective' ? 'orthographic' : 'perspective' }),
)
const sectionBtn = dockBtn('section', 'Section cut (X)', () => cycleSection())
syncers.push(() => {
  rotateBtn.classList.toggle('on', viewer.s.autoRotate)
  gridBtn.classList.toggle('on', viewer.s.grid)
  edgesBtn.classList.toggle('on', viewer.s.edges)
  wireBtn.classList.toggle('on', viewer.s.wireframe)
  projBtn.classList.toggle('on', viewer.s.projection === 'orthographic')
  sectionBtn.classList.toggle('on', viewer.s.section !== 'off')
})
const views: [ViewName, string, string][] = [
  ['front', 'F', 'Front (1)'],
  ['top', 'T', 'Top (5)'],
  ['right', 'R', 'Right (4)'],
  ['iso', 'ISO', 'Isometric (0)'],
]
const dock = h(
  'nav',
  { class: 'dock glass needs-model' },
  dockBtn('fit', 'Fit to view (F)', () => viewer.fit()),
  ...views.map(([v, l, t]) => dockBtn(l, t, () => viewer.view(v), false, v === 'right' || v === 'top' ? 'hide-sm' : '')),
  h('span', { class: 'sep' }),
  projBtn,
  rotateBtn,
  gridBtn,
  h('span', { class: 'sep' }),
  wireBtn,
  edgesBtn,
  sectionBtn,
)

// ------------------------------------------------------------------- panel
const envCards = (Object.keys(ENVS) as EnvId[]).map((id) => {
  const e = ENVS[id]
  const el = h(
    'button',
    {
      class: 'env',
      style: { background: `radial-gradient(circle at 50% 30%, ${e.bg[0]}, ${e.bg[1]})`, '--ball': `radial-gradient(circle at 35% 30%, #fff, ${e.bg[0]} 45%, ${e.bg[1]})` },
      onclick: () => set({ env: id }),
    },
    e.label,
  )
  el.style.setProperty('--ball', `radial-gradient(circle at 35% 30%, #fff, ${e.bg[0]} 45%, ${e.bg[1]})`)
  return [id, el] as const
})
syncers.push(() => envCards.forEach(([id, el]) => el.classList.toggle('active', viewer.s.env === id)))

const bgColorCtl = color('Background color', 'bgColor')
syncers.push(() => {
  bgColorCtl.style.display = viewer.s.background === 'solid' ? '' : 'none'
  const [a, b] = ENVS[viewer.s.env].bg
  stage.style.setProperty('--bg-a', a)
  stage.style.setProperty('--bg-b', viewer.s.background === 'solid' ? viewer.s.bgColor : b)
  stage.className = viewer.s.background === 'gradient' ? '' : viewer.s.background
})

const lightPage = h(
  'div',
  { class: 'tab-page' },
  group('Environment', h('div', { class: 'envs' }, ...envCards.map(([, el]) => el)), slider('Reflections', 'envIntensity', 0, 3, 0.01), slider('Rotation', 'envRotation', 0, 360, 1, (v) => `${v}°`)),
  group('Background', seg(null, 'background', [['gradient', 'Gradient'], ['env', 'Scene'], ['solid', 'Solid'], ['transparent', 'None']]), bgColorCtl),
  group(
    'Key light',
    slider('Intensity', 'keyIntensity', 0, 8, 0.01),
    slider('Azimuth', 'keyAzimuth', -180, 180, 1, (v) => `${v}°`),
    slider('Elevation', 'keyElevation', 5, 90, 1, (v) => `${v}°`),
    color('Color', 'keyColor'),
    toggle('Cast shadows', 'shadows'),
  ),
  group(
    'Exposure',
    slider('Ambient fill', 'ambient', 0, 3, 0.01),
    slider('Exposure', 'exposure', 0.1, 3, 0.01),
    seg('Tone map', 'toneMapping', [['agx', 'AgX'], ['aces', 'ACES'], ['neutral', 'Neutral'], ['none', 'Off']], true),
  ),
)

const PRESETS: { name: string; color: string; metalness: number; roughness: number; clearcoat: number; transmission?: number }[] = [
  { name: 'Ceramic', color: '#f1eee8', metalness: 0, roughness: 0.25, clearcoat: 0.7 },
  { name: 'Clay', color: '#c7b29b', metalness: 0, roughness: 0.95, clearcoat: 0 },
  { name: 'Plastic', color: '#3b82f6', metalness: 0, roughness: 0.35, clearcoat: 0.25 },
  { name: 'Rubber', color: '#2a2b30', metalness: 0, roughness: 0.92, clearcoat: 0 },
  { name: 'Carbon', color: '#1b1d22', metalness: 0.35, roughness: 0.3, clearcoat: 1 },
  { name: 'Aluminum', color: '#c9cdd3', metalness: 1, roughness: 0.32, clearcoat: 0 },
  { name: 'Chrome', color: '#ffffff', metalness: 1, roughness: 0.04, clearcoat: 0 },
  { name: 'Gold', color: '#ffc35a', metalness: 1, roughness: 0.18, clearcoat: 0 },
  { name: 'Copper', color: '#e3895e', metalness: 1, roughness: 0.27, clearcoat: 0 },
  { name: 'Glass', color: '#eef6ff', metalness: 0, roughness: 0.02, clearcoat: 1, transmission: 1 },
]
const swatchBg = (p: (typeof PRESETS)[number]) => {
  const hi = p.metalness > 0.5 ? '#ffffff' : 'rgba(255,255,255,.85)'
  const spread = 12 + p.roughness * 40
  return p.transmission
    ? `radial-gradient(circle at 35% 30%, #fff, rgba(200,230,255,.35) 30%, rgba(120,160,220,.25) 70%, rgba(255,255,255,.5))`
    : `radial-gradient(circle at 35% 30%, ${hi}, ${p.color} ${spread}%, color-mix(in srgb, ${p.color} 35%, #000) 100%)`
}
const presetBtns = PRESETS.map((p) => {
  const b = h(
    'button',
    {
      class: 'mat',
      onclick: () => set({ materialMode: 'custom', color: p.color, metalness: p.metalness, roughness: p.roughness, clearcoat: p.clearcoat, transmission: p.transmission ?? 0 }),
    },
    h('i', { style: { background: swatchBg(p) } }),
    p.name,
  )
  return [p, b] as const
})
syncers.push(() =>
  presetBtns.forEach(([p, b]) =>
    b.classList.toggle(
      'active',
      viewer.s.materialMode === 'custom' && viewer.s.color === p.color && viewer.s.metalness === p.metalness && viewer.s.roughness === p.roughness,
    ),
  ),
)
const PALETTE = ['#f8fafc', '#94a3b8', '#334155', '#0f172a', '#ef4444', '#f97316', '#facc15', '#22c55e', '#14b8a6', '#38bdf8', '#6366f1', '#a855f7', '#ec4899']
const customCtls = h(
  'div',
  {},
  color('Color', 'color'),
  h('div', { class: 'palette' }, ...PALETTE.map((c) => h('button', { style: { background: c }, title: c, onclick: () => set({ materialMode: 'custom', color: c }) }))),
  slider('Metalness', 'metalness', 0, 1, 0.01),
  slider('Roughness', 'roughness', 0, 1, 0.01),
  slider('Clearcoat', 'clearcoat', 0, 1, 0.01),
  slider('Transmission', 'transmission', 0, 1, 0.01),
)
syncers.push(() => (customCtls.style.display = viewer.s.materialMode === 'custom' ? '' : 'none'))

const materialPage = h(
  'div',
  { class: 'tab-page' },
  group('Shading', seg(null, 'materialMode', [['original', 'Original'], ['custom', 'Custom'], ['normals', 'Normals'], ['xray', 'X-Ray']])),
  group('Presets', h('div', { class: 'swatches' }, ...presetBtns.map(([, b]) => b))),
  group('Surface', customCtls, h('p', { class: 'note' }, 'Tip: recolor here, then export as GLB/glTF to keep the material.')),
  group(
    'Display',
    toggle('Wireframe', 'wireframe'),
    toggle('Edge lines', 'edges'),
    color('Edge color', 'edgeColor'),
    toggle('Flat shading', 'flatShading'),
    toggle('Double-sided', 'doubleSided'),
  ),
)

// Tools page
const sectionCtls = h('div', {}, slider('Position', 'sectionPos', 0, 1, 0.001, (v) => `${Math.round(v * 100)}%`), toggle('Flip side', 'sectionFlip'))
syncers.push(() => (sectionCtls.style.display = viewer.s.section === 'off' ? 'none' : ''))

const animGroup = h('div', {})
function renderAnim() {
  const clips = viewer.animationClips
  if (!clips.length) return animGroup.replaceChildren()
  const sel = h('select', { class: 'parts-filter', onchange: (e: Event) => viewer.playClip(+(e.target as HTMLSelectElement).value) }, ...clips.map((c, i) => h('option', { value: i }, c.name || `Clip ${i + 1}`)))
  const play = h('button', { class: 'btn', html: icon('pause') + 'Pause' })
  play.onclick = () => {
    viewer.toggleAnim()
    play.innerHTML = viewer.animPaused ? icon('play') + 'Play' : icon('pause') + 'Pause'
  }
  animGroup.replaceChildren(group(`Animation · ${clips.length}`, sel, h('div', { class: 'row-btns' }, play)))
}

const partsList = h('div', { class: 'parts' })
const partsFilter = h('input', { class: 'parts-filter', placeholder: 'Filter parts…' }) as HTMLInputElement
const partsTitle = h('h5', {}, 'Parts')
const partsGroup = group(
  partsTitle,
  partsFilter,
  h(
    'div',
    { class: 'row-btns' },
    h('button', { class: 'btn', onclick: () => setAllParts(true) }, 'Show all'),
    h('button', { class: 'btn', onclick: () => setAllParts(false) }, 'Hide all'),
  ),
  partsList,
)
partsFilter.addEventListener('input', () => renderParts())
function setAllParts(v: boolean) {
  const q = partsFilter.value.toLowerCase()
  viewer.parts().forEach((p) => {
    if (!q || p.name.toLowerCase().includes(q)) p.object.visible = v
  })
  viewer.invalidate()
  renderParts()
}
function renderParts() {
  const parts = viewer.parts()
  partsGroup.style.display = parts.length > 1 ? '' : 'none'
  partsTitle.textContent = `Parts · ${parts.length}`
  const q = partsFilter.value.toLowerCase()
  const shown = parts.filter((p) => !q || p.name.toLowerCase().includes(q))
  const LIMIT = 400
  partsList.replaceChildren(
    ...shown.slice(0, LIMIT).map((p) => {
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement
      cb.checked = p.object.visible
      const row = h('label', { class: `part ${p.object.visible ? '' : 'off'}` }, cb, h('span', { title: p.name }, p.name))
      cb.onchange = () => {
        p.object.visible = cb.checked
        row.classList.toggle('off', !cb.checked)
        viewer.invalidate()
      }
      return row
    }),
    shown.length > LIMIT ? h('p', { class: 'note' }, `…and ${shown.length - LIMIT} more — use the filter.`) : '',
  )
}

const cadGroup = h('div', {})
function renderCad() {
  const isCad = !!viewer.model && !!FORMATS[extOf(viewer.model.name)]?.cad
  cadGroup.replaceChildren(
    isCad
      ? group(
          'CAD tessellation',
          slider('Detail', 'cadQuality', 0, 1, 0.05, (v) => (v < 0.34 ? 'Coarse' : v < 0.67 ? 'Medium' : 'Fine')),
          h('div', { class: 'row-btns' }, h('button', { class: 'btn', html: icon('reload') + 'Re-tessellate', onclick: () => openFiles(currentFiles, true) })),
        )
      : '',
  )
  sync()
}

// Part rotation, in the file's own axes; exports are written rotated.
const ROT_AXES = [['x', 'rotX'], ['y', 'rotY'], ['z', 'rotZ']] as const
const resetRotBtn = h('button', { class: 'h5-btn', title: 'Clear rotation', onclick: () => set({ rotX: 0, rotY: 0, rotZ: 0 }) }, 'Reset') as HTMLButtonElement
syncers.push(() => (resetRotBtn.disabled = !(viewer.s.rotX || viewer.s.rotY || viewer.s.rotZ)))
// Flips turn about the fixed axis (see turnRotation), so they may move more than one angle slider.
const flipBtn = (axis: 'x' | 'y' | 'z', deg: number) => {
  const label = `${deg > 0 ? '+' : '−'}${Math.abs(deg)}°`
  return h('button', { class: 'btn', title: `Turn ${label} about ${axis.toUpperCase()}`, onclick: () => set(turnRotation(viewer.s, axis, deg)) }, label)
}
const rotateGroup = group(
  h('h5', {}, 'Rotate part', resetRotBtn),
  h('div', { class: 'flips' }, ...ROT_AXES.flatMap(([axis]) => [h('i', { class: axis }, axis.toUpperCase()), flipBtn(axis, -90), flipBtn(axis, 90)])),
  ...ROT_AXES.map(([axis, key]) => slider(`${axis.toUpperCase()} angle`, key, -180, 180, 1, (v) => `${v}°`)),
)

const toolsPage = h(
  'div',
  { class: 'tab-page' },
  rotateGroup,
  group(
    'Camera',
    seg('Projection', 'projection', [['perspective', 'Persp'], ['orthographic', 'Ortho']]),
    slider('Field of view', 'fov', 15, 90, 1, (v) => `${v}°`),
    toggle('Auto-rotate', 'autoRotate'),
    slider('Rotate speed', 'autoRotateSpeed', -10, 10, 0.1),
  ),
  group('Orientation', seg('Up axis', 'upAxis', [['auto', 'Auto'], ['y', 'Y-up'], ['z', 'Z-up']]), toggle('Show grid', 'grid')),
  group('Section cut', seg(null, 'section', [['off', 'Off'], ['x', 'X'], ['y', 'Y'], ['z', 'Z']]), sectionCtls),
  animGroup,
  cadGroup,
  partsGroup,
)

const tabs: [string, string, HTMLElement][] = [
  ['Light', 'sun', lightPage],
  ['Material', 'paint', materialPage],
  ['Tools', 'tools', toolsPage],
]
const tabBtns = tabs.map(([name, ic, page], i) => {
  const b = h('button', { html: icon(ic) + name, onclick: () => selectTab(i) })
  return [b, page] as const
})
function selectTab(i: number) {
  tabBtns.forEach(([b, p], j) => {
    b.classList.toggle('active', i === j)
    p.classList.toggle('active', i === j)
  })
  try {
    localStorage.setItem('viewer3d.tab', String(i))
  } catch { /* ignore */ }
}
const panel = h('aside', { class: 'panel glass needs-model' }, h('div', { class: 'tabs' }, ...tabBtns.map(([b]) => b)), h('div', { class: 'panel-body' }, ...tabs.map((t) => t[2])))
let panelOpen = matchMedia('(min-width: 761px)').matches
function togglePanel(force?: boolean) {
  panelOpen = force ?? !panelOpen
  panel.classList.toggle('closed', !panelOpen)
  panelBtn.classList.toggle('on', panelOpen)
}

// ------------------------------------------------------------------- overlays
const drop = h('div', { class: 'drop' }, h('div', {}, 'Drop to open'))
const loadingMsg = h('div', { class: 'msg' })
const loadingFile = h('div', { class: 'file' })
const loading = h('div', { class: 'loading' }, h('div', { class: 'box glass' }, h('div', { class: 'spinner' }), loadingFile, loadingMsg))
const toasts = h('div', { class: 'toasts' })
const measureHint = h('div', { class: 'measure-hint glass' }, 'Click two points on the model to measure · Esc to exit')
const recBadge = h('div', { class: 'rec glass' }, h('i'), h('span', {}, 'Recording turntable…'))

const KEYS: [string, string][] = [
  ['O', 'Open file'], ['F', 'Fit view'], ['1–6', 'Front/Back/Left/Right/Top/Bottom'], ['0', 'Isometric'],
  ['P', 'Persp / Ortho'], ['R', 'Auto-rotate'], ['G', 'Grid'], ['W', 'Wireframe'], ['E', 'Edge lines'],
  ['X', 'Section cut'], ['M', 'Measure'], ['S', 'Screenshot'], ['I', 'Model info'], ['H', 'Panel'],
  ['Dbl-click', 'Set pivot'], ['Esc', 'Close / cancel'],
]
const help = h(
  'div',
  { class: 'modal', onclick: (e: MouseEvent) => e.target === help && help.classList.remove('show') },
  h('div', { class: 'box glass' }, h('h3', {}, 'Keyboard shortcuts'), h('div', { class: 'keys' }, ...KEYS.map(([k, d]) => h('div', {}, h('span', {}, d), h('kbd', {}, k))))),
)

app.append(topbar, stats, dock, panel, drop, loading, toasts, measureHint, recBadge, help, fileInput)

function toast(msg: string, kind: 'ok' | 'err' | '' = '', ms = 3500) {
  const t = h('div', { class: `toast glass ${kind}` }, msg)
  toasts.append(t)
  setTimeout(() => t.remove(), ms)
}
viewer.onError = (m) => {
  toast(m, 'err')
  sync()
}

// ------------------------------------------------------------------- actions
async function openFiles(files: File[], reload = false) {
  if (!files.length) return
  const primary = files.find((f) => extOf(f.name) in FORMATS) ?? files[0]
  loadingFile.textContent = primary.name
  loadingMsg.textContent = 'Opening…'
  loading.classList.add('show')
  const t0 = performance.now()
  try {
    const model = await loadFiles(files, (m) => (loadingMsg.textContent = m), viewer.s.cadQuality)
    loadMs = performance.now() - t0
    currentFiles = files
    showModel(model, reload)
    toast(`Loaded ${model.name} in ${loadMs < 1000 ? loadMs.toFixed(0) + ' ms' : (loadMs / 1000).toFixed(2) + ' s'}`, 'ok', 2200)
  } catch (err) {
    console.error(err)
    toast((err as Error).message || 'Failed to load file', 'err', 6000)
  } finally {
    loading.classList.remove('show')
  }
}

/** `reload` re-opens the same files (e.g. re-tessellating), so the part keeps its orientation. */
function showModel(model: ReturnType<typeof createDemoModel>, reload = false) {
  const p = PER_MODEL
  const s = viewer.s
  if (!reload && (s.section !== p.section || s.upAxis !== p.upAxis || s.rotX || s.rotY || s.rotZ)) viewer.apply(p)
  viewer.setMeasuring(false)
  viewer.setModel(model)
  document.body.classList.add('has-model')
  $('#hero')?.classList.add('gone')
  titleEl.textContent = model.name
  titleEl.title = model.name
  badgeEl.textContent = model.format
  document.title = `${model.name} — 3D Viewer`
  renderStats()
  renderParts()
  renderAnim()
  renderCad()
  syncMeasure()
}

const baseName = () => (viewer.model?.name ?? 'model').replace(/\.[^.]+$/, '')

async function doExport(fmt: ExportFormat) {
  exportMenu.classList.remove('open')
  if (!viewer.model) return
  loadingFile.textContent = `Exporting ${fmt.toUpperCase()}`
  loadingMsg.textContent = 'Writing file…'
  loading.classList.add('show')
  await new Promise((r) => setTimeout(r, 30))
  try {
    await viewer.export(fmt, baseName())
    toast(`Exported ${baseName()}.${fmt === 'stl-ascii' ? 'stl' : fmt}`, 'ok')
  } catch (e) {
    console.error(e)
    toast(`Export failed: ${(e as Error).message}`, 'err', 6000)
  } finally {
    loading.classList.remove('show')
  }
}

async function doScreenshot() {
  exportMenu.classList.remove('open')
  await viewer.screenshot(baseName())
  toast('Screenshot saved', 'ok', 1800)
}

async function doRecord() {
  exportMenu.classList.remove('open')
  if (typeof MediaRecorder === 'undefined') return toast('Video recording is not supported in this browser', 'err')
  recBadge.classList.add('show')
  try {
    await viewer.recordTurntable(baseName(), 6, (p) => ((recBadge.lastChild as HTMLElement).textContent = `Recording turntable… ${Math.round(p * 100)}%`))
    toast('Turntable video saved', 'ok')
  } catch (e) {
    toast(`Recording failed: ${(e as Error).message}`, 'err')
  } finally {
    recBadge.classList.remove('show')
  }
}

function toggleMeasure(force?: boolean) {
  viewer.setMeasuring(force ?? !viewer.measuring)
  syncMeasure()
}
function syncMeasure() {
  measureBtn.classList.toggle('on', viewer.measuring)
  measureHint.classList.toggle('show', viewer.measuring)
}
viewer.onMeasure = (d) => {
  if (d != null) measureHint.textContent = `Distance: ${formatLen(d)} · click again to restart · Esc to exit`
  else measureHint.textContent = 'Click two points on the model to measure · Esc to exit'
}

function cycleSection() {
  const order: Settings['section'][] = ['off', 'x', 'y', 'z']
  const next = order[(order.indexOf(viewer.s.section) + 1) % order.length]
  set({ section: next })
  if (next !== 'off') toast(`Section along ${next.toUpperCase()} — adjust in Tools`, '', 1600)
}

// ------------------------------------------------------------------- drag & drop
let dragDepth = 0
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return
  e.preventDefault()
  dragDepth++
  drop.classList.add('show')
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0
    drop.classList.remove('show')
  }
})
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  dragDepth = 0
  drop.classList.remove('show')
  const files = await filesFromDrop(e.dataTransfer!)
  openFiles(files)
})

/** Collects files from a drop, recursing into dropped folders (e.g. a glTF with textures). */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[]
  if (!entries.length) return [...dt.files]
  const out: File[] = []
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)))
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      let batch: FileSystemEntry[]
      do {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
        await Promise.all(batch.map(walk))
      } while (batch.length)
    }
  }
  await Promise.all(entries.map(walk))
  return out
}

// paste a file from clipboard
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])]
  if (files.length) openFiles(files)
})

// ------------------------------------------------------------------- keyboard
window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
  if (e.ctrlKey || e.metaKey || e.altKey) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault()
      fileInput.click()
    }
    return
  }
  const k = e.key.toLowerCase()
  const hasModel = !!viewer.model
  const viewKeys: Record<string, ViewName> = { '1': 'front', '2': 'back', '3': 'left', '4': 'right', '5': 'top', '6': 'bottom', '0': 'iso' }
  if (k === 'o') fileInput.click()
  else if (k === '?' || (k === '/' && e.shiftKey)) help.classList.toggle('show')
  else if (k === 'escape') {
    help.classList.remove('show')
    exportMenu.classList.remove('open')
    if (viewer.measuring) toggleMeasure(false)
  } else if (k === 'h') togglePanel()
  else if (!hasModel) return
  else if (k in viewKeys) viewer.view(viewKeys[k])
  else if (k === 'f') viewer.fit()
  else if (k === 'r') set({ autoRotate: !viewer.s.autoRotate })
  else if (k === 'g') set({ grid: !viewer.s.grid })
  else if (k === 'w') set({ wireframe: !viewer.s.wireframe })
  else if (k === 'e') set({ edges: !viewer.s.edges })
  else if (k === 'p') set({ projection: viewer.s.projection === 'perspective' ? 'orthographic' : 'perspective' })
  else if (k === 'x') cycleSection()
  else if (k === 'm') toggleMeasure()
  else if (k === 's') doScreenshot()
  else if (k === 'i') toggleStats()
  else return
  e.preventDefault()
})

// ------------------------------------------------------------------- hero buttons
document.querySelectorAll<HTMLElement>('[data-action]').forEach((el) =>
  el.addEventListener('click', () => {
    if (el.dataset.action === 'open') fileInput.click()
    if (el.dataset.action === 'demo') {
      loadMs = 0
      currentFiles = []
      showModel(createDemoModel())
    }
  }),
)

// ------------------------------------------------------------------- PWA install + file handling
let installPrompt: (Event & { prompt: () => void }) | null = null
const runningInstalled = () =>
  matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches || (navigator as any).standalone === true
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  installPrompt = e as any
  installBtn.hidden = runningInstalled()
})
window.addEventListener('appinstalled', () => {
  installPrompt = null
  installBtn.hidden = true
})

// Installed PWA: OS "Open with 3D Viewer" hands us files via the launch queue.
const lq = (window as any).launchQueue
if (lq?.setConsumer) {
  lq.setConsumer(async (params: { files: FileSystemFileHandle[] }) => {
    if (!params.files?.length) return
    const files = await Promise.all(params.files.map((f) => f.getFile()))
    openFiles(files)
  })
}

// ?url=https://example.com/model.stl
const urlParam = new URLSearchParams(location.search).get('url')
if (urlParam) {
  ;(async () => {
    loadingFile.textContent = urlParam.split('/').pop() ?? 'model'
    loadingMsg.textContent = 'Downloading…'
    loading.classList.add('show')
    try {
      const res = await fetch(urlParam)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const name = decodeURIComponent(new URL(urlParam, location.href).pathname.split('/').pop() || 'model.glb')
      openFiles([new File([await res.blob()], name)])
    } catch (e) {
      loading.classList.remove('show')
      toast(`Could not fetch model: ${(e as Error).message}`, 'err', 6000)
    }
  })()
}

// ------------------------------------------------------------------- init
viewer.apply(loadSettings())
viewer.onChange = () => {
  if (viewer.model) renderStatsDebounced()
}
let statsTimer = 0
const renderStatsDebounced = () => {
  clearTimeout(statsTimer)
  statsTimer = window.setTimeout(renderStats, 120)
}
let tab = 0
try {
  tab = +(localStorage.getItem('viewer3d.tab') ?? 0) || 0
} catch { /* ignore */ }
selectTab(Math.min(tab, tabs.length - 1))
togglePanel(panelOpen)
toggleStats(statsOpen)
sync()
