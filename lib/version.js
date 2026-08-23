import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const ALLY_VERSION = require('../package.json').version
