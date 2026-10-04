import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  globalIgnores(['out/', 'dist/', 'node_modules/', 'native/', 'resources/', '.claude/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs', 'tests/fixtures/**/*.mjs', '*.config.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
