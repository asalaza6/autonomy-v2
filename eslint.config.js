import globals from 'globals';
import importPlugin from 'eslint-plugin-import';
import tsParser from '@typescript-eslint/parser';
import tsESLint from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: ['node_modules/**'],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'bin/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      parser: tsParser,
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: {
      import: importPlugin,
      '@typescript-eslint': tsESLint,
    },
    rules: {
      'import/no-default-export': 'error',
      'no-extra-semi': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportNamespaceSpecifier',
          message: 'Use named imports instead of namespace imports.',
        },
      ],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'after-used',
          varsIgnorePattern: '^_|^(h|Fragment)$',
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: false,
        },
      ],
    },
  },
];
