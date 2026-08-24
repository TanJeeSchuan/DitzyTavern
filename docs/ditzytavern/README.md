# DitzyTavern system atlas

Open [atlas.html](./atlas.html) in a browser for the explorable architecture map. Read [SYSTEM.md](./SYSTEM.md) for the generated text twin. The source of truth is [atlas/data.mjs](./atlas/data.mjs); edit it and rebuild both views with:

```powershell
node docs/ditzytavern/atlas/build.mjs
```

| File | Role | Edit it? |
|---|---|---|
| `atlas/data.mjs` | Structures, flows, chapters, decisions, questions, and prose | Yes |
| `atlas/template.html` + `atlas/build.mjs` | Renderer and generator | Presentation only |
| `atlas.html` | Built interactive atlas | No, generated |
| `SYSTEM.md` | Built text twin | No, generated |
| `CONTEXT.md` | Hand-written domain glossary | Yes |
| `../adr/` | Hard-to-reverse decisions | Yes, when a real trade-off is settled |

The map distinguishes current source seams from ADR-settled but unimplemented edges with dashed ghost structures. Representative packet payloads are explanatory shapes, not captured traffic. Serve this folder with a static server before visual review; do not rely on `file://` behavior.

