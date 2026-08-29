// Registers the host-peer resolve hook (see host-peer-hook.mjs).
import { register } from 'node:module'

register('./host-peer-hook.mjs', import.meta.url)
