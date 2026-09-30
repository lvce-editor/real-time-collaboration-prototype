import { createCollaboration } from './session-server.js'
// The pinned LVCE server owns HTTP listening. Local postinstall hooks mount this
// isolated view without exposing LVCE's unauthenticated local filesystem RPC.
globalThis.lvceCollaboration = createCollaboration()
process.env.HOST ||= '127.0.0.1'
await import('@lvce-editor/server/bin/server.js')
