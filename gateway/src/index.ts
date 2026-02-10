import type { ServerWebSocket } from "bun";
import { randomBytes } from "crypto";

const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const CODE_LENGTH = 10;
const SAFETY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — only catches zombie sessions
const CONTROL_MAX_SIZE = 64 * 1024; // 64KB

type Role = "cli" | "app";
type Channel = "control" | "data";

// Discriminated union for WebSocket data
interface SessionWebSocketData {
  type: "session";
  code: string;
  role: Role;
  channel: Channel;
}

interface ProxyWebSocketData {
  type: "proxy";
  code: string;
  tunnelId: string;
  role: Role;
}

type WebSocketData = SessionWebSocketData | ProxyWebSocketData;

interface ProxyTunnel {
  cli: ServerWebSocket<ProxyWebSocketData> | null;
  app: ServerWebSocket<ProxyWebSocketData> | null;
}

interface Session {
  code: string;
  createdAt: number;
  locked: boolean; // true once app connects
  sockets: {
    cli: { control: ServerWebSocket<SessionWebSocketData> | null; data: ServerWebSocket<SessionWebSocketData> | null };
    app: { control: ServerWebSocket<SessionWebSocketData> | null; data: ServerWebSocket<SessionWebSocketData> | null };
  };
  tunnels: Map<string, ProxyTunnel>;
}

const sessions = new Map<string, Session>();

function generateSecureCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let result = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    result += CHARSET[bytes[i] % CHARSET.length];
  }
  return result;
}

function terminateSession(session: Session, reason: string): void {
  // Close all proxy tunnels
  for (const [, tunnel] of session.tunnels) {
    tunnel.cli?.close(1000, reason);
    tunnel.app?.close(1000, reason);
  }
  session.tunnels.clear();

  // Close session sockets
  session.sockets.cli.control?.close(1000, reason);
  session.sockets.cli.data?.close(1000, reason);
  session.sockets.app.control?.close(1000, reason);
  session.sockets.app.data?.close(1000, reason);
  sessions.delete(session.code);
  console.log(`[session] terminated: ${session.code} (${reason})`);
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [_, session] of sessions) {
    const hasAnySockets =
      session.sockets.cli.control !== null ||
      session.sockets.cli.data !== null ||
      session.sockets.app.control !== null ||
      session.sockets.app.data !== null;

    // Only clean up sessions that are truly orphaned AND old
    if (!hasAnySockets && now - session.createdAt > SAFETY_TTL_MS) {
      terminateSession(session, "safety TTL expired (no sockets)");
    }
  }
}

setInterval(cleanupExpiredSessions, 5 * 60 * 1000);

function isPeerFullyConnected(session: Session, role: Role): boolean {
  return session.sockets[role].control !== null && session.sockets[role].data !== null;
}

function getOppositeRole(role: Role): Role {
  return role === "cli" ? "app" : "cli";
}

function sendSystemMessage(ws: ServerWebSocket<WebSocketData>, type: string, payload: Record<string, unknown> = {}): void {
  ws.send(JSON.stringify({ type, ...payload }));
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = Bun.serve<WebSocketData>({
  port: process.env.PORT || 3000,

  fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (path === "/health") {
      return Response.json({ status: "ok" }, { headers: corsHeaders });
    }

    // Create session
    if (path === "/v1/session" && req.method === "POST") {
      let code: string;
      do {
        code = generateSecureCode();
      } while (sessions.has(code));

      sessions.set(code, {
        code,
        createdAt: Date.now(),
        locked: false,
        sockets: {
          cli: { control: null, data: null },
          app: { control: null, data: null },
        },
        tunnels: new Map(),
      });

      console.log(`[session] created: ${code}`);
      return Response.json({ code }, { headers: corsHeaders });
    }

    // Delete (close) session explicitly
    const deleteMatch = path.match(/^\/v1\/session\/([A-Za-z0-9]+)$/);
    if (deleteMatch && req.method === "DELETE") {
      const code = deleteMatch[1];
      const session = sessions.get(code);
      if (!session) {
        return Response.json({ error: "session not found" }, { status: 404, headers: corsHeaders });
      }
      terminateSession(session, "closed by user");
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    // WebSocket upgrade
    // Session WebSocket upgrade
    const wsMatch = path.match(/^\/v1\/ws\/(cli|app)\/(control|data)$/);
    if (wsMatch) {
      const role = wsMatch[1] as Role;
      const channel = wsMatch[2] as Channel;
      const code = url.searchParams.get("code");

      if (!code) {
        return Response.json({ error: "missing code" }, { status: 400, headers: corsHeaders });
      }

      const session = sessions.get(code);
      if (!session) {
        return Response.json({ error: "invalid or expired code" }, { status: 404, headers: corsHeaders });
      }

      // Check if slot already taken
      if (session.sockets[role][channel] !== null) {
        return Response.json({ error: `${role} ${channel} already connected` }, { status: 409, headers: corsHeaders });
      }

      // If app is trying to connect and session is already locked (another app fully connected), reject
      if (role === "app" && session.locked && isPeerFullyConnected(session, "app")) {
        return Response.json({ error: "session already in use" }, { status: 403, headers: corsHeaders });
      }

      const upgraded = server.upgrade(req, { data: { type: "session" as const, code, role, channel } });
      if (!upgraded) {
        return Response.json({ error: "upgrade failed" }, { status: 500, headers: corsHeaders });
      }
      return undefined;
    }

    // Proxy WebSocket upgrade
    if (path === "/v1/ws/proxy") {
      const code = url.searchParams.get("code");
      const tunnelId = url.searchParams.get("tunnelId");
      const role = url.searchParams.get("role") as Role | null;

      if (!code || !tunnelId || !role || (role !== "cli" && role !== "app")) {
        return Response.json({ error: "missing code, tunnelId, or role" }, { status: 400, headers: corsHeaders });
      }

      const session = sessions.get(code);
      if (!session) {
        return Response.json({ error: "invalid or expired code" }, { status: 404, headers: corsHeaders });
      }

      if (!session.locked) {
        return Response.json({ error: "session not ready" }, { status: 403, headers: corsHeaders });
      }

      // Initialize tunnel entry if it doesn't exist
      if (!session.tunnels.has(tunnelId)) {
        session.tunnels.set(tunnelId, { cli: null, app: null });
      }

      const tunnel = session.tunnels.get(tunnelId)!;
      if (tunnel[role] !== null) {
        return Response.json({ error: `${role} already connected for tunnel ${tunnelId}` }, { status: 409, headers: corsHeaders });
      }

      const upgraded = server.upgrade(req, { data: { type: "proxy" as const, code, tunnelId, role } });
      if (!upgraded) {
        return Response.json({ error: "upgrade failed" }, { status: 500, headers: corsHeaders });
      }
      return undefined;
    }

    return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders });
  },

  websocket: {
    open(ws) {
      const data = ws.data;

      if (data.type === "proxy") {
        const session = sessions.get(data.code);
        if (!session) {
          ws.close(1008, "session not found");
          return;
        }
        const tunnel = session.tunnels.get(data.tunnelId);
        if (!tunnel) {
          ws.close(1008, "tunnel not found");
          return;
        }
        tunnel[data.role] = ws;
        console.log(`[proxy] ${data.role} connected: tunnel=${data.tunnelId}`);
        return;
      }

      // Session socket
      const { code, role, channel } = data;
      const session = sessions.get(code);

      if (!session) {
        ws.close(1008, "session not found");
        return;
      }

      session.sockets[role][channel] = ws as ServerWebSocket<SessionWebSocketData>;
      console.log(`[ws] ${role}/${channel} connected: ${code}`);

      sendSystemMessage(ws, "connected", { role, channel });

      // Lock session once app is fully connected (both channels)
      if (role === "app" && !session.locked && isPeerFullyConnected(session, "app")) {
        session.locked = true;
        console.log(`[session] locked: ${code}`);
      }

      // Notify peers when fully connected
      if (isPeerFullyConnected(session, role)) {
        const opposite = getOppositeRole(role);
        if (isPeerFullyConnected(session, opposite)) {
          session.sockets[opposite].control?.send(JSON.stringify({ type: "peer_connected", peer: role }));
          session.sockets[role].control?.send(JSON.stringify({ type: "peer_connected", peer: opposite }));
        }
      }
    },

    message(ws, message) {
      const data = ws.data;

      if (data.type === "proxy") {
        const session = sessions.get(data.code);
        if (!session) {
          ws.close(1008, "session not found");
          return;
        }
        const tunnel = session.tunnels.get(data.tunnelId);
        if (!tunnel) {
          ws.close(1008, "tunnel not found");
          return;
        }
        // Pure binary relay — no JSON parsing, no size limit
        const opposite = getOppositeRole(data.role);
        const target = tunnel[opposite];
        if (target) {
          target.send(message);
        }
        return;
      }

      // Session socket
      const { code, role, channel } = data;
      const session = sessions.get(code);

      if (!session) {
        ws.close(1008, "session not found");
        return;
      }

      const messageSize = typeof message === "string" ? message.length : message.byteLength;
      if (channel === "control" && messageSize > CONTROL_MAX_SIZE) {
        ws.send(JSON.stringify({ v: 1, ok: false, error: { code: "EMSGSIZE", message: "message too large" } }));
        return;
      }

      const opposite = getOppositeRole(role);
      const target = session.sockets[opposite][channel];

      if (target) {
        target.send(message);
      } else {
        ws.send(JSON.stringify({ v: 1, ok: false, error: { code: "EPEERNOTCONN", message: "peer not connected" } }));
      }
    },

    close(ws, closeCode, reason) {
      const data = ws.data;

      if (data.type === "proxy") {
        const session = sessions.get(data.code);
        if (!session) return;
        const tunnel = session.tunnels.get(data.tunnelId);
        if (!tunnel) return;

        console.log(`[proxy] ${data.role} disconnected: tunnel=${data.tunnelId}`);

        // Clear this side
        tunnel[data.role] = null;

        // Close the other side (cascade)
        const opposite = getOppositeRole(data.role);
        const peer = tunnel[opposite];
        if (peer) {
          peer.close(1000, "peer disconnected");
        }

        // Clean up tunnel entry
        session.tunnels.delete(data.tunnelId);
        // Do NOT terminate the session
        return;
      }

      // Session socket
      const { code: sessionCode, role, channel } = data;
      const session = sessions.get(sessionCode);

      console.log(`[ws] ${role}/${channel} disconnected: ${sessionCode}`);

      if (session) {
        session.sockets[role][channel] = null;

        // Notify the other peer that this side disconnected
        const opposite = getOppositeRole(role);
        const oppositeControl = session.sockets[opposite].control;
        if (oppositeControl) {
          sendSystemMessage(oppositeControl, "peer_disconnected", { peer: role });
        }

        // Unlock so either side can reconnect with the same code
        if (!isPeerFullyConnected(session, role)) {
          session.locked = false;
        }
      }
    },
  },
});

console.log(`lunel-proxy running on http://localhost:${server.port}`);
