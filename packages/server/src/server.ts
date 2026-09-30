import { createCollaboration } from '@lvce-editor/real-time-collaboration/server'
// The pinned LVCE server owns HTTP listening. Local postinstall hooks mount this
// isolated view without exposing LVCE's unauthenticated local filesystem RPC.
declare global {
  var lvceCollaboration: ReturnType<typeof createCollaboration> | undefined
}

globalThis.lvceCollaboration = createCollaboration()
process.env.HOST ||= '127.0.0.1'
await import('@lvce-editor/server/bin/server.js')
