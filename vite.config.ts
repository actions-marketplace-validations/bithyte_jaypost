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
})
