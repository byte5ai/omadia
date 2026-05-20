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

  // eslint-plugin-react-hooks v6 (shipped with eslint-config-next 16) added
  // React-19-era strict rules. `refs`, `immutability` and `error-boundaries`
  // were cleaned up in #94 and now run at their default `error` severity.
  // `set-state-in-effect` still flags ~26 pre-existing call sites — many are
  // legitimate "sync external state into React" patterns needing per-site
  // judgement — so it stays `warn` until the follow-up batch lands (#94).
  {
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
];

export default eslintConfig;
