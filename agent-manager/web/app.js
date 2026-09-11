/**
 * agent-manager 前端（零依赖、无构建、离线可用）。
 * 安全约定：所有动态数据一律 textContent 渲染，绝不把数据拼进 innerHTML。
 */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  agents: [],
  detail: null,
  selected: null,
  timers: { agents: null, detail: null },
};

/** fetch 封装：统一 JSON 解包与错误码；成功返回 value。 */
async function api(path, options) {
  const settings = options || {};
  const method = settings.method || "GET";
  const init = { method };
  if (method !== "GET") {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(settings.body === undefined ? {} : settings.body);
  }
  const response = await fetch(path, init);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload || payload.ok !== true) {
    const error = new Error((payload && payload.message) || "请求失败");
    error.code = (payload && payload.code) || "HTTP_" + response.status;
    throw error;
  }
  return payload.value;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function text(value) {
  return value === undefined || value === null || value === "" ? "—" : String(value);
}

function cell(value) {
  const td = document.createElement("td");
  td.textContent = text(value);
  return td;
}

function actionButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function formatBytes(size) {
  if (typeof size !== "number" || !Number.isFinite(size)) return "—";
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  return (size / 1024 / 1024).toFixed(1) + " MB";
}

function formatTime(value) {
  if (typeof value !== "string" || !value) return "—";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}

function notify(message) {
  $("status-line").textContent = message || "";
}

// ------------------------------------------------------------------ Tab

function showTab(name) {
  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("is-active", tab.dataset.tab === name);
  for (const panel of document.querySelectorAll(".panel")) panel.classList.toggle("is-active", panel.id === "panel-" + name);
  if (name === "sessions") {
    void loadSessions();
    void loadTrash();
  } else if (name === "agents") {
    void refreshAgents();
  } else if (name === "settings") {
    void loadSettings();
  }
  if (name === "agents") startAgentTimer();
  else stopAgentTimer();
}

// ------------------------------------------------------------------ 会话

function renderSessionEntries(entries) {
  const rows = $("session-rows");
  clear(rows);
  $("session-empty").hidden = entries.length > 0;
  for (const entry of entries) {
    const meta = entry.meta;
    const row = document.createElement("tr");

    const title = document.createElement("td");
    title.textContent = meta.name || meta.firstUserText || "(无标题)";
    if (entry.snippets && entry.snippets.length) {
      const snippet = document.createElement("div");
      snippet.className = "muted small";
      snippet.textContent = entry.snippets.join(" ／ ");
      title.appendChild(snippet);
    }
    row.appendChild(title);

    row.appendChild(cell(meta.id));
    row.appendChild(cell(meta.cwd));
    row.appendChild(cell(meta.model));
    row.appendChild(cell(formatTime(meta.modifiedAt)));
    row.appendChild(cell(meta.userMessages + "/" + meta.assistantMessages + "/" + meta.toolResults));

    const actions = document.createElement("td");
    actions.appendChild(actionButton("预览", () => void preview(meta.id)));
    actions.appendChild(actionButton("重命名", () => void renameSession(meta.id, meta.name)));
    actions.appendChild(actionButton("删除", () => void removeSession(meta.id)));
    row.appendChild(actions);

    rows.appendChild(row);
  }
}

async function loadSessions() {
  try {
    notify("加载会话…");
    const sessions = await api("/api/sessions");
    renderSessionEntries(sessions.map((meta) => ({ meta })));
    notify("共 " + sessions.length + " 个会话");
  } catch (error) {
    notify("加载失败：" + error.message);
  }
}

async function searchSessions() {
  const query = $("session-query").value.trim();
  if (!query) {
    await loadSessions();
    return;
  }
  try {
    const hits = await api("/api/sessions/search?q=" + encodeURIComponent(query));
    renderSessionEntries(hits);
    notify("检索到 " + hits.length + " 个会话");
  } catch (error) {
    notify("检索失败：" + error.message);
  }
}

async function preview(ref) {
  try {
    const value = await api("/api/sessions/preview?ref=" + encodeURIComponent(ref));
    state.selected = value;
    const box = $("session-preview");
    clear(box);
    const head = document.createElement("p");
    head.textContent = (value.meta.name || "(无标题)") + " · " + value.meta.id;
    box.appendChild(head);
    for (const line of value.tail) {
      const item = document.createElement("p");
      item.className = "preview-line";
      item.textContent = line.role + "：" + line.text;
      box.appendChild(item);
    }
    const commands = document.createElement("p");
    commands.className = "muted small";
    commands.textContent = value.resumeCommand + " ｜ " + value.forkCommand;
    box.appendChild(commands);

    $("session-resume").disabled = false;
    $("session-fork").disabled = false;
    $("session-resume").dataset.ref = value.meta.id;
    $("session-fork").dataset.ref = value.meta.id;
    if (!$("agent-cwd").value && value.meta.cwd) $("agent-cwd").value = value.meta.cwd;
    $("agent-session-ref").value = value.meta.id;
  } catch (error) {
    notify("预览失败：" + error.message);
  }
}

async function renameSession(ref, currentName) {
  const name = window.prompt("新的会话显示名（追加一条 session_info，不改文件名）", currentName || "");
  if (name === null) return;
  try {
    const plan = await api("/api/sessions/rename", { method: "POST", body: { ref, name } });
    const go = window.confirm("将向会话文件末尾追加：\n\n" + plan.appendLine + "\n\n文件：" + plan.file + "\n确认执行？");
    if (!go) return;
    await api("/api/sessions/rename", { method: "POST", body: { ref, name, confirm: true } });
    notify("重命名完成");
    await loadSessions();
  } catch (error) {
    notify("重命名失败：" + error.message);
  }
}

async function removeSession(ref) {
  try {
    const plan = await api("/api/sessions/delete", { method: "POST", body: { ref } });
    const go = window.confirm("将移动到回收站：\n\n" + plan.file + "\n→ " + plan.trashDir + "/" + plan.trashName + "\n\n可在回收站恢复，确认删除？");
    if (!go) return;
    await api("/api/sessions/delete", { method: "POST", body: { ref, confirm: true } });
    notify("已移入回收站");
    await Promise.all([loadSessions(), loadTrash()]);
  } catch (error) {
    notify("删除失败：" + error.message);
  }
}

async function loadTrash() {
  try {
    const entries = await api("/api/trash");
    const list = $("trash-list");
    clear(list);
    $("trash-empty").hidden = entries.length > 0;
    for (const entry of entries) {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = entry.origPath + "（" + formatBytes(entry.sizeBytes) + "，" + formatTime(entry.deletedAt) + "）";
      item.appendChild(label);
      item.appendChild(actionButton("恢复", () => void restoreSession(entry.name)));
      list.appendChild(item);
    }
  } catch (error) {
    notify("回收站加载失败：" + error.message);
  }
}

async function restoreSession(name) {
  try {
    const plan = await api("/api/trash/restore", { method: "POST", body: { name } });
    if (!window.confirm("恢复到：\n\n" + plan.restoredPath + "\n确认恢复？")) return;
    await api("/api/trash/restore", { method: "POST", body: { name, confirm: true } });
    notify("恢复完成");
    await Promise.all([loadSessions(), loadTrash()]);
  } catch (error) {
    notify("恢复失败：" + error.message);
  }
}

// ------------------------------------------------------------------ Agents

function startAgentTimer() {
  stopAgentTimer();
  state.timers.agents = window.setInterval(() => {
    if (document.hidden) return;
    void refreshAgents();
  }, 2000);
}

function stopAgentTimer() {
  if (state.timers.agents !== null) {
    window.clearInterval(state.timers.agents);
    state.timers.agents = null;
  }
}

function startDetailTimer() {
  stopDetailTimer();
  state.timers.detail = window.setInterval(() => {
    if (document.hidden) return;
    void pollDetail();
  }, 1000);
}

function stopDetailTimer() {
  if (state.timers.detail !== null) {
    window.clearInterval(state.timers.detail);
    state.timers.detail = null;
  }
}

async function refreshAgents() {
  try {
    state.agents = await api("/api/agents");
    renderAgents();
  } catch (error) {
    notify("agent 列表加载失败：" + error.message);
  }
}

function renderAgents() {
  const rows = $("agent-rows");
  clear(rows);
  $("agent-empty").hidden = state.agents.length > 0;
  for (const agent of state.agents) {
    const row = document.createElement("tr");
    row.appendChild(cell(agent.id));
    row.appendChild(cell(agent.status));
    row.appendChild(cell(agent.pid === undefined ? "—" : agent.pid));
    row.appendChild(cell(agent.spec.kind));
    row.appendChild(cell(agent.spec.model));
    row.appendChild(cell(formatTime(agent.startedAt)));
    row.appendChild(cell(agent.lastText || agent.error));
    const actions = document.createElement("td");
    actions.appendChild(actionButton("详情", () => void openDetail(agent.id)));
    if (agent.status === "running") actions.appendChild(actionButton("停止", () => void stopAgent(agent.id)));
    row.appendChild(actions);
    rows.appendChild(row);
  }
  if (state.detail) {
    const current = state.agents.find((agent) => agent.id === state.detail.id);
    if (current) $("agent-detail-title").textContent = "详情 " + current.id + "（" + current.status + "）";
  }
}

async function startAgent(event) {
  event.preventDefault();
  const kind = document.querySelector('input[name="agent-kind"]:checked').value;
  const body = {
    cwd: $("agent-cwd").value.trim(),
    prompt: $("agent-prompt").value,
    kind,
  };
  const model = $("agent-model").value.trim();
  const name = $("agent-name").value.trim();
  if (model) body.model = model;
  if (name) body.name = name;
  if (kind !== "new") body.sessionRef = $("agent-session-ref").value.trim();
  try {
    const record = await api("/api/agents/start", { method: "POST", body });
    $("agent-form-note").textContent = "已启动 " + record.id;
    notify("agent " + record.id + " 已启动");
    await refreshAgents();
    await openDetail(record.id);
  } catch (error) {
    notify("启动失败：" + error.message);
  }
}

async function stopAgent(id) {
  if (!window.confirm("确认停止 agent " + id + "？将杀掉整个进程树（进行中的回合会丢失）。")) return;
  try {
    await api("/api/agents/" + id + "/stop", { method: "POST", body: {} });
    notify("已请求停止 " + id);
    await refreshAgents();
  } catch (error) {
    notify("停止失败：" + error.message);
  }
}

async function openDetail(id) {
  state.detail = { id, since: 0 };
  $("agent-detail").classList.remove("hidden");
  $("agent-output").textContent = "";
  $("agent-detail-title").textContent = "详情 " + id;
  await pollDetail();
  startDetailTimer();
}

async function pollDetail() {
  if (!state.detail) return;
  const id = state.detail.id;
  try {
    const output = await api("/api/agents/" + id + "/output?since=" + state.detail.since);
    if (output.lines.length) {
      const pre = $("agent-output");
      for (const line of output.lines) {
        pre.textContent += "[" + line.seq + "] " + line.kind + " " + formatTime(line.at) + "  " + line.text + "\n";
      }
      state.detail.since = output.lines[output.lines.length - 1].seq;
      pre.scrollTop = pre.scrollHeight;
    }
    const record = await api("/api/agents/" + id);
    $("agent-detail-title").textContent = "详情 " + record.id + "（" + record.status + "）";
    if (record.status !== "running") stopDetailTimer();
  } catch (error) {
    notify("详情加载失败：" + error.message);
    stopDetailTimer();
  }
}

// ------------------------------------------------------------------ 设置

async function loadSettings() {
  try {
    const info = await api("/api/settings");
    $("settings-session-dir").value = info.settings.sessionDir;
    $("settings-pi-path").value = info.settings.piPath || "";
    $("settings-port").value = String(info.settings.port);
    renderResolved(info);
  } catch (error) {
    notify("设置加载失败：" + error.message);
  }
}

function renderResolved(info) {
  const pre = $("settings-resolved");
  clear(pre);
  pre.textContent = [
    "配置文件：" + info.configPath,
    "回收站：" + info.settings.trashDir,
    "会话目录：" + info.settings.sessionDir,
    "pi 命令：" + info.resolvedPi.command + " " + info.resolvedPi.prefixArgs.join(" "),
    "启动时自动打开浏览器：" + (info.settings.openBrowser ? "是" : "否"),
  ].join("\n");
}

async function saveSettings(event) {
  event.preventDefault();
  const body = {
    sessionDir: $("settings-session-dir").value.trim(),
    piPath: $("settings-pi-path").value.trim(),
  };
  const port = $("settings-port").value.trim();
  if (port !== "") body.port = Number(port);
  try {
    const result = await api("/api/settings", { method: "POST", body });
    await loadSettings();
    $("settings-note").textContent = result.restartRequired ? "已保存；端口变更下次启动生效。" : "已保存并即时生效。";
  } catch (error) {
    $("settings-note").textContent = "保存失败：" + error.message;
  }
}

// ------------------------------------------------------------------ 接续/分支预填

function prefillAgent(kind, ref) {
  const radio = document.querySelector('input[name="agent-kind"][value="' + kind + '"]');
  if (radio) radio.checked = true;
  if (ref) $("agent-session-ref").value = ref;
  if (state.selected && state.selected.meta.cwd && !$("agent-cwd").value) {
    $("agent-cwd").value = state.selected.meta.cwd;
  }
  showTab("agents");
  $("agent-prompt").focus();
}

// ------------------------------------------------------------------ 初始化

function init() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  }
  $("session-search").addEventListener("click", () => void searchSessions());
  $("session-reload").addEventListener("click", () => void loadSessions());
  $("session-query").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void searchSessions();
    }
  });
  $("session-resume").addEventListener("click", () => prefillAgent("resume", $("session-resume").dataset.ref));
  $("session-fork").addEventListener("click", () => prefillAgent("fork", $("session-fork").dataset.ref));
  $("agent-form").addEventListener("submit", (event) => void startAgent(event));
  $("agents-reload").addEventListener("click", () => void refreshAgents());
  $("agent-detail-close").addEventListener("click", () => {
    stopDetailTimer();
    state.detail = null;
    $("agent-detail").classList.add("hidden");
  });
  $("settings-form").addEventListener("submit", (event) => void saveSettings(event));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if ($("panel-agents").classList.contains("is-active")) void refreshAgents();
    if (state.detail) void pollDetail();
  });
  showTab("sessions");
}

init();
