# 3D Viewer

**Live:** https://mohammadadib.github.io/3DViewer/

A fast, installable (PWA) 3D model viewer & converter that runs entirely in the browser — nothing is uploaded.

## Formats

| Open | Export |
| --- | --- |
| **STEP / STP**, **IGES / IGS**, BREP (OpenCascade WASM, in a worker) | **STL** (binary & ASCII) |
| **STL**, **glTF / GLB** (Draco, KTX2, Meshopt), **OBJ + MTL** | **OBJ** |
| FBX, 3MF, PLY, Collada (DAE), 3DS, AMF, USD/USDZ, VRML, PCD | **GLB / glTF**, PLY, USDZ |

Drop multiple files (or a whole folder) to load sidecar `.mtl`, `.bin` and textures.

## Features

- Environment lighting presets (Studio, Lightbox, Overcast, Sunset, Neon, Moonlight), key light direction / color / intensity, exposure & tone mapping, soft shadows
- Material override: presets (ceramic, clay, chrome, gold, glass…), any color, metalness / roughness / clearcoat / transmission, normals and X-ray modes
- Wireframe, CAD-style edge lines, flat shading, section cuts on X/Y/Z
- Perspective / orthographic, view gizmo, standard views, auto-rotate, double-click to set pivot
- Point-to-point measuring, model stats & bounding-box dimensions, parts list with visibility toggles, animation playback
- Hi-res PNG screenshots and 360° turntable video recording
- Works offline; once installed, it registers as an **Open with…** handler for model files
- `?url=<model-url>` opens a remote model

Press <kbd>?</kbd> in the app for keyboard shortcuts.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173/3DViewer/
npm run build    # type-check + production build to dist/
```

Pushing to `main` builds and deploys to GitHub Pages via `.github/workflows/deploy.yml`.

Built with [three.js](https://threejs.org), [occt-import-js](https://github.com/kovacsv/occt-import-js) and [vite-plugin-pwa](https://vite-pwa-org.netlify.app).
