# plugin-ui fonts

Drop `.woff2` files here to have them served to plugin UIs at
`/api/_harness/plugin-ui/fonts/<file>` (browser: `/bot-api/...`) and declared
as `@font-face` inside the generated `plugin-ui.css`.

`next/font` injects the shell's faces into web-ui's own document only, and an
iframe is a separate document — so a plugin UI never inherits them
(`implementation.md` §2.3, in the epic #470 spec directory). The generated
stylesheet therefore always binds `--font-geist`, `--font-geist-mono` and
`--font-source-serif`: with this directory empty it binds the platform
fallback stacks, with a file present it binds the real family. Leaving them
unbound would not merely lose the face — `theme.css` composes
`--font-sans: var(--font-geist), system-ui, …`, and an undefined var
invalidates the whole declaration, dropping the plugin UI to the browser's
serif default.

Recognised names (matched case-insensitively by
`web-ui/scripts/build-plugin-ui-css.mjs`):

| file | family | bound variable |
|---|---|---|
| `geist.woff2` | `Geist` | `--font-geist` |
| `geist-mono.woff2` | `Geist Mono` | `--font-geist-mono` |
| `source-serif.woff2` | `Source Serif 4` | `--font-source-serif` |

After adding or removing a file, regenerate the stylesheet:

```
cd web-ui && npm run plugin-ui:css
```

No face ships today: the shell's own are downloaded by `next/font/google` at
build time and are committed nowhere in this repo.
