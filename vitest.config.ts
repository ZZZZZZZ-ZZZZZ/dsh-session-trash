import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The published ui-primitives build expects the DSH page (CSS modules, page
// modules). Tests render the same 0.2.0-rc.2 components from source copies in
// tests/vendor.
const primitives = fileURLToPath(new URL('./tests/primitives-shim.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [{ find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: primitives }],
    dedupe: ['react', 'react-dom'],
  },
  css: { modules: { generateScopedName: '[local]' } },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
    testTimeout: 30_000,
    css: { include: /.+/, modules: { classNameStrategy: 'non-scoped' } },
  },
})
