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
];

export default eslintConfig;
