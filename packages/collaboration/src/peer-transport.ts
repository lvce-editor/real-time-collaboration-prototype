// RTCPeerConnection belongs to the browser window, not the transport worker.
// WebSocket remains the authority/recovery path; peers relay signed committed data.
type Member = { id: string; online: boolean }
type Envelope = { payload: string; signature: string }
type Peer = { connection: RTCPeerConnection; channel?: RTCDataChannel; queue: Promise<void>; queued: number }
export class PeerTransport {
  private peers = new Map<string, Peer>()
  private key?: Promise<CryptoKey>
  private self = ''
  private session = ''
  private generation = 0
  constructor(private signal: (message: unknown) => void, private receive: (message: unknown, isCurrent: () => boolean) => void, private log: (event: string) => void) {}
  reset(snapshot?: { peerKey?: JsonWebKey; self: Member; session: string; members: Member[] }): void {
    this.generation++
    for (const peer of this.peers.values()) peer.connection.close()
    this.peers.clear()
    this.key = undefined
    if (!snapshot?.peerKey || !globalThis.RTCPeerConnection || !globalThis.crypto?.subtle) return
    this.self = snapshot.self.id
    this.session = snapshot.session
    this.key = crypto.subtle.importKey('jwk', snapshot.peerKey, 'Ed25519', false, ['verify'])
    // Handle unsupported crypto without an unhandled rejection; WS stays usable.
    void this.key.catch(() => this.reset())
    for (const member of snapshot.members) this.member(member)
  }
  member(member: Member): void {
    if (!this.key || member.id === this.self) return
    this.peers.get(member.id)?.connection.close()
    this.peers.delete(member.id)
    if (!member.online) { this.log('WebRTC peer disconnected'); return }
    const connection = new RTCPeerConnection({ iceServers: [] })
    const peer: Peer = { connection, queue: Promise.resolve(), queued: 0 }
    this.peers.set(member.id, peer)
    connection.ondatachannel = event => this.channel(member.id, peer, event.channel)
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed') connection.close()
    }
    if (this.self < member.id) {
      this.channel(member.id, peer, connection.createDataChannel('collaboration', { ordered: true }))
      this.queue(member.id, peer, async () => {
        await connection.setLocalDescription(await connection.createOffer())
        await this.describe(member.id, peer)
      })
    }
  }
  private queue(id: string, peer: Peer, action: () => Promise<void>): void {
    if (peer.queued >= 64) { peer.connection.close(); return }
    peer.queued++
    peer.queue = peer.queue.then(async () => {
      if (this.peers.get(id) === peer) await action()
    }).catch(error => { peer.connection.close(); this.log(`WebRTC unavailable; using server transport (${error instanceof Error ? error.name : 'Unknown error'})`) }).finally(() => { peer.queued-- })
  }
  private async describe(id: string, peer: Peer): Promise<void> {
    const connection = peer.connection
    // Send one SDP with all local ICE candidates, avoiding trickle ordering races.
    if (connection.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer)
        connection.removeEventListener('icegatheringstatechange', check)
        connection.removeEventListener('connectionstatechange', check)
      }
      const check = () => {
        if (connection.connectionState === 'closed') { finish(); reject(new Error('Closed')) }
        else if (connection.iceGatheringState === 'complete') { finish(); resolve() }
      }
      const timer = setTimeout(() => { finish(); reject(new Error('ICE timeout')) }, 10_000)
      connection.addEventListener('icegatheringstatechange', check)
      connection.addEventListener('connectionstatechange', check)
      check()
    })
    // Native RTCSessionDescription objects cannot cross the worker structured-clone boundary.
    if (this.peers.get(id) === peer) this.signal({ type: 'signal', to: id, description: connection.localDescription?.toJSON() })
  }
  accept(from: string, description: RTCSessionDescriptionInit): void {
    const peer = this.peers.get(from)
    if (!peer) return
    this.queue(from, peer, async () => {
      await peer.connection.setRemoteDescription(description)
      if (description.type === 'offer') {
        await peer.connection.setLocalDescription(await peer.connection.createAnswer())
        await this.describe(from, peer)
      }
    })
  }
  relay(envelope: Envelope): void {
    const data = JSON.stringify(envelope)
    // Large edits and slow/unavailable peers use the existing bounded WS delivery.
    if (data.length > 60_000) return
    for (const { channel } of this.peers.values()) {
      if (channel?.readyState === 'open' && channel.bufferedAmount < 1_000_000) {
        try { channel.send(data) } catch { /* WS already delivered the committed data. */ }
      }
    }
  }
  private channel(id: string, peer: Peer, channel: RTCDataChannel): void {
    peer.channel = channel
    const generation = this.generation
    let lastCursor = 0
    channel.onopen = () => this.log('WebRTC peer connected')
    channel.onmessage = event => {
      // Serialize verification and bound payloads; never trust a peer's role claim.
      if (typeof event.data !== 'string' || event.data.length > 60_000) return
      this.queue(id, peer, async () => {
        if (!this.key) return
        const envelope = JSON.parse(event.data) as Envelope
        const signature = Uint8Array.from(atob(envelope.signature), c => c.charCodeAt(0))
        if (!await crypto.subtle.verify('Ed25519', await this.key, signature, new TextEncoder().encode(envelope.payload))) return
        const data = JSON.parse(envelope.payload)
        if (generation !== this.generation || data.session !== this.session || data.sender !== id) return
        if (data.message.type === 'cursor') {
          if (data.sequence <= lastCursor) return
          lastCursor = data.sequence
        } else if (data.message.type !== 'update') return
        this.log(`WebRTC receive ${data.message.type}`)
        this.receive(data.message, () => generation === this.generation && this.peers.get(id) === peer)
      })
    }
  }
}
