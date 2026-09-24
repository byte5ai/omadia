// Flat-config for ESLint 9 + eslint-config-next 16.
// eslint-config-next 16 ships native flat-config arrays via its sub-path
// exports (`next/core-web-vitals` and `next/typescript`); the v15-era
// FlatCompat-wrapper bridge is no longer needed and in fact breaks at
// load time (circular plugin refs in the legacy schema validator).
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const eslintConfig = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // eslint-config-next 16 promoted the React Compiler heuristic
    // `react-hooks/set-state-in-effect` to an error. It flags idiomatic
    // mount-fetch (`void refresh()`) and prop-sync effects that predate the
    // upgrade across the app. Keep it visible as a warning (like the existing
    // no-unused-vars warnings) rather than block CI on a framework-bump
    // heuristic — adopt/refactor incrementally.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    // Font-CDN gate. `next/font/google` self-hosts at runtime but DOWNLOADS at
    // build time, so a runner that cannot reach fonts.googleapis.com fails the
    // whole build. That took out the macOS x64 desktop build on `7a0d4675`,
    // which cost the release its x64 artifact, `mac-update-feed` and
    // `promote-release`. Faces are vendored as woff2 in `app/_fonts/` and
    // loaded with `next/font/local`; adding a family means adding a file there.
    files: ['**/*.{ts,tsx,js,jsx,mjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'next/font/google',
              message:
                'Downloads fonts at build time, so the build needs the font CDN. Vendor the woff2 into app/_fonts/ and use next/font/local — see app/_fonts/index.ts.',
            },
          ],
          patterns: [
            {
              group: ['next/font/google/*'],
              message:
                'Downloads fonts at build time, so the build needs the font CDN. Vendor the woff2 into app/_fonts/ and use next/font/local — see app/_fonts/index.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    // Lume Button gate (issue #290). Raw <button> drifts back in with every
    // new feature; the material layer keeps the look but not the §6.4 press
    // feel, and per-call className soup re-diverges from the §4.2 variants.
    // Flag every raw <button> so a real button goes through the canonical
    // <Button> (app/_components/ui/Button.tsx). Deliberate non-candidates —
    // tabs/toggles, icon-only chrome, text-as-link, or a bespoke affordance
    // with no §4.2 variant — carry an inline
    // `eslint-disable-next-line no-restricted-syntax` with a one-line reason.
    // Note: <motion.button> inside the component itself is a member
    // expression, not `button`, so it is not matched here.
    files: ['app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXOpeningElement[name.name='button']",
          message:
            'Use the canonical <Button> (app/_components/ui/Button.tsx) for real buttons — it encodes the visual-spec §4.2 variants, §6.4 press/hover feel, and §7.3 busy recipe. For a deliberate non-candidate (tab/toggle, icon-only chrome, text link, or a bespoke affordance with no §4.2 variant), add `eslint-disable-next-line no-restricted-syntax` with a short reason.',
        },
      ],
    },
  },
];

export default eslintConfig;
