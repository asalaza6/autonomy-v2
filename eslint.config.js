import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsESLint from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: ['node_modules/**'],
  },
  {
    files: ['src/**/*.{js,ts}', 'tests/**/*.{js,ts}', 'bin/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      parser: tsParser,
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: {
      '@typescript-eslint': tsESLint,
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'after-used',
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: false,
        },
      ],
    },
  },
];
