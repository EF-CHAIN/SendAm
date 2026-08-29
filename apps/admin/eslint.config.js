import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // adminApi.js strips cursor/limit keys via rest destructuring
      // (`const { after, before, limit, ...filters } = params`); the stripped
      // siblings are intentionally never read.
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    // Vite config runs in Node, so it needs Node globals (e.g. __dirname).
    files: ['vite.config.js'],
    languageOptions: { globals: globals.node },
  },
])
