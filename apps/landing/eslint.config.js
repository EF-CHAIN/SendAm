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
  },
  {
    // Vite config runs in Node, so it needs Node globals (e.g. __dirname).
    files: ['vite.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // Tests run under Vitest/jsdom (browser globals) but some also touch
    // Node APIs directly (e.g. process.cwd() to resolve a fixture path).
    files: ['**/*.test.{js,jsx}', 'src/test/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
])
