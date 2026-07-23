import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    // Ignore generated output and Prisma artifacts.
    ignores: ['node_modules/**', 'prisma/generated/**'],
  },
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      // CommonJS globals: require, module, exports, __dirname, __filename,
      // process, Buffer, setTimeout, setImmediate, URL, console, etc.
      globals: {
        ...globals.node,
        ...globals.nodeBuiltin,
      },
      // Node 18+ supports top-level await in ESM, but this project uses CJS.
      sourceType: 'commonjs',
    },
    rules: {
      // Parameters prefixed with _ are intentionally unused (e.g. Express
      // 4-arity error handlers that must declare req/next to be recognised,
      // or catch(e) blocks that discard the error after logging it).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
]);
