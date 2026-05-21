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
];

export default eslintConfig;
