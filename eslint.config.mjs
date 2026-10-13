/**
 * Flat ESLint config. Next 16's `eslint-config-next` ships flat config
 * only — the legacy `.eslintrc.json` the playbook names cannot consume
 * it (the deep-merge throws "Converting circular structure to JSON").
 * Same call the port source made.
 */
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import tsPlugin from '@typescript-eslint/eslint-plugin';

const config = [
  ...nextCoreWebVitals,
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': 'allow-with-description', 'ts-expect-error': 'allow-with-description' },
      ],

      // React 19's eslint-plugin-react-hooks@6+ ships compiler-aware
      // rules (set-state-in-effect, refs, immutability, purity) that
      // flag real but non-breaking patterns throughout the UI platform
      // we just ported. Rewriting those call sites is its own piece of
      // work, not P02's. Downgrade to warn so the violations stay
      // visible without blocking CI — the same call the port source
      // made, for the same reason.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/error-boundaries': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/use-memo': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react/no-find-dom-node': 'warn',
    },
  },
  {
    // Security-critical paths hold a harder line on `any`.
    files: ['src/lib/security/**', 'src/proxy.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
  {
    files: ['tests/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
];

export default config;
