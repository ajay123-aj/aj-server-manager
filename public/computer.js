(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const agentId = params.get("agentId") || "";
  const qpToken = params.get("token")?.trim?.() || "";
  if (qpToken) sessionStorage.setItem("aj_admin_token", qpToken);
  const token = sessionStorage.getItem("aj_admin_token") || qpToken || "";
  const shellSessions = {};
  const monitorHistory = { cpu: [], mem: [], disk: [] };
  let socket = null;
  let monitorTimer = null;
  let activeTab = "services";
  const pending = new Map();

  $("btn-back-list").onclick = () => {
    const t =
      sessionStorage.getItem("aj_admin_token") ||
      params.get("token") ||
      token ||
      "";
    if (t) sessionStorage.setItem("aj_admin_token", t);
    const backUrl = new URL("index.html", window.location.href);
    if (t) backUrl.searchParams.set("token", t);
    backUrl.hash = "computers";
    window.location.assign(backUrl.toString());
  };

  if (!agentId) {
    $("monitor-live-status").textContent = "Missing computer id. Open from the dashboard Computers list.";
    return;
  }

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

  function activateTab(name) {
    activeTab = name;
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

  function sendCommand(type, payload) {
    if (!socket || !socket.connected) {
      $("monitor-live-status").textContent = "Dashboard socket not connected";
      return;
    }
    const commandId =
      crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    socket.timeout(15000).emit(
      "dashboard:command",
      { agentId, commandId, type, payload },
      (ack) => {
        if (!ack || ack.ok !== true) {
          pending.delete(commandId);
          const err = ack?.error || "No response from agent";
          if (type === "metrics") $("monitor-live-status").textContent = `Monitor error: ${err}`;
          if (type === "list_services") $("services-out").textContent = `Error: ${err}`;
          if (type === "exec") $("exec-out").textContent = `Error: ${err}`;
          if (type === "shell_start" || type === "shell_stop" || type === "shell_input") {
            $("shell-out").value += `\nError: ${err}\n`;
          }
        }
      }
    );
    pending.set(commandId, { type });
  }

  function pushMetric(history, value, max = 36) {
    history.push(Number(value) || 0);
    if (history.length > max) history.shift();
  }

  function drawSparkline(canvasId, values, stroke = "#3d8bfd") {
    const c = $(canvasId);
    if (!c) return;
    const ctx = c.getContext("2d");
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    if (!values.length) return;
    const stepX = values.length > 1 ? w / (values.length - 1) : w;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = i * stepX;
      const y = h - (Math.min(Math.max(v, 0), 100) / 100) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function fmtPct(v) {
    return `${(Number(v) || 0).toFixed(1)}%`;
  }
  function fmtBytes(n) {
    return `${((Number(n) || 0) / 1024 ** 3).toFixed(1)} GB`;
  }
  function fmtUptime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
  }

  function renderMonitor(data) {
    const cpuPct = Number(data?.currentLoad?.currentLoad || 0);
    const memTotal = Number(data?.mem?.total || 0);
    const memUsed = Number(data?.mem?.active || data?.mem?.used || 0);
    const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
    const fs = Array.isArray(data?.fsSizes) ? data.fsSizes : [];
    const diskPct = fs.length ? Number(fs[0]?.use || 0) : 0;
    const diskUsed = fs.length ? Number(fs[0]?.used || 0) : 0;
    const diskSize = fs.length ? Number(fs[0]?.size || 0) : 0;
    const upSec = Number(data?.uptime?.uptime || data?.uptime || 0);
    const host = data?.hostname || data?.staticData?.osInfo?.hostname || "";

    pushMetric(monitorHistory.cpu, cpuPct);
    pushMetric(monitorHistory.mem, memPct);
    pushMetric(monitorHistory.disk, diskPct);

    $("metric-cpu").textContent = fmtPct(cpuPct);
    $("metric-mem").textContent = `${fmtPct(memPct)} (${fmtBytes(memUsed)} / ${fmtBytes(memTotal)})`;
    $("metric-disk").textContent = `${fmtPct(diskPct)} (${fmtBytes(diskUsed)} / ${fmtBytes(diskSize)})`;
    $("metric-uptime").textContent = fmtUptime(upSec);
    $("metric-hostname").textContent = host ? `Host: ${host}` : "";
    $("monitor-live-status").textContent = `Updated ${new Date().toLocaleTimeString()}`;

    drawSparkline("chart-cpu", monitorHistory.cpu, "#3d8bfd");
    drawSparkline("chart-mem", monitorHistory.mem, "#3dcc85");
    drawSparkline("chart-disk", monitorHistory.disk, "#e6b35a");
  }

  function startMonitorTimer() {
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = setInterval(() => sendCommand("metrics", {}), 2000);
  }

  function handleCommandResult(msg) {
    const { commandId, type, stdout, stderr, exitCode, data, error, timedOut, agentId: fromAgent } = msg || {};
    if (
      typeof fromAgent === "string" &&
      fromAgent.length > 0 &&
      fromAgent !== agentId
    ) {
      return;
    }
    const tabFor = pending.get(commandId)?.type || type;

    if (tabFor === "metrics") {
      if (typeof data !== "undefined") renderMonitor(data);
      pending.delete(commandId);
      return;
    }
    if (tabFor === "list_services" || tabFor === "agent_connect" || tabFor === "agent_disconnect") {
      const parts = [];
      if (typeof exitCode !== "undefined") parts.push(`exit: ${exitCode}`);
      if (error) parts.push(`Error: ${error}`);
      if (stdout) parts.push(`[stdout]\n${stdout}`);
      if (stderr) parts.push(`[stderr]\n${stderr}`);
      $("services-out").textContent = parts.join("\n\n");
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
    }
  }

  function handleShellOut(body) {
    const aid = body?.agentId;
    if (typeof aid === "string" && aid.length > 0 && aid !== agentId) return;
    const ta = $("shell-out");
    if (body.kind === "exit") {
      ta.value += `\n--- shell exited (${body.code ?? "?"}) ---\n`;
      return;
    }
    ta.value += body.data ?? "";
    ta.scrollTop = ta.scrollHeight;
  }

  $("btn-refresh-services").onclick = () => {
    $("services-out").textContent = "Loading...";
    sendCommand("list_services", {});
  };
  $("btn-agent-connect").onclick = () => {
    const serverUrl = sessionStorage.getItem("aj_agent_server_url") || window.location.origin;
    $("services-out").textContent = "Connecting agent...";
    sendCommand("agent_connect", { serverUrl });
  };
  $("btn-agent-disconnect").onclick = () => {
    $("services-out").textContent = "Disconnecting agent...";
    sendCommand("agent_disconnect", {});
  };
  $("btn-run-exec").onclick = () => {
    const cmd = $("exec-cmd").value.trim();
    if (!cmd) return;
    $("exec-out").textContent = "Running...";
    sendCommand("exec", { command: cmd });
  };
  $("btn-shell-start").onclick = () => {
    const sid = shellSessions[agentId]?.session || "s1";
    shellSessions[agentId] = { session: sid };
    $("shell-out").value += "\nStarting shell session...\n";
    sendCommand("shell_start", { sessionId: sid });
  };
  $("btn-shell-stop").onclick = () => {
    const sid = shellSessions[agentId]?.session || "s1";
    sendCommand("shell_stop", { sessionId: sid });
  };
  $("btn-shell-send").onclick = () => {
    const sid = shellSessions[agentId]?.session || "s1";
    const line = $("shell-in").value;
    if (!line) return;
    sendCommand("shell_input", { sessionId: sid, input: line });
    $("shell-in").value = "";
  };

  (async () => {
    function applyAgentHeader(agent) {
      const labelEl = $("detail-label");
      if (!agent) {
        $("detail-title").textContent = "Computer";
        if (labelEl) labelEl.textContent = "";
        return;
      }
      const lab = agent.label?.trim?.() || "";
      if (labelEl) labelEl.textContent = lab ? `Label: ${lab}` : "";
      $("detail-title").textContent = `${agent.hostname} (${agent.platform})`;
    }

    try {
      const data = await api("/api/agents");
      const agent = (data.agents || []).find((x) => x.id === agentId);
      applyAgentHeader(agent);
      if (!agent) {
        $("monitor-live-status").textContent = "Computer not found";
      } else if (!agent.online) {
        $("monitor-live-status").textContent = "Agent offline";
      }
    } catch {
      $("monitor-live-status").textContent = "Cannot load agent details";
    }

    socket = io({
      auth: { role: "dashboard", token },
      transports: ["websocket", "polling"],
    });
    socket.on("dashboard:command_result", handleCommandResult);
    socket.on("dashboard:shell_out", handleShellOut);
    socket.on("dashboard:telemetry", (body) => {
      const aid = body?.agentId;
      if (typeof aid !== "string" || !aid.length || aid === agentId) {
        renderMonitor(body);
      }
    });
    socket.on("agents:list", async () => {
      try {
        const data = await api("/api/agents");
        applyAgentHeader((data.agents || []).find((x) => x.id === agentId));
      } catch {
        /* ignore */
      }
    });
    socket.on("connect", () => {
      $("monitor-live-status").textContent = "Connected, realtime every 2s";
      sendCommand("metrics", {});
      startMonitorTimer();
    });
    socket.on("connect_error", (err) => {
      $("monitor-live-status").textContent = `Connect error: ${err?.message || "unknown"}`;
    });
  })();
})();
