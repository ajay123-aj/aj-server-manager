require("dotenv").config();

const http = require("http");
const os = require("os");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const store = require("./store");

const PORT = Number(process.env.PORT) || 3847;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

function authAdmin(req, res, next) {
  const h = req.headers.authorization || "";
  const token =
    (h.startsWith("Bearer ") && h.slice(7)) ||
    req.query.token ||
    "";
  if (!ADMIN_TOKEN || token === ADMIN_TOKEN) return next();
  res.status(401).json({ error: "Unauthorized" });
}

function warnIfNoAdminToken(req, res, next) {
  next();
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

/** agentId -> Set of socket ids (usually one) */
const agentSockets = new Map();

function addAgentSocket(agentId, socketId) {
  if (!agentSockets.has(agentId)) agentSockets.set(agentId, new Set());
  agentSockets.get(agentId).add(socketId);
}

function removeSocketFromAgents(socketId) {
  for (const [agentId, set] of agentSockets) {
    if (set.delete(socketId) && set.size === 0) agentSockets.delete(agentId);
  }
}

function socketsForAgent(agentId) {
  return agentSockets.get(agentId);
}

/** dashboard sockets */
const dashboardSockets = new Set();

function broadcastAgentList() {
  const agents = store.listAgents().map((a) => {
    const { secret: _s, ...rest } = a;
    return {
      ...rest,
      online: !!socketsForAgent(a.id),
    };
  });
  for (const id of dashboardSockets) {
    io.to(id).emit("agents:list", agents);
  }
}

app.get("/api/health", (_, res) => {
  res.json({ ok: true, name: "aj-server-manager" });
});

app.get("/api/server-info", (_, res) => {
  const net = os.networkInterfaces();
  const ips = [];
  for (const rows of Object.values(net)) {
    for (const row of rows || []) {
      if (
        row &&
        row.family === "IPv4" &&
        !row.internal &&
        typeof row.address === "string"
      ) {
        ips.push(row.address);
      }
    }
  }
  res.json({
    port: PORT,
    lanIps: Array.from(new Set(ips)),
  });
});

app.get(
  "/api/agents",
  warnIfNoAdminToken,
  authAdmin,
  (_, res) => {
    const agents = store.listAgents().map((a) => {
      const { secret: _s, ...rest } = a;
      return {
        ...rest,
        online: !!socketsForAgent(a.id),
      };
    });
    res.json({ agents });
  }
);

app.get(
  "/api/keys",
  warnIfNoAdminToken,
  authAdmin,
  (_, res) => {
    res.json({ keys: store.listKeys() });
  }
);

app.post(
  "/api/keys",
  warnIfNoAdminToken,
  authAdmin,
  express.json(),
  (req, res) => {
    const { label, multiUse } = req.body || {};
    const row = store.createPairingKey(label, !!multiUse);
    res.json({
      key: row.key,
      id: row.id,
      label: row.label,
      multiUse: row.multiUse,
      createdAt: row.createdAt,
    });
  }
);

app.delete(
  "/api/agents/:agentId",
  warnIfNoAdminToken,
  authAdmin,
  (req, res) => {
    const agentId = req.params.agentId;
    const removed = store.removeAgent(agentId);
    const set = agentSockets.get(agentId);
    if (set) {
      for (const sid of set) {
        io.to(sid).emit("agent:error", { error: "Removed by dashboard admin" });
        io.sockets.sockets.get(sid)?.disconnect(true);
      }
      agentSockets.delete(agentId);
    }
    broadcastAgentList();
    if (!removed) return res.status(404).json({ error: "Agent not found" });
    return res.json({ ok: true });
  }
);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 5000,
  pingTimeout: 10000,
});

io.use((socket, next) => {
  const role = socket.handshake.auth?.role || socket.handshake.query?.role;
  if (role === "agent") return next();
  if (role === "dashboard") {
    const token =
      socket.handshake.auth?.token || socket.handshake.query?.token || "";
    if (!ADMIN_TOKEN || token === ADMIN_TOKEN) return next();
    return next(new Error("dashboard auth failed"));
  }
  return next(new Error("unknown role"));
});

io.on("connection", (socket) => {
  const role = socket.handshake.auth?.role || socket.handshake.query?.role;

  if (role === "dashboard") {
    dashboardSockets.add(socket.id);
    broadcastAgentList();
    socket.on("disconnect", () => {
      dashboardSockets.delete(socket.id);
    });

    socket.on("dashboard:command", (msg, ack) => {
      const { agentId, commandId, type, payload } = msg || {};
      if (!agentId || !type) {
        if (typeof ack === "function")
          ack({ ok: false, error: "agentId and type required" });
        return;
      }
      const cid = commandId || uuidv4();
      const set = socketsForAgent(agentId);
      if (!set || set.size === 0) {
        if (typeof ack === "function")
          ack({ ok: false, error: "agent offline", commandId: cid });
        return;
      }
      for (const sid of set) {
        io.to(sid).emit("agent:command", { commandId: cid, type, payload });
      }
      if (typeof ack === "function") ack({ ok: true, commandId: cid });
    });

    return;
  }

  if (role === "agent") {
    const pairingKey =
      socket.handshake.auth?.pairingKey ||
      socket.handshake.query?.pairingKey ||
      "";
    const reconnectAgentId =
      socket.handshake.auth?.reconnectAgentId ||
      socket.handshake.query?.reconnectAgentId ||
      "";
    const reconnectSecret =
      socket.handshake.auth?.reconnectSecret ||
      socket.handshake.query?.reconnectSecret ||
      "";
    const hostname =
      socket.handshake.auth?.hostname || socket.handshake.query?.hostname || "";
    const osInfo = socket.handshake.auth?.os || "";
    const platform = socket.handshake.auth?.platform || "";
    const arch = socket.handshake.auth?.arch || "";
    const version = socket.handshake.auth?.version || "";

    let agentId;
    let agentSecret;
    let isReconnect = false;

    if (reconnectAgentId && reconnectSecret) {
      isReconnect = true;
      const cred = store.findAgentCredentials(reconnectAgentId, reconnectSecret);
      if (!cred) {
        socket.emit("agent:error", { error: "Invalid reconnect credentials" });
        socket.disconnect(true);
        return;
      }
      agentId = cred.id;
      agentSecret = cred.secret;
      store.touchAgent(agentId);
    } else if (pairingKey) {
      const consumed = store.consumePairingKey(pairingKey);
      if (!consumed) {
        socket.emit("agent:error", { error: "Invalid or revoked pairing key" });
        socket.disconnect(true);
        return;
      }
      agentId = uuidv4();
      agentSecret = uuidv4().replace(/-/g, "") + uuidv4().replace(/-/g, "");
    } else {
      socket.disconnect(true);
      return;
    }

    store.upsertAgentFromRegister({
      id: agentId,
      secret: agentSecret,
      hostname: hostname || "unknown",
      os: osInfo || platform,
      platform,
      arch,
      version,
    });

    addAgentSocket(agentId, socket.id);
    socket.data.agentId = agentId;

    if (isReconnect) {
      socket.emit("agent:ready", {
        agentId,
        serverTime: new Date().toISOString(),
      });
    } else {
      socket.emit("agent:registered", {
        agentId,
        secret: agentSecret,
        serverTime: new Date().toISOString(),
      });
    }
    broadcastAgentList();

    const hb = setInterval(() => {
      store.touchAgent(agentId);
    }, 45000);

    socket.on("agent:command_result", (body) => {
      for (const ds of dashboardSockets) {
        io.to(ds).emit("dashboard:command_result", body);
      }
    });

    socket.on("agent:shell_out", (body) => {
      for (const ds of dashboardSockets) {
        io.to(ds).emit("dashboard:shell_out", { ...body, agentId });
      }
    });

    socket.on("agent:telemetry", (body) => {
      for (const ds of dashboardSockets) {
        io.to(ds).emit("dashboard:telemetry", { ...body, agentId });
      }
    });

    socket.on("disconnect", () => {
      clearInterval(hb);
      const aid = socket.data.agentId;
      const set = agentSockets.get(aid);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) agentSockets.delete(aid);
      }
      broadcastAgentList();
    });

    return;
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard + API: http://0.0.0.0:${PORT}`);
  if (!ADMIN_TOKEN) {
    console.warn(
      "[!] ADMIN_TOKEN is not set. Create .env from .env.example for production."
    );
  }
});
