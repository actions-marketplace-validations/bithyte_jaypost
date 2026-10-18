import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    ignorePatterns: ['docs/**', 'package-lock.json'],
    semi: false,
    singleQuote: true,
    printWidth: 100,
  },
})
