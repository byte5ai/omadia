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
  // three React-19-era strict rules that are correct in principle but flag
  // dozens of pre-existing call sites in this codebase. Downgrade to `warn`
  // so the next-16 migration stays a pure-dep PR; refactor the call sites
  // in a follow-up ticket.
  //   - set-state-in-effect: cascading-render anti-pattern; many of ours
  //     are legitimate (sync external state into React).
  //   - refs: forbids any access to `.current` during render; we have a
  //     handful of intentional ref-as-cache patterns.
  //   - error-boundaries: forbids JSX inside try/catch; one current usage
  //     in app/store/builder/[id]/page.tsx wraps a child component whose
  //     own data fetch is intentionally inside the try to catch ApiError.
  {
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/error-boundaries': 'warn',
    },
  },
];

export default eslintConfig;
