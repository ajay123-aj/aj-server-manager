(() => {
  const $ = (id) => document.getElementById(id);

  let socket = null;
  let token = sessionStorage.getItem("aj_admin_token") || "";
  let selectedAgentId = null;
  const shellSessions = {};

  $("admin-token").value = token;

  function api(path, opts = {}) {
    const headers = {
      ...(opts.headers || {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    return fetch(path, { ...opts, headers }).then(async (r) => {
      const txt = await r.text();
      let data;
      try {
        data = txt ? JSON.parse(txt) : null;
      } catch {
        data = { raw: txt };
      }
      if (!r.ok) throw new Error(data?.error || r.statusText);
      return data;
    });
  }

  function setAuthStatus(msg, isErr) {
    const el = $("auth-status");
    el.textContent = msg;
    el.className = `status ${isErr ? "error" : ""}`;
  }

  function showMain() {
    $("auth-section").classList.toggle("hidden", true);
    $("main-section").classList.toggle("hidden", false);
  }

  $("btn-connect").onclick = async () => {
    token = $("admin-token").value.trim();
    sessionStorage.setItem("aj_admin_token", token);
    setAuthStatus("Connecting…");

    try {
      await api("/api/agents");
    } catch (e) {
      setAuthStatus(e.message || String(e), true);
      return;
    }

    setAuthStatus("Connected.");

    try {
      if (socket) socket.disconnect();

      socket = io({
        auth: { role: "dashboard", token },
        transports: ["websocket", "polling"],
      });

      socket.on("agents:list", (agents) => {
        renderAgents(agents);
      });

      socket.on("dashboard:command_result", (msg) => {
        handleCommandResult(msg);
      });

      socket.on("dashboard:shell_out", handleShellOut);

      socket.on("connect_error", (err) =>
        console.error("[dashboard]", err.message)
      );
      showMain();
      $("install-snippet").textContent =
        buildInstallSnippet() || "// Set server URL manually";
      await refreshAgents();
    } catch (e) {
      setAuthStatus(e.message || String(e), true);
    }
  };

  function baseUrl() {
    return `${window.location.origin.replace(/\/$/, "")}`;
  }

  function buildInstallSnippet(key = "YOUR_PAIRING_KEY") {
    const server = baseUrl();
    const mode = $("install-mode")?.value || "node";
    if (mode === "docker") {
      return `git clone "https://github.com/ajay123-aj/aj-server-manager.git" && cd aj-server-manager && docker run --rm -it -v "%cd%:/app" -w /app node:20 sh -lc "npm install && node ./src/agent-cli.js --server '${server}' --key '${key}'"`;
    }
    return `git clone "https://github.com/ajay123-aj/aj-server-manager.git" && cd aj-server-manager && npm install && node .\\src\\agent-cli.js --server "${server}" --key "${key}"`;
  }

  function renderAgents(agents) {
    const tb = $("agents-body");
    tb.innerHTML = "";
    agents.forEach((a) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(a.hostname)}</td>
        <td>${escapeHtml(a.platform)} ${escapeHtml(a.arch || "")}</td>
        <td>${a.online ? '<span class="pill ok">Online</span>' : '<span class="pill off">Offline</span>'}</td>
        <td><button type="button" class="btn-ghost btn-open">Open</button></td>`;
      tr.querySelector(".btn-open").onclick = () => openDetail(a);
      tb.appendChild(tr);
    });
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function refreshAgents() {
    try {
      const data = await api("/api/agents");
      renderAgents(data.agents);
    } catch (e) {
      console.error(e);
    }
  }

  function openDetail(agent) {
    selectedAgentId = agent.id;
    $("detail-panel").classList.toggle("hidden", false);
    $("detail-title").textContent = `${agent.hostname} (${agent.platform})`;
    $("metrics-out").textContent = "";
    $("services-out").textContent = "";
    $("exec-out").textContent = "";
    $("shell-out").value = "";
    activateTab("monitor");
    if (agent.online) sendCommand(agent.id, "metrics", {});
    else $("metrics-out").textContent = agent.online ? "" : "Agent offline.";
  }

  $("btn-close-detail").onclick = () => {
    $("detail-panel").classList.toggle("hidden", true);
    selectedAgentId = null;
  };

  function activateTab(name) {
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.tab === name)
    );
    document.querySelectorAll("[data-panel]").forEach((p) =>
      p.classList.toggle("hidden", p.dataset.panel !== name)
    );
  }

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => activateTab(t.dataset.tab))
  );

  $("btn-gen-key").onclick = async () => {
    $("key-output").textContent = "";
    try {
      const multiUse = $("key-multi-use").checked;
      const label = $("key-label").value.trim();
      const res = await api("/api/keys", {
        method: "POST",
        body: JSON.stringify({ multiUse, label }),
      });
      $("key-output").textContent = `Pairing key: ${res.key}\n(Multi-use: ${!!res.multiUse})`;
      $("install-snippet").textContent = buildInstallSnippet(res.key);
    } catch (e) {
      $("key-output").textContent =
        String(e.message || e) +
        '\nEnsure ADMIN_TOKEN matches this server\'s ".env".';
    }
  };

  $("btn-copy-install").onclick = async () => {
    const cmd = $("install-snippet").textContent.trim();
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      $("key-output").textContent = "Install command copied.";
    } catch (e) {
      $("key-output").textContent = "Copy failed. Select and copy manually.";
    }
  };

  $("install-mode").onchange = () => {
    const keyLine = $("key-output").textContent || "";
    const match = keyLine.match(/Pairing key:\s*([a-z0-9]+)/i);
    const key = match?.[1] || "YOUR_PAIRING_KEY";
    $("install-snippet").textContent = buildInstallSnippet(key);
  };

  function sendCommand(agentId, type, payload, cb) {
    if (!socket) return;
    const commandId =
      crypto.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    socket.timeout(15000).emit(
      "dashboard:command",
      { agentId, commandId, type, payload },
      (ack) => cb?.(commandId, ack)
    );

    pending.set(commandId, { type, agentId });
    return commandId;
  }

  const pending = new Map();

  function handleCommandResult(msg) {
    const { commandId, type, stdout, stderr, exitCode, data, error, timedOut } =
      msg || {};
    const pend = pending.get(commandId);

    const text = [];

    const tabFor = pend?.type || type;

    if (tabFor === "metrics") {
      $("metrics-out").textContent =
        typeof data !== "undefined" ? JSON.stringify(data, null, 2) : error || "?";
      pending.delete(commandId);
      return;
    }
    if (tabFor === "list_services") {
      if (error) $("services-out").textContent = error;
      else
        $("services-out").textContent = [stdout, stderr ? `[stderr]\n${stderr}` : ""]
          .filter(Boolean)
          .join("\n\n");
      pending.delete(commandId);
      return;
    }
    if (tabFor === "exec") {
      const parts = [];
      if (typeof exitCode !== "undefined") parts.push(`exit: ${exitCode}`);
      if (timedOut) parts.push("TIMED OUT");
      if (error) parts.push(error);
      if (stdout) parts.push(`[stdout]\n${stdout}`);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      $("exec-out").textContent = parts.join("\n\n");
      pending.delete(commandId);
      return;
    }

    pending.delete(commandId);
  }

  function handleShellOut(body) {
    if (!selectedAgentId || body.agentId !== selectedAgentId) return;
    const ta = $("shell-out");
    if (body.kind === "exit") {
      ta.value += `\n--- shell exited (${body.code ?? "?"}) ---\n`;
      return;
    }
    ta.value += body.data ?? "";
    ta.scrollTop = ta.scrollHeight;
  }

  $("btn-refresh-metrics").onclick = () => {
    if (!selectedAgentId || !socket) return;
    sendCommand(selectedAgentId, "metrics", {});
  };

  $("btn-refresh-services").onclick = () => {
    if (!selectedAgentId || !socket) return;
    $("services-out").textContent = "Loading…";
    sendCommand(selectedAgentId, "list_services", {});
  };

  $("btn-run-exec").onclick = () => {
    const cmd = $("exec-cmd").value;
    if (!selectedAgentId || !socket || !cmd.trim()) return;
    $("exec-out").textContent = "Running…";
    sendCommand(selectedAgentId, "exec", { command: cmd });
  };

  $("btn-shell-start").onclick = () => {
    if (!selectedAgentId || !socket) return;
    const sid = shellSessions[selectedAgentId]?.session || "s1";
    shellSessions[selectedAgentId] = { session: sid };
    $("shell-out").value += "\nStarting shell session…\n";
    sendCommand(selectedAgentId, "shell_start", { sessionId: sid });
  };

  $("btn-shell-stop").onclick = () => {
    if (!selectedAgentId || !socket) return;
    const sid = shellSessions[selectedAgentId]?.session || "s1";
    sendCommand(selectedAgentId, "shell_stop", { sessionId: sid });
    $("shell-out").value += "\nStopped shell.\n";
  };

  $("btn-shell-send").onclick = () => {
    if (!selectedAgentId || !socket) return;
    const sid = shellSessions[selectedAgentId]?.session || "s1";
    const line = $("shell-in").value;
    if (!line) return;
    sendCommand(selectedAgentId, "shell_input", { sessionId: sid, input: line });
    $("shell-in").value = "";
  };

  if (token) {
    $("btn-connect").click();
  }
})();
