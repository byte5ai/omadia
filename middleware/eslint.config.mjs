import js from '@eslint/js';
import tseslint from 'typescript-eslint';

import {
  VIEWERLESS_GRAPH_READ_ALLOWLIST,
  VIEWERLESS_GRAPH_READ_SELECTORS,
} from './eslint/viewerlessGraphReads.mjs';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // LLM-provider decoupling (issue #298, docs/plans/issue-298-provider-plugins.md):
      // no middleware code — INCLUDING the @omadia/llm-provider runtime core — may
      // import a vendor SDK directly. Go through the neutral @omadia/llm-provider
      // contract. The wire-format adapters (@omadia/llm-adapter-anthropic and
      // @omadia/llm-adapter-openai) are the ONLY sanctioned SDK consumers and are
      // exempted in the override below.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'],
              message:
                'Import the neutral @omadia/llm-provider contract instead (LlmProvider, …). The Anthropic SDK is confined to @omadia/llm-adapter-anthropic. See docs/plans/issue-298-provider-plugins.md.',
            },
            {
              group: ['openai', 'openai/*'],
              message:
                'Import the neutral @omadia/llm-provider contract instead (LlmProvider, …). The OpenAI SDK is confined to @omadia/llm-adapter-openai. See docs/plans/issue-298-provider-plugins.md.',
            },
          ],
        },
      ],
    },
  },
  {
    // The wire-format adapter packages are the only places a vendor SDK is allowed.
    files: [
      'packages/llm-adapter-anthropic/**/*.ts',
      'packages/llm-adapter-openai/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
    },
  },
  {
    // Memory-ACL plan step 4b: no new knowledge-graph read without a viewer.
    rules: {
      'no-restricted-syntax': ['error', ...VIEWERLESS_GRAPH_READ_SELECTORS],
    },
  },
  {
    files: Object.keys(VIEWERLESS_GRAPH_READ_ALLOWLIST),
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
