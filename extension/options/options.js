const KNOWN_MODELS = [
  { name: "jev-1.14.0", note: "推荐" },
  { name: "jev-latest", note: "别名，跟随最新版" },
  { name: "jev-1.13.0", note: "" },
];

const $ = (id) => document.getElementById(id);

let toastTimer = null;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.dataset.show = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.dataset.show = "0"), 1600);
}

async function save(patch) {
  await chrome.storage.local.set(patch);
  toast("已保存");
}

function fillModels(current, fetched = []) {
  const select = $("model");
  const names = new Map(KNOWN_MODELS.map((m) => [m.name, m.note]));
  for (const m of fetched) if (!names.has(m.name)) names.set(m.name, m.description ?? "");
  if (current && !names.has(current)) names.set(current, "");
  select.replaceChildren(
    ...[...names].map(([name, note]) => new Option(note ? `${name}（${note}）` : name, name)),
  );
  select.value = current;
}

function parseWhitelist(text) {
  const handles = text
    .split(/[\s,，]+/)
    .map((h) => h.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  return [...new Set(handles)];
}

function setStatus(el, text, tone = "") {
  el.textContent = text;
  el.dataset.tone = tone;
}

async function init() {
  const s = await aidfLoadSettings();

  $("apiKey").value = s.apiKey;
  fillModels(s.model);
  $("threshold").value = s.threshold;
  $("thresholdValue").textContent = Number(s.threshold).toFixed(2);
  document.querySelector(`input[name="action"][value="${s.action}"]`).checked = true;
  $("scanPosts").checked = s.scanPosts;
  $("scanReplies").checked = s.scanReplies;
  $("showScores").checked = s.showScores;
  $("minLength").value = s.minLength;
  $("whitelist").value = s.whitelist.map((h) => `@${h}`).join("\n");
  $("apiBase").value = s.apiBase;

  $("apiKey").addEventListener("change", (e) => save({ apiKey: e.target.value.trim() }));
  $("toggleKey").addEventListener("click", () => {
    const input = $("apiKey");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("toggleKey").textContent = show ? "隐藏" : "显示";
  });
  $("testKey").addEventListener("click", testConnection);

  $("model").addEventListener("change", (e) => save({ model: e.target.value }));
  $("threshold").addEventListener("input", (e) => {
    $("thresholdValue").textContent = Number(e.target.value).toFixed(2);
  });
  $("threshold").addEventListener("change", (e) => save({ threshold: Number(e.target.value) }));
  for (const radio of document.querySelectorAll('input[name="action"]')) {
    radio.addEventListener("change", (e) => save({ action: e.target.value }));
  }
  $("scanPosts").addEventListener("change", (e) => save({ scanPosts: e.target.checked }));
  $("scanReplies").addEventListener("change", (e) => save({ scanReplies: e.target.checked }));
  $("showScores").addEventListener("change", (e) => save({ showScores: e.target.checked }));
  $("minLength").addEventListener("change", (e) => {
    const n = Math.max(0, Math.min(500, Math.round(Number(e.target.value) || 0)));
    e.target.value = n;
    save({ minLength: n });
  });
  $("whitelist").addEventListener("change", (e) => {
    const whitelist = parseWhitelist(e.target.value);
    e.target.value = whitelist.map((h) => `@${h}`).join("\n");
    save({ whitelist });
  });

  $("saveBase").addEventListener("click", saveApiBase);
  $("clearCache").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "clearCache" });
    setStatus($("cacheStatus"), "缓存已清除", "ok");
  });
}

async function testConnection() {
  const status = $("keyStatus");
  const apiKey = $("apiKey").value.trim();
  if (!apiKey) {
    setStatus(status, "请先填写 API Key", "error");
    return;
  }
  await save({ apiKey });
  setStatus(status, "正在连接…");
  const res = await chrome.runtime.sendMessage({ type: "listModels", apiKey });
  if (res?.error) {
    setStatus(status, `连接失败：${res.error}`, "error");
    return;
  }
  const models = res.models ?? [];
  fillModels($("model").value, models);
  setStatus(
    status,
    models.length ? `连接成功，可用模型：${models.map((m) => m.name).join("、")}` : "连接成功",
    "ok",
  );
}

async function saveApiBase() {
  const status = $("baseStatus");
  let url;
  try {
    url = new URL($("apiBase").value.trim() || AIDF_DEFAULTS.apiBase);
  } catch {
    setStatus(status, "地址格式不正确", "error");
    return;
  }
  const apiBase = url.href.replace(/\/+$/, "");
  if (url.origin !== new URL(AIDF_DEFAULTS.apiBase).origin) {
    // Must run inside the click handler: permission prompts need a user gesture.
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!granted) {
      setStatus(status, `未获得访问 ${url.origin} 的权限，地址没有保存`, "error");
      return;
    }
  }
  $("apiBase").value = apiBase;
  await save({ apiBase });
  setStatus(status, `已保存：${apiBase}`, "ok");
}

init();
