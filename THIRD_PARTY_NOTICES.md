# Third-Party Notices

The Omadia platform is licensed under the [MIT License](LICENSE). The
notices in this file apply to upstream dependencies bundled with the
`middleware` and `web-ui` workspaces — the upstream projects retain their
respective licenses and copyright. Nothing below modifies the MIT terms
that govern Omadia itself.

Generated 2026-05-07 via `license-checker-rseidelsohn --csv
--excludePrivatePackages` against both workspaces. To regenerate after a
dependency change see [Regenerating This File](#regenerating-this-file).

## License Inventory

| Workspace | Total packages | Permissive¹ | Weak copyleft (LGPL/MPL) | Public-domain-like² | Dual-licensed |
|---|---:|---:|---:|---:|---:|
| `middleware` | 500 | 497 | 1 (LGPL) | 1 (BlueOak) | 2 |
| `web-ui` | 584 | 575 | 4 (LGPL ×1, MPL ×3) | 4 (CC0, CC-BY-4.0, MIT-0, BlueOak) | 2 |

¹ MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Python-2.0.
² Public-domain or attribution-only licenses with no copyleft effect.

**No GPL, AGPL, or SSPL dependencies are present in either workspace.**

## Notable Dependency: LGPL-3.0-or-later — `@img/sharp-libvips-*`

The [`sharp`](https://github.com/lovell/sharp) image library bundles
platform-specific [`libvips`](https://github.com/lovell/sharp-libvips)
binaries under LGPL-3.0-or-later. Harness consumes `sharp` exclusively via
its public Node.js API (dynamic linking), which does not trigger LGPL's
source-distribution requirement. This notice satisfies the license's
attribution clause.

| Package | License | Project |
|---|---|---|
| `@img/sharp-libvips-darwin-arm64` | LGPL-3.0-or-later | <https://github.com/lovell/sharp-libvips> |
| `@img/sharp-libvips-darwin-x64` *(installed conditionally per platform)* | LGPL-3.0-or-later | <https://github.com/lovell/sharp-libvips> |
| `@img/sharp-libvips-linux-x64` *(installed conditionally per platform)* | LGPL-3.0-or-later | <https://github.com/lovell/sharp-libvips> |
| `@img/sharp-libvips-linux-arm64` *(installed conditionally per platform)* | LGPL-3.0-or-later | <https://github.com/lovell/sharp-libvips> |

Used in: middleware (image side-effect tooling, `sharp` direct import) and
web-ui (Next.js Image component runtime).

## MPL-2.0 Dependencies

[MPL-2.0](https://www.mozilla.org/MPL/2.0/) is a file-level weak copyleft
license. Bundling unmodified upstream sources is permitted; only
modifications to the MPL-licensed files themselves would trigger the
source-disclosure obligation, which Harness does not perform.

| Package | License | Project | Used in |
|---|---|---|---|
| `axe-core` | MPL-2.0 | <https://github.com/dequelabs/axe-core> | web-ui (a11y dev tooling) |
| `lightningcss` | MPL-2.0 | <https://github.com/parcel-bundler/lightningcss> | web-ui (Next.js CSS pipeline) |
| `lightningcss-darwin-arm64` *(platform-conditional)* | MPL-2.0 | <https://github.com/parcel-bundler/lightningcss> | web-ui |
| `dompurify` | MPL-2.0 OR Apache-2.0 — Harness elects Apache-2.0 | <https://github.com/cure53/DOMPurify> | web-ui (HTML sanitisation) |

## Other Non-Standard Licenses

| Package | License | Project |
|---|---|---|
| `argparse` | Python-2.0 (BSD-style, permissive) | <https://github.com/nodeca/argparse> |
| `tslib` | 0BSD (effectively public domain) | <https://github.com/Microsoft/tslib> |
| `caniuse-lite` | CC-BY-4.0 (attribution required) | <https://github.com/browserslist/caniuse-lite> |
| `language-subtag-registry` | CC0-1.0 (public domain) | <https://github.com/mattcg/language-subtag-registry> |
| `@csstools/color-helpers` | MIT-0 (no-attribution MIT) | <https://github.com/csstools/postcss-plugins> |
| `minimatch` | BlueOak-1.0.0 (permissive, OSI-approved) | <https://github.com/isaacs/minimatch> |
| `expand-template` | MIT OR WTFPL — Harness elects MIT | <https://github.com/ralphtheninja/expand-template> |
| `rc` | BSD-2-Clause OR MIT OR Apache-2.0 — Harness elects MIT | <https://github.com/dominictarr/rc> |

## Regenerating This File

After dependency updates that may change the non-permissive license set,
re-run:

```bash
cd middleware && npx --yes license-checker-rseidelsohn \
  --csv --excludePrivatePackages > /tmp/middleware-licenses.csv

cd ../web-ui && npx --yes license-checker-rseidelsohn \
  --csv --excludePrivatePackages > /tmp/web-ui-licenses.csv

# Diff against the package list above; if a non-MIT/Apache/ISC/BSD
# license appears, add an entry to the relevant table.
```

Quick non-permissive scan:

```bash
awk -F'","' 'NR>1 && $2 !~ /^MIT$/ && $2 !~ /^ISC$/ \
  && $2 !~ /^Apache-2\.0$/ && $2 !~ /^BSD-(2|3)-Clause$/ \
  && $2 !~ /^Unlicense$/ && $2 !~ /^0BSD$/ {print}' \
  /tmp/middleware-licenses.csv /tmp/web-ui-licenses.csv
```
