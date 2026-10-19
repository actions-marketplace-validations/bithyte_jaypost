// Writes docs/openapi.yaml with the defaults of a fresh install; test/server/openapi.test.ts checks it.
import { writeFileSync } from 'node:fs'
import { DEFAULT_PORT } from '../src/config/index.ts'
import { DEFAULT_PROVIDER, PROVIDERS, requireProvider } from '../src/provider/index.ts'
import { formatOpenApiYaml } from '../src/server/index.ts'

const maxTextLength = requireProvider(PROVIDERS, DEFAULT_PROVIDER).maxTextLength
writeFileSync(
  new URL('../docs/openapi.yaml', import.meta.url),
  formatOpenApiYaml({ port: DEFAULT_PORT, maxTextLength }),
)
