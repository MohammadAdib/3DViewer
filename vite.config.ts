import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Served from https://<user>.github.io/3DViewer/
const base = '/3DViewer/'

const MODEL_TYPES: Record<string, string[]> = {
  'model/stl': ['.stl'],
  'model/step': ['.step', '.stp'],
  'model/iges': ['.iges', '.igs'],
  'model/gltf-binary': ['.glb'],
  'model/gltf+json': ['.gltf'],
  'model/obj': ['.obj'],
  'model/3mf': ['.3mf'],
  'model/vnd.collada+xml': ['.dae'],
  'model/vrml': ['.wrl', '.vrml'],
  'model/vnd.usdz+zip': ['.usdz'],
  'application/x-ply': ['.ply'],
  'application/x-fbx': ['.fbx'],
  'application/x-3ds': ['.3ds'],
  'application/x-amf': ['.amf'],
  'application/x-brep': ['.brep', '.brp'],
  'application/x-pcd': ['.pcd'],
}

export default defineConfig({
  base,
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        id: base,
        name: '3D Viewer',
        short_name: '3D Viewer',
        description: 'Blazing-fast 3D model viewer & converter — STL, STEP, IGES, glTF, OBJ, FBX, 3MF, PLY and more.',
        theme_color: '#0a0b10',
        background_color: '#0a0b10',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        start_url: base,
        scope: base,
        categories: ['productivity', 'utilities', 'graphics'],
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Installed PWA becomes an "Open with…" target for model files.
        file_handlers: [{ action: base, accept: MODEL_TYPES }],
        launch_handler: { client_mode: 'focus-existing' },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,woff2}'],
        // The OpenCascade WASM (STEP/IGES) is ~7 MB; precache it so CAD works offline.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        navigateFallback: `${base}index.html`,
      },
    }),
  ],
})
