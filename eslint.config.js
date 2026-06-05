import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // .claude/workflows/*.js are Workflow-tool runtime scripts (agent/phase/log/
    // parallel are injected globals) — not app source; don't lint them here.
    ignores: ['**/dist/**', '**/node_modules/**', '.argus/**', '.claude/**', '**/*.config.*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // arch-review #10: enforce the layering — the web app talks ONLY to its own origin via
    // @argus/contract; it must never import the adapter (format knowledge) or node:* builtins.
    // Tests are exempt (they load fixtures through the adapter — a test-helper concern).
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@argus/adapter', '@argus/adapter/*'],
              message: 'web is read-only over its own origin — use @argus/contract types, not the adapter (boundaries §1).',
            },
            { group: ['node:*'], message: 'the web app must not import node:* builtins.' },
          ],
        },
      ],
    },
  },
  {
    // Node-runtime scripts (the dev launcher) — give them Node globals.
    files: ['scripts/**/*.{mjs,js}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);
