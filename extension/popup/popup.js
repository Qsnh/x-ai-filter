const $ = (id) => document.getElementById(id);

function showNotice(text, tone = "info") {
  const el = $("notice");
  el.hidden = !text;
  el.textContent = text ?? "";
  el.dataset.tone = tone;
}

async function pageStats() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(mobile\.)?(x|twitter)\.com\//.test(tab.url ?? "")) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "pageStats" });
  } catch {
    // Tab was open before the extension loaded; the content script isn't there.
    return { stale: true };
  }
}

async function refresh() {
  const settings = await aidfLoadSettings();
  const { stats, lastError } = await chrome.storage.session.get(["stats", "lastError"]);
  const page = await pageStats();

  $("enabled").checked = settings.enabled;
  $("model").textContent = `${settings.model} · 阈值 ${Number(settings.threshold).toFixed(2)}`;

  const tokens = stats?.inputTokens ?? 0;
  $("session").textContent = stats?.requests
    ? `本次浏览器会话共调用 ${stats.requests} 次，输入 ${tokens.toLocaleString()} tokens（约 $${((tokens / 1e6) * 0.042).toFixed(4)}）`
    : "";

  const fill = (v) => (page && !page.stale ? String(v) : "–");
  $("checked").textContent = fill(page?.checked);
  $("flagged").textContent = fill(page?.flagged);
  $("pending").textContent = fill(page?.pending);

  const error = page?.lastError || lastError?.message;
  if (!settings.apiKey) showNotice("还没有填写 TypeSafe API Key，点“设置”填写后才会开始检测。", "warn");
  else if (error) showNotice(error, "error");
  else if (!page) showNotice("打开 x.com 后，这里会显示当前页面的检测情况。");
  else if (page.stale) showNotice("请刷新 X 页面，让插件开始工作。");
  else if (!settings.enabled) showNotice("已停用，所有折叠都已恢复。");
  else showNotice(null);
}

$("enabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  refresh();
});
$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

refresh();
setInterval(refresh, 1500);
