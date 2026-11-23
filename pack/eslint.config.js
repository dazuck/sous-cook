import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    files: ['**/*.{ts,js}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Tests assert on structures they just built; a wrong `!` throws and fails the test.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Fixture mutation drills into schema-shaped (snake_case, unknown-keyed) records.
      '@typescript-eslint/dot-notation': 'off',
    },
  },
);
