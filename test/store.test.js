"use strict";

const fs = require("fs");
const { mkdtempSync, rmSync } = require("fs");
const { tmpdir } = require("os");
const path = require("path");
const { strict: assert } = require("node:assert");
const { describe, it, before, after } = require("node:test");

describe("service-names", () => {
  const names = require("../src/service-names");

  it("exports consistent identifiers", () => {
    assert.equal(names.WIN_SERVICE_NAME, names.WIN_TASK_NAME);
    assert.equal(names.WIN_SERVICE_NAME, "aj-server-manager");
    assert.match(names.LINUX_SYSTEMD_UNIT, /^aj-server-manager\.service$/);
  });
});

describe("store (isolated AJ_STORE_DATA_DIR)", () => {
  let prevEnv;
  let tmp;

  function freshRequireStore() {
    delete require.cache[require.resolve("../src/store")];
    return require("../src/store");
  }

  before(() => {
    prevEnv = process.env.AJ_STORE_DATA_DIR;
    tmp = mkdtempSync(path.join(tmpdir(), "aj-sm-test-"));
    process.env.AJ_STORE_DATA_DIR = tmp;
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "store.json"),
      JSON.stringify({ pairingKeys: [], agents: [] })
    );
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.AJ_STORE_DATA_DIR;
    else process.env.AJ_STORE_DATA_DIR = prevEnv;
    delete require.cache[require.resolve("../src/store")];
  });

  it("createPairingKey requires label", () => {
    const store = freshRequireStore();
    assert.throws(() => store.createPairingKey(""), /Label is required/);
  });

  it("single-use key rejects second consume", () => {
    const store = freshRequireStore();
    const rec = store.createPairingKey("PC-A", false);
    const key = rec.key;

    assert.equal(store.consumePairingKey(key).ok, true);
    const second = store.consumePairingKey(key);
    assert.equal(second.ok, false);
    assert.equal(second.reason, "already_used");
  });

  it("multi-use key allows multiple consumes", () => {
    const store = freshRequireStore();
    const rec = store.createPairingKey("Lab", true);
    const key = rec.key;

    assert.equal(store.consumePairingKey(key).ok, true);
    assert.equal(store.consumePairingKey(key).ok, true);

    const k = store.listKeys().find((x) => x.key === key);
    assert.ok(k.useCount >= 2);
    assert.ok(!k.used);
  });

  it("normalized pairing input accepts dashed case-insensitive variants", () => {
    const store = freshRequireStore();
    const rec = store.createPairingKey("dash", false);
    const k = rec.key;
    const dashed = `${k.slice(0, 8)}-${k.slice(8, 16)}-${k.slice(16)}`;

    assert.equal(store.consumePairingKey(dashed.toUpperCase()).ok, true);
  });

  it("legacy key without multiUse field behaves single-use", () => {
    fs.writeFileSync(
      path.join(tmp, "store.json"),
      JSON.stringify({
        pairingKeys: [
          {
            id: "legacy-id",
            key: "beefcafebeefcafebeefcafe",
            label: "old",
            createdAt: new Date().toISOString(),
            used: false,
            useCount: 0,
          },
        ],
        agents: [],
      })
    );
    const store = freshRequireStore();
    assert.equal(store.consumePairingKey("beefcafebeefcafebeefcafe").ok, true);
    assert.equal(store.consumePairingKey("beefcafebeefcafebeefcafe").ok, false);

    fs.writeFileSync(
      path.join(tmp, "store.json"),
      JSON.stringify({ pairingKeys: [], agents: [] })
    );
    freshRequireStore();
  });

  it("agents upsert, find credential, remove, label", () => {
    fs.writeFileSync(
      path.join(tmp, "store.json"),
      JSON.stringify({ pairingKeys: [], agents: [] })
    );
    const store = freshRequireStore();

    store.upsertAgentFromRegister({
      id: "a1",
      secret: "s1",
      hostname: "h1",
      os: "Windows",
      platform: "win32",
      arch: "x64",
      version: "v20",
      label: "L1",
    });
    assert.equal(store.listAgents().length, 1);
    assert.equal(store.findAgentCredentials("a1", "s1")?.hostname, "h1");
    assert.equal(store.findAgentCredentials("a1", "wrong"), null);

    store.upsertAgentFromRegister({
      id: "a1",
      secret: "s1",
      hostname: "h2",
      os: "Windows",
      platform: "win32",
      arch: "x64",
      version: "v20",
    });
    assert.equal(store.listAgents()[0].hostname, "h2");
    assert.equal(store.listAgents()[0].label, "L1");

    assert.ok(store.setAgentLabel("a1", "New"));
    assert.equal(store.listAgents()[0].label, "New");
    assert.ok(store.removeAgent("a1"));
    assert.equal(store.listAgents().length, 0);
  });

  it("invalid consume returns not_found", () => {
    const store = freshRequireStore();
    assert.deepEqual(store.consumePairingKey("zzzznonexistentkeyzzzzzzz"), {
      ok: false,
      reason: "not_found",
    });
  });
});
