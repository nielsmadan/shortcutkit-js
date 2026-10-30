import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  js.configs.recommended,
  ...tseslint.configs.strict,
  prettierConfig,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['packages/react/**/*.{ts,tsx}', 'examples/react-playground/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/target/**', '**/gen/**', '.claude/**'],
  },
];
