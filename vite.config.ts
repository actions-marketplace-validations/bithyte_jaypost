import { defineConfig } from 'vite-plus'

export default defineConfig({
  lint: {
    rules: {
      curly: 'error',
    },
  },
  fmt: {
    ignorePatterns: ['docs/**', 'package-lock.json'],
    semi: false,
    singleQuote: true,
    printWidth: 100,
  },
  // CJS copy of the library entry for require() consumers; tsc emits the ESM build into dist
  pack: {
    entry: 'src/index.ts',
    format: 'cjs',
    dts: true,
    clean: false,
    logLevel: 'warn',
  },
})
