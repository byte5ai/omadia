# README media assets

The top-of-README "wow moment" lives or dies on visual proof. This folder holds
the screenshots and the demo GIF referenced from the root [`README.md`](../../README.md).

> **None of these are committed yet.** The README references them by path and
> falls back to a text placeholder until the files land here. Drop the captured
> files in with the exact names below and the README renders them automatically.

## Files the README expects

| File | What it shows | Where it's used |
|------|---------------|-----------------|
| `omadia-demo.gif` | 20–30 s loop: a prompt goes in, an agent team works, an audit receipt comes out | Hero block, very top |
| `screenshot-builder.png` | The Builder UI authoring a plugin (slot-fill + smoke runner) | "What's in the box" |
| `screenshot-trace.png` | A routine run with the per-run trace + call-stack viewer (the audit receipt) | "Why omadia?" / audit trail |
| `screenshot-admin.png` | The admin/management UI dashboard after first-run setup | First-run demo |

## How to capture the demo GIF (the important one)

Target: **20–30 seconds**, ≤ ~6 MB so GitHub inlines it, 1280×800 source.

1. `docker compose up -d` and complete the `/setup` wizard at `http://localhost:3333`.
2. Start a demo agent team from a single prompt (the "first-run demo" in the README).
3. Show the agents working (streaming turns / tool dispatch).
4. End on the **audit receipt**: open the routine's per-run trace + call-stack viewer.

Recording tips:
- macOS: [Kap](https://getkap.co) or [Gifski](https://gif.ski) → export GIF (palette-optimized).
- Keep the cursor deliberate; trim dead air. Loop should feel inevitable, not rushed.
- Compress: `gifsicle -O3 --lossy=80 in.gif -o omadia-demo.gif`.

## Screenshots

Capture at 1280×800 (or 2× retina then downscale), PNG, light theme for contrast
against GitHub's README background. Crop chrome; show the product, not the browser.
