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
