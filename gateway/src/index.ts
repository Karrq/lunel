import type { ServerWebSocket } from "bun";
import { randomBytes } from "crypto";

const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const CODE_LENGTH = 10;
const SAFETY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — only catches zombie sessions
const CONTROL_MAX_SIZE = 64 * 1024; // 64KB

type Role = "cli" | "app";
type Channel = "control" | "data";

interface Session {
  code: string;
  createdAt: number;
  locked: boolean; // true once app connects
  sockets: {
    cli: { control: ServerWebSocket<WebSocketData> | null; data: ServerWebSocket<WebSocketData> | null };
    app: { control: ServerWebSocket<WebSocketData> | null; data: ServerWebSocket<WebSocketData> | null };
  };
}

interface WebSocketData {
  code: string;
  role: Role;
  channel: Channel;
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

      const upgraded = server.upgrade(req, { data: { code, role, channel } });
      if (!upgraded) {
        return Response.json({ error: "upgrade failed" }, { status: 500, headers: corsHeaders });
      }
      return undefined;
    }

    return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders });
  },

  websocket: {
    open(ws) {
      const { code, role, channel } = ws.data;
      const session = sessions.get(code);

      if (!session) {
        ws.close(1008, "session not found");
        return;
      }

      session.sockets[role][channel] = ws;
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
      const { code, role, channel } = ws.data;
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
      const { code: sessionCode, role, channel } = ws.data;
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
