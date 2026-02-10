import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { configureProxy, startPortServers, stopAllServers } from '@/lib/proxyServer';

const PROXY_URL = 'wss://gateway.lunel.dev';

// ============================================================================
// Types
// ============================================================================

export interface Message {
  v: 1;
  id: string;
  ns: string;
  action: string;
  payload: Record<string, unknown>;
}

export interface Response {
  v: 1;
  id: string;
  ns: string;
  action: string;
  ok: boolean;
  payload: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

interface SystemMessage {
  type: 'connected' | 'peer_connected' | 'peer_disconnected' | 'error';
  role?: string;
  channel?: string;
  peer?: string;
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface PendingRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface Capabilities {
  version: string;
  namespaces: string[];
  platform: string;
  rootDir: string;
  hostname: string;
}

interface ConnectionContextType {
  status: ConnectionStatus;
  sessionCode: string | null;
  capabilities: Capabilities | null;
  error: string | null;
  connect: (code: string) => Promise<void>;
  disconnect: () => void;
  sendControl: (ns: string, action: string, payload?: Record<string, unknown>) => Promise<Response>;
  sendData: (ns: string, action: string, payload?: Record<string, unknown>) => Promise<Response>;
  onDataEvent: (handler: (message: Message) => void) => () => void;
}

const ConnectionContext = createContext<ConnectionContextType | null>(null);

// ============================================================================
// Provider
// ============================================================================

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [sessionCode, setSessionCode] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);

  const controlWsRef = useRef<WebSocket | null>(null);
  const dataWsRef = useRef<WebSocket | null>(null);
  const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());
  const dataEventHandlersRef = useRef<Set<(message: Message) => void>>(new Set());
  const messageIdRef = useRef(0);
  const sessionCodeRef = useRef<string | null>(null);
  const sendControlRef = useRef<((ns: string, action: string, payload?: Record<string, unknown>) => Promise<Response>) | null>(null);

  const generateId = useCallback(() => {
    messageIdRef.current += 1;
    return `msg-${Date.now()}-${messageIdRef.current}`;
  }, []);

  const handleMessage = useCallback((data: string, channel: 'control' | 'data') => {
    try {
      const message = JSON.parse(data);

      // Handle system messages
      if (message.type === 'connected') {
        return;
      }

      if (message.type === 'peer_connected') {
        console.log('[connection] CLI connected');
        // Configure proxy tunnel system
        if (sessionCodeRef.current && sendControlRef.current) {
          configureProxy(sessionCodeRef.current, sendControlRef.current);
        }
        return;
      }

      if (message.type === 'peer_disconnected') {
        console.log('[connection] CLI disconnected');
        setStatus('error');
        setError('CLI disconnected');
        return;
      }

      // Handle v1 protocol responses
      if (message.v === 1 && message.id) {
        const pending = pendingRequestsRef.current.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequestsRef.current.delete(message.id);
          pending.resolve(message as Response);
          return;
        }

        // Handle proxy port discovery events from CLI
        if (message.ns === 'proxy' && message.action === 'ports_discovered') {
          const ports = message.payload?.ports as number[];
          if (ports && ports.length > 0) {
            console.log('[connection] CLI discovered open ports:', ports);
            startPortServers(ports);
          }
          return;
        }

        // Event message (no pending request) - only for data channel
        if (channel === 'data') {
          for (const handler of dataEventHandlersRef.current) {
            handler(message as Message);
          }
        }
      }
    } catch (err) {
      console.error('[connection] Failed to parse message:', err);
    }
  }, []);

  const sendMessage = useCallback((
    ws: WebSocket | null,
    ns: string,
    action: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 30000
  ): Promise<Response> => {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const id = generateId();
      const message: Message = { v: 1, id, ns, action, payload };

      const timeout = setTimeout(() => {
        pendingRequestsRef.current.delete(id);
        reject(new Error(`Request timeout: ${ns}.${action}`));
      }, timeoutMs);

      pendingRequestsRef.current.set(id, { resolve, reject, timeout });

      ws.send(JSON.stringify(message));
    });
  }, [generateId]);

  const sendControl = useCallback((ns: string, action: string, payload?: Record<string, unknown>) => {
    return sendMessage(controlWsRef.current, ns, action, payload);
  }, [sendMessage]);

  // Keep ref in sync for proxy module access
  sendControlRef.current = sendControl;

  const sendData = useCallback((ns: string, action: string, payload?: Record<string, unknown>) => {
    return sendMessage(dataWsRef.current, ns, action, payload);
  }, [sendMessage]);

  const onDataEvent = useCallback((handler: (message: Message) => void) => {
    dataEventHandlersRef.current.add(handler);
    return () => {
      dataEventHandlersRef.current.delete(handler);
    };
  }, []);

  const disconnect = useCallback(() => {
    stopAllServers();
    controlWsRef.current?.close();
    dataWsRef.current?.close();
    controlWsRef.current = null;
    dataWsRef.current = null;
    setStatus('disconnected');
    setSessionCode(null);
    sessionCodeRef.current = null;
    setCapabilities(null);
    setError(null);

    // Clear pending requests
    for (const pending of pendingRequestsRef.current.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Disconnected'));
    }
    pendingRequestsRef.current.clear();
  }, []);

  const connect = useCallback(async (code: string) => {
    disconnect();
    setStatus('connecting');
    setSessionCode(code);
    sessionCodeRef.current = code;
    setError(null);

    return new Promise<void>((resolve, reject) => {
      let controlConnected = false;
      let dataConnected = false;
      let resolved = false;

      const checkFullyConnected = async () => {
        if (controlConnected && dataConnected && !resolved) {
          resolved = true;
          console.log('[connection] Both channels connected');

          // Fetch capabilities
          try {
            const response = await sendControl('system', 'capabilities');
            if (response.ok) {
              setCapabilities(response.payload as unknown as Capabilities);
              setStatus('connected');
              resolve();
            } else {
              throw new Error(response.error?.message || 'Failed to get capabilities');
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            setError(msg);
            setStatus('error');
            reject(err);
          }
        }
      };

      const handleError = (msg: string) => {
        if (!resolved) {
          resolved = true;
          setError(msg);
          setStatus('error');
          reject(new Error(msg));
        }
      };

      // Control channel
      const controlWs = new WebSocket(`${PROXY_URL}/v1/ws/app/control?code=${code}`);
      controlWsRef.current = controlWs;

      controlWs.onopen = () => {
        controlConnected = true;
        checkFullyConnected();
      };

      controlWs.onmessage = (event) => {
        handleMessage(event.data, 'control');
      };

      controlWs.onerror = () => {
        handleError('Control channel connection failed');
      };

      controlWs.onclose = (event) => {
        if (!resolved) {
          handleError(`Control channel closed: ${event.reason || 'Unknown reason'}`);
        }
      };

      // Data channel
      const dataWs = new WebSocket(`${PROXY_URL}/v1/ws/app/data?code=${code}`);
      dataWsRef.current = dataWs;

      dataWs.onopen = () => {
        dataConnected = true;
        checkFullyConnected();
      };

      dataWs.onmessage = (event) => {
        handleMessage(event.data, 'data');
      };

      dataWs.onerror = () => {
        handleError('Data channel connection failed');
      };

      dataWs.onclose = (event) => {
        if (!resolved) {
          handleError(`Data channel closed: ${event.reason || 'Unknown reason'}`);
        }
      };

      // Connection timeout
      setTimeout(() => {
        if (!resolved) {
          handleError('Connection timeout');
          disconnect();
        }
      }, 10000);
    });
  }, [disconnect, handleMessage, sendControl]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  const value = useMemo<ConnectionContextType>(() => ({
    status,
    sessionCode,
    capabilities,
    error,
    connect,
    disconnect,
    sendControl,
    sendData,
    onDataEvent,
  }), [status, sessionCode, capabilities, error, connect, disconnect, sendControl, sendData, onDataEvent]);

  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

export function useConnection() {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error('useConnection must be used within a ConnectionProvider');
  }
  return context;
}
