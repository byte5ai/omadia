# The plugin UI vocabulary

**The contract a distributed plugin's user interface is built against.**
Shipped by C8 (`plan.md` §4.3a). Read this before writing a plugin UI, and
before widening the vocabulary.

---

## The one-paragraph version

A plugin ships **no stylesheet**. `.css` is absent from the plugin-ZIP
extension allowlist, will stay absent, and that absence *is* the enforcement.
A plugin's HTML links `/bot-api/_harness/plugin-ui.css`, which core generates
from web-ui's own Lume design tokens. Everything a plugin can express is
therefore a token, which is the point: it follows the operator's active
palette and light/dark mode automatically, and it cannot hardcode a hex and
drift. In exchange, a plugin may only use the utility classes listed below,
because Tailwind emits only what it has seen at build time and a plugin
installed at runtime from another repository is never seen.

---

## Where everything lives

| Thing | Path |
|---|---|
| Token bridge (shared with the shell — never copy it) | `web-ui/app/_lib/tailwind-bridge.css` |
| Design tokens | `web-ui/app/_lib/theme.css` |
| Vocabulary source | `web-ui/scripts/plugin-ui.source.css` |
| Build script | `web-ui/scripts/build-plugin-ui-css.mjs` |
| Committed artifact | `middleware/assets/plugin-ui/plugin-ui.css` |
| Served at | `GET /api/_harness/plugin-ui.css` (browser: `/bot-api/…`) |
| Legacy alias | `GET /api/_harness/admin-ui.css` — same bytes |
| Bundle served at | `GET /p/<pluginId>/ui/…` |
| Host page | `/plugin-ui/<pluginId>` in web-ui |
| Ingest check | `middleware/src/plugins/tailwindArbitraryValueScan.ts` |
| Worked example | `middleware/test/fixtures/plugin-ui-proof/` |

---

## The hard constraint: no arbitrary values

```
✗ w-[137px]      ✗ bg-[#abc]      ✗ grid-cols-[1fr_2fr]
✗ md:hover:w-[42rem]              ✗ [&>tr]:border-border
```

An *exact* arbitrary value **can** be pre-generated — `@source
inline("w-[137px]")` emits precisely that class. The **unbounded universe** of
them cannot. So an arbitrary value core has not been told about renders
unstyled, silently, on the operator's screen and nowhere else. That is the
worst failure mode available, which is why it is rejected at package ingest
rather than left to discover in production.

The ingest scanner reads the **compiled bundle**, not JSX. By the time a
package arrives, `className={cn('p-4', wide && 'w-[137px]')}` has become the
string literals `"p-4"` and `"w-[137px]"` in `ui/**/*.js`, and both are plain
substrings. Two patterns run:

| Pattern | Matches |
|---|---|
| `(?<![\w:$-])((?:[a-z][a-z0-9]*:)*[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\[[^\]\s"'`]+\])` | `w-[137px]`, `md:hover:bg-[#abc]`, `grid-cols-[1fr_2fr]` |
| `(\[&[^\]\s"'`]*\](?::[a-z0-9[\]&_>-]+)?)` | `[&>tr]:border`, `[&_p]:mt-2` |

### Known limits, stated rather than papered over

- **False positives are possible.** The scan is textual, and text in a bundle
  is not only class names. Prose like `"see step-[2] of the guide"` is
  reported. The mitigation is the report, not the regex: every offender
  carries file, 1-based line and the matched token, so an author sees in one
  glance that the hit is not a class. Two narrowings keep the rate low — the
  utility head must be lower-case-and-dashes (so `arr[i]` and `getFoo[0]`
  never match), and the bracket body may not contain whitespace, quotes or
  backticks (so most prose and most expressions drop out).
  *This is not theoretical: the first run of the proof fixture rejected its
  own explanatory comment.*
- **False negatives are possible**, and that is the safer direction. A bundle
  that assembles a class at runtime defeats any static check. Nothing here
  claims otherwise — the vocabulary is the contract, this is its cheap
  enforcement, and a plugin that routes around it merely ends up unstyled.
- **Only `ui/**/*.js` and `ui/**/*.mjs` are scanned**, capped at 200 files /
  8 MB. A bundle elsewhere is neither scanned nor served.

---

## The vocabulary

Canonical source is `web-ui/scripts/plugin-ui.source.css`; this table is the
human-readable form of it. Brace ranges expand — `p-{0..12}` means `p-0`
through `p-12`.

### Layout

| Group | Classes |
|---|---|
| Display | `flex` `inline-flex` `grid` `block` `inline-block` `inline` `contents` `hidden` |
| Flex | `flex-row` `flex-row-reverse` `flex-col` `flex-wrap` `flex-nowrap` `flex-1` `flex-auto` `flex-initial` `flex-none` · `shrink-0/1` `grow-0/1` |
| Alignment | `items-{start,center,end,baseline,stretch}` · `justify-{start,center,end,between,around,evenly}` · `self-{auto,start,center,end,stretch}` |
| Grid | `grid-cols-{1..6}` · `col-span-{1..6}` |
| Gap | `gap-{0..8}` `gap-x-{0..8}` `gap-y-{0..8}` |
| Size | `w-/h-{full,auto,fit,screen}` · `w-/h-{0,1,2,3,4,5,6,8,10,12,16,20,24,32}` · `min-w-/min-h-{0,full}` · `max-w-{none,full,xs…7xl}` |
| Overflow | `overflow-{auto,hidden,visible,x-auto,y-auto}` |
| Position | `relative` `absolute` `fixed` `sticky` `static` · `inset-/top-/right-/bottom-/left-{0,auto}` · `z-{0,10,20,30,40,50}` |
| Centering | `mx-auto` |

### Spacing

`p-/px-/py-/pt-/pr-/pb-/pl-{0..12}` · `m-/mx-/my-/mt-/mr-/mb-/ml-{0..12}` ·
`space-x-/space-y-{0..6}`

### Typography

| Group | Classes |
|---|---|
| Size | `text-{xs,sm,base,lg,xl,2xl,3xl,4xl}` |
| Weight | `font-{normal,medium,semibold,bold}` |
| Family | `font-{sans,mono,serif}` |
| Align | `text-{left,center,right,justify}` |
| Transform | `truncate` `uppercase` `lowercase` `capitalize` `normal-case` |
| Decoration | `underline` `no-underline` `line-through` `italic` `not-italic` |
| Leading | `leading-{none,tight,snug,normal,relaxed,loose}` |
| Tracking | `tracking-{tighter,tight,normal,wide,wider}` |
| Wrapping | `whitespace-{normal,nowrap,pre,pre-wrap}` · `break-{words,all,keep}` |
| Lists | `list-none` `list-disc` `list-decimal` `list-inside` |
| Numerals | `tabular-nums` |
| Vertical | `align-{top,middle,bottom,baseline}` |

### Colour — the Lume tokens, and only those

There is **no Tailwind palette here**. `bg-blue-500` does not exist and will
not be added. The available colour names are the design system's semantic
roles, each wired to the runtime CSS variable:

| Prefix | Values | Variants |
|---|---|---|
| `bg-` | `bg` `bg-soft` `bg-elevated` `surface` `accent` `accent-hover` `accent-subtle` `danger` `success` `warning` `transparent` | `hover:` `focus:` |
| `text-` | `fg` `fg-strong` `fg-muted` `fg-subtle` `accent` `accent-hover` `danger` `success` `warning` `bg` | `hover:` `focus:` |
| `border-` | `border` `border-strong` `accent` `danger` `success` `warning` `transparent` | `hover:` `focus:` |
| `decoration-` | `accent` `fg-muted` | `hover:` |

### Borders and shape

`border` `border-{0,2,4}` · `border-{t,r,b,l}` ·
`border-{solid,dashed,dotted,none}` ·
`rounded` `rounded-{none,sm,md,lg,xl,full}` ·
`shadow` `shadow-{none,sm,md,lg}` · `divide-y` `divide-x`

### Interaction and state

`opacity-{0,25,50,60,75,100}` (+ `hover:` `focus:`) ·
`cursor-{pointer,default,not-allowed,wait,text}` ·
`select-{none,text,all}` · `pointer-events-{none,auto}` ·
`transition` `transition-{none,all,colors,opacity,transform}` ·
`duration-{75,100,150,200,300,500}` · `ease-{linear,in,out,in-out}` ·
`animate-{none,spin,pulse}` ·
`disabled:{opacity-50,cursor-not-allowed,pointer-events-none}` ·
`focus-visible:outline-none` · `sr-only` `not-sr-only`

### Responsive

Breakpoints `sm:` `md:` `lg:` `xl:` are available on:
`flex` `grid` `block` `inline-block` `hidden` · `grid-cols-{1..4}` ·
`flex-{row,col}` (sm/md/lg) · `p-/px-/py-{0,2,4,6,8}` (sm/md/lg) ·
`text-{sm,base,lg,xl,2xl}` (sm/md/lg) ·
`max-w-{sm,md,lg,xl,2xl,4xl}` (sm/md/lg)

### Baseline element styling

Plugins get sensible defaults for `body`, headings, `p`, `a`, `code`, `pre`,
`hr`, `table`/`th`/`td`, `input`/`select`/`textarea`/`button` — all
token-driven, all in `@layer base` so any utility class above wins over them.

### `.harness-*` compatibility helpers — frozen

`.harness-admin` `.harness-subtitle` `.harness-empty` `.harness-btn`
`.harness-btn--primary` `.harness-input` `.harness-table`
`.harness-banner-error` `.harness-banner-info`

These exist because shipped plugin admin UIs already link them via
`admin-ui.css`. They are kept so an upgrade does not restyle every installed
plugin, and they are now generated from the same tokens as everything else
rather than hand-mirrored. **New UIs should use the utilities above.** The
helper set is frozen: it will not be extended.

---

## What a plugin ships

```
my-plugin.zip
├── manifest.yaml
├── package.json
├── dist/plugin.js
└── ui/
    ├── index.html            ← links /bot-api/_harness/plugin-ui.css
    └── assets/
        ├── app-7c1f4b2e.js   ← hashed → cached immutably
        └── logo.svg
```

Allowed inside `ui/`: `.html` `.js` `.mjs` `.map` `.json` `.svg` `.png`
`.jpg`/`.jpeg` `.woff2` `.txt`. **Not** `.css` — and `.woff2` is allowed
*only* under `ui/`, since nothing else in a package has business shipping a
font.

### The iframe boundary — two things that do not cross it

An iframe is a separate document. Two silent regressions follow
(`implementation.md` §2.3), and both are handled:

1. **`next/font` does not cross.** The shell's faces are injected into
   web-ui's document only. The generated stylesheet therefore re-binds
   `--font-geist`, `--font-geist-mono` and `--font-source-serif`. This is not
   cosmetic: `theme.css` composes `--font-sans: var(--font-geist), system-ui,
   …`, and an *undefined* var invalidates the whole declaration, dropping the
   UI to the browser's serif default.
2. **`data-theme` / `data-palette` do not cross.** Without them a plugin
   renders light inside a shell the operator forced dark — a bug that looks
   like the plugin's fault. The host page passes `?theme=&palette=&locale=`
   and the plugin mirrors them onto its own `<html>` before first paint:

```html
<link rel="stylesheet" href="/bot-api/_harness/plugin-ui.css" />
<script>
  (function () {
    var p = new URLSearchParams(window.location.search);
    var t = p.get('theme');
    if (t === 'light' || t === 'dark')
      document.documentElement.setAttribute('data-theme', t);
    var pal = p.get('palette');
    if (pal && /^[a-z]+$/.test(pal))
      document.documentElement.setAttribute('data-palette', pal);
  })();
</script>
```

### Appearing in the shell navigation

Use the existing nav contribution API (PR #536) from `activate()`:

```ts
ctx.uiRoutes.registerNav({
  navId: 'main',
  href: `/plugin-ui/${pluginId}`,
  cluster: 'adminCluster',
  label: { en: 'My Plugin', de: 'Mein Plugin' },
});
```

`href` is validated as an in-app single-slash path, so `/plugin-ui/<id>`
resolves and `//evil.example` does not.

---

## Widening the vocabulary

Widen it from what a real ported page needs — never speculatively. Every line
is a promise to plugin authors and a cost in bytes on every plugin UI load.

1. Edit `web-ui/scripts/plugin-ui.source.css`.
2. `cd web-ui && npm run plugin-ui:css`.
3. Commit the regenerated `middleware/assets/plugin-ui/plugin-ui.css`.
4. Update this document.

CI regenerates and diffs (`npm run plugin-ui:css:check`, inside the existing
web-ui job), so an edit to the source, the tokens or the bridge that was not
regenerated fails loudly rather than shipping a stylesheet that disagrees with
the shell.
