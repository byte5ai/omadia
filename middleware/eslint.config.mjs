import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
      // LLM-provider decoupling (docs/plans/llm-provider-interface-plan.md):
      // no middleware code may import the Anthropic SDK directly — go through
      // the neutral @omadia/llm-provider contract. The Anthropic adapter (the
      // ONLY sanctioned SDK consumer) lives in packages/llm-provider, which is
      // exempted in the override below.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'],
              message:
                'Import the neutral @omadia/llm-provider contract instead (LlmProvider, createAnthropicProvider, AnthropicClient, …). The Anthropic SDK is confined to packages/llm-provider. See docs/plans/llm-provider-interface-plan.md.',
            },
          ],
        },
      ],
    },
  },
  {
    // The Anthropic reference adapter is the one place the SDK is allowed.
    files: ['packages/llm-provider/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
    },
  },
);
