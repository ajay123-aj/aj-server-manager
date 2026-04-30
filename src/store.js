const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const dataDir = path.join(__dirname, "..", "data");
const storePath = path.join(dataDir, "store.json");

function defaultStore() {
  return {
    pairingKeys: [],
    agents: [],
  };
}

function readStore() {
  try {
    if (!fs.existsSync(storePath)) return defaultStore();
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      pairingKeys: Array.isArray(parsed.pairingKeys) ? parsed.pairingKeys : [],
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
    };
  } catch {
    return defaultStore();
  }
}

function writeStore(store) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
}

function createPairingKey(label) {
  const labelText = String(label || "").trim();
  if (!labelText) throw new Error("Label is required");
  const store = readStore();
  const key = uuidv4().replace(/-/g, "").slice(0, 24);
  const record = {
    id: uuidv4(),
    key,
    label: labelText,
    multiUse: false,
    createdAt: new Date().toISOString(),
    used: false,
    useCount: 0,
  };
  store.pairingKeys.push(record);
  writeStore(store);
  return record;
}

function normalizePairingKeyInput(key) {
  let s = String(key || "").trim().replace(/^["'`]+|["'`]+$/g, "");
  s = s.replace(/-/g, "");
  return s.toLowerCase();
}

function consumePairingKey(key) {
  const needle = normalizePairingKeyInput(key);
  const store = readStore();
  const idx = store.pairingKeys.findIndex(
    (k) => normalizePairingKeyInput(k.key) === needle
  );
  if (idx === -1) return { ok: false, reason: "not_found" };
  const rec = store.pairingKeys[idx];
  if (rec.revokedAt) return { ok: false, reason: "revoked" };
  if (rec.used) return { ok: false, reason: "already_used" };
  rec.useCount = (rec.useCount || 0) + 1;
  rec.lastUsedAt = new Date().toISOString();
  rec.used = true;
  rec.usedAt = rec.lastUsedAt;
  writeStore(store);
  return { ok: true, record: rec };
}

function upsertAgentFromRegister({ id, secret, hostname, os, platform, arch, version, label }) {
  const store = readStore();
  const existing = store.agents.find((a) => a.id === id);
  const now = new Date().toISOString();
  const applyLabel =
    typeof label === "string" &&
    label.trim().length > 0;
  if (existing) {
    existing.hostname = hostname;
    existing.os = os;
    existing.platform = platform;
    existing.arch = arch;
    existing.version = version;
    if (applyLabel) existing.label = label.trim();
    existing.lastSeen = now;
    if (secret && !existing.secret) existing.secret = secret;
    writeStore(store);
    return existing;
  }
  const agent = {
    id,
    secret: secret || null,
    hostname,
    os,
    platform,
    arch,
    version,
    label: applyLabel ? label.trim() : "",
    registeredAt: now,
    lastSeen: now,
  };
  store.agents.push(agent);
  writeStore(store);
  return agent;
}

function findAgentCredentials(agentId, secret) {
  const store = readStore();
  const a = store.agents.find((x) => x.id === agentId && x.secret === secret);
  return a || null;
}

function touchAgent(id) {
  const store = readStore();
  const a = store.agents.find((x) => x.id === id);
  if (a) {
    a.lastSeen = new Date().toISOString();
    writeStore(store);
  }
}

function listAgents() {
  return readStore().agents;
}

function listKeys() {
  return readStore().pairingKeys;
}

function removeAgent(agentId) {
  const store = readStore();
  const before = store.agents.length;
  store.agents = store.agents.filter((a) => a.id !== agentId);
  if (store.agents.length === before) return false;
  writeStore(store);
  return true;
}

function setAgentLabel(agentId, label) {
  const text = String(label || "").trim();
  if (!text) return false;
  const store = readStore();
  const a = store.agents.find((x) => x.id === agentId);
  if (!a) return false;
  a.label = text;
  writeStore(store);
  return true;
}

module.exports = {
  readStore,
  createPairingKey,
  consumePairingKey,
  upsertAgentFromRegister,
  findAgentCredentials,
  touchAgent,
  listAgents,
  listKeys,
  removeAgent,
  setAgentLabel,
};
