import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    css: false,
    // The whole suite runs on the fast node pool; the panel spec opts itself
    // into jsdom with a `@vitest-environment` docblock.
    environment: 'node',
    // `*.spec.*` lives under tests/; a module's own colocated spec keeps its
    // evidence next to what it covers — `*.test.ts` on the host half (the admin
    // routes) and `*.test.tsx` for a component such as TeamAdmin.
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    server: {
      deps: {
        // The primitives package ships component CSS (and pulls katex's) through
        // plain imports: Vite must transform it, node's ESM loader cannot.
        inline: [/@deepseek-ai\/dsh-client-ui-/],
      },
    },
  },
})
