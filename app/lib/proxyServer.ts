import TcpSocket from 'react-native-tcp-socket';

const GATEWAY_WS_URL = 'wss://gateway.lunel.dev';

// ============================================================================
// Types
// ============================================================================

interface TunnelInfo {
  tunnelId: string;
  port: number;
  tcpSocket: any;
  proxyWs: WebSocket | null;
}

interface ServerInfo {
  port: number;
  server: ReturnType<typeof TcpSocket.createServer>;
}

// ============================================================================
// State
// ============================================================================

let sessionCode: string | null = null;
let sendControlMessage: ((ns: string, action: string, payload?: Record<string, unknown>) => Promise<any>) | null = null;

const activeServers = new Map<number, ServerInfo>();
const activeTunnels = new Map<string, TunnelInfo>();

let tunnelCounter = 0;

// ============================================================================
// Public API
// ============================================================================

export function configureProxy(
  code: string,
  sendControl: (ns: string, action: string, payload?: Record<string, unknown>) => Promise<any>,
): void {
  sessionCode = code;
  sendControlMessage = sendControl;
}

export function startPortServers(ports: number[]): void {
  // Stop servers not in the new list
  for (const [port] of activeServers) {
    if (!ports.includes(port)) {
      stopPortServer(port);
    }
  }

  // Start servers for new ports
  for (const port of ports) {
    if (!activeServers.has(port)) {
      startSingleServer(port);
    }
  }
}

export function stopAllServers(): void {
  // Close all tunnels
  for (const [tunnelId] of activeTunnels) {
    closeTunnel(tunnelId);
  }
  activeTunnels.clear();

  // Close all servers
  for (const [port, serverInfo] of activeServers) {
    try {
      serverInfo.server.close();
    } catch (e) {
      console.warn(`[proxy] Failed to close server on port ${port}:`, e);
    }
  }
  activeServers.clear();

  sessionCode = null;
  sendControlMessage = null;
}

export function getActiveServers(): number[] {
  return Array.from(activeServers.keys());
}

export function getActiveTunnelCount(): number {
  return activeTunnels.size;
}

// ============================================================================
// Internal
// ============================================================================

function generateTunnelId(): string {
  tunnelCounter++;
  return `t-${Date.now()}-${tunnelCounter}`;
}

function startSingleServer(port: number): void {
  const server = TcpSocket.createServer((socket: any) => {
    handleIncomingConnection(socket, port);
  });

  server.on('error', (error: any) => {
    console.warn(`[proxy] Server error on port ${port}:`, error);
    activeServers.delete(port);
  });

  server.listen({ port, host: '0.0.0.0' }, () => {
    console.log(`[proxy] Listening on port ${port}`);
  });

  activeServers.set(port, { port, server });
}

function stopPortServer(port: number): void {
  const serverInfo = activeServers.get(port);
  if (!serverInfo) return;

  // Close all tunnels for this port
  for (const [tunnelId, tunnel] of activeTunnels) {
    if (tunnel.port === port) {
      closeTunnel(tunnelId);
    }
  }

  try {
    serverInfo.server.close();
  } catch (e) {
    // ignore
  }
  activeServers.delete(port);
  console.log(`[proxy] Stopped server on port ${port}`);
}

async function handleIncomingConnection(tcpSocket: any, port: number): Promise<void> {
  if (!sessionCode || !sendControlMessage) {
    console.warn('[proxy] Not configured, rejecting connection');
    tcpSocket.destroy();
    return;
  }

  const tunnelId = generateTunnelId();

  // Pause TCP socket to buffer data until proxy WS is ready
  tcpSocket.pause();

  const tunnel: TunnelInfo = {
    tunnelId,
    port,
    tcpSocket,
    proxyWs: null,
  };
  activeTunnels.set(tunnelId, tunnel);

  try {
    // Step 1: Ask CLI to connect to the local service and open its proxy WS
    const response = await sendControlMessage('proxy', 'connect', { tunnelId, port });

    if (!response.ok) {
      console.warn(`[proxy] CLI rejected tunnel ${tunnelId}:`, response.error);
      closeTunnel(tunnelId);
      return;
    }

    // Step 2: Open our side of the proxy WS
    const proxyWsUrl = `${GATEWAY_WS_URL}/v1/ws/proxy?code=${sessionCode}&tunnelId=${tunnelId}&role=app`;
    const proxyWs = new WebSocket(proxyWsUrl);
    proxyWs.binaryType = 'arraybuffer';
    tunnel.proxyWs = proxyWs;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Proxy WS connect timeout'));
      }, 5000);

      proxyWs.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };

      proxyWs.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Proxy WS connect failed'));
      };
    });

    // Step 3: Pipe TCP -> WS (binary)
    tcpSocket.on('data', (data: any) => {
      if (proxyWs.readyState === WebSocket.OPEN) {
        // react-native-tcp-socket gives Buffer; WebSocket.send accepts ArrayBuffer
        if (data instanceof ArrayBuffer) {
          proxyWs.send(data);
        } else if (data.buffer) {
          proxyWs.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        } else {
          proxyWs.send(data);
        }
      }
    });

    // Step 4: Pipe WS -> TCP (binary)
    proxyWs.onmessage = (event: MessageEvent) => {
      if (!tcpSocket.destroyed) {
        // event.data is ArrayBuffer (binaryType = 'arraybuffer')
        const bytes = new Uint8Array(event.data);
        tcpSocket.write(bytes);
      }
    };

    // Step 5: Close cascades
    tcpSocket.on('close', () => {
      closeTunnel(tunnelId);
    });

    tcpSocket.on('error', () => {
      closeTunnel(tunnelId);
    });

    proxyWs.onclose = () => {
      closeTunnel(tunnelId);
    };

    // proxyWs.onerror is already set above for the connect phase,
    // but we reassign for the active phase
    proxyWs.onerror = () => {
      closeTunnel(tunnelId);
    };

    // Step 6: Resume TCP socket — everything is wired
    tcpSocket.resume();

  } catch (error) {
    console.warn(`[proxy] Failed to establish tunnel ${tunnelId}:`, error);
    closeTunnel(tunnelId);
  }
}

function closeTunnel(tunnelId: string): void {
  const tunnel = activeTunnels.get(tunnelId);
  if (!tunnel) return;

  // Delete immediately to prevent double-close from cascading events
  activeTunnels.delete(tunnelId);

  try {
    if (!tunnel.tcpSocket.destroyed) {
      tunnel.tcpSocket.destroy();
    }
  } catch (e) {
    // ignore
  }

  try {
    if (tunnel.proxyWs && (tunnel.proxyWs.readyState === WebSocket.OPEN || tunnel.proxyWs.readyState === WebSocket.CONNECTING)) {
      tunnel.proxyWs.close();
    }
  } catch (e) {
    // ignore
  }
}
