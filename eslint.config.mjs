import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Prevent unhandled promise rejections & floating promises
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: {
            arguments: false, // Allows async Express route handlers without requiring void wrappers
          },
        },
      ],

      // Enforce strict typing
      '@typescript-eslint/no-explicit-any': 'error',

      // Restrict raw console usage in favor of structured logger
      'no-console': 'error',
    },
  },
  {
    // Exceptions for CLI scripts and the core logger where console output is expected
    files: ['scripts/**/*.ts', 'src/cli/**/*.ts', 'src/utils/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'packages/'],
  }
);