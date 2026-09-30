import { PlainMessagePortRpc, type Rpc } from '@lvce-editor/rpc'

// Own the Worker explicitly: the pinned RPC module-worker parent's dispose()
// intentionally does not terminate it. Closing only its port leaks the worker.
export async function launchWorker(url: string, commandMap: Record<string, (...args: any[]) => unknown>): Promise<{ worker: Worker; rpc: Rpc }> {
  const worker = new Worker(url, { type: 'module', name: 'LVCE collaboration' })
  const { port1, port2 } = new MessageChannel()
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); worker.removeEventListener('message', message); worker.removeEventListener('error', error) }
      const error = (event: ErrorEvent) => { cleanup(); reject(new Error(event.message)) }
      const message = (event: MessageEvent) => {
        if (event.data === 'ready') worker.postMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: ['message-port', port1] }, [port1])
        else if (event.data?.id === 1) {
          cleanup()
          if (event.data.error) reject(new Error(event.data.error.message))
          else resolve()
        }
      }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Worker startup timed out: ${url}`)) }, 10_000)
      worker.addEventListener('message', message)
      worker.addEventListener('error', error)
    })
    return { worker, rpc: await PlainMessagePortRpc.create({ commandMap, messagePort: port2 }) }
  } catch (error) {
    worker.terminate(); port1.close(); port2.close()
    throw error
  }
}
