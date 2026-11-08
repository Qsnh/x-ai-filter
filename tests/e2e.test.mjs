// Loads the real extension into Chromium, serves X-like pages for x.com via
// request interception, and points the extension at a local mock of the
// TypeSafe API. Run with: npm run test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = process.env.AIDF_SHOTS;

// ---- mock TypeSafe API ----

const calls = []; // parsed /v1/systemone bodies
const rateLimitedOnce = new Set();

// [AI] trips the style question, [ECHO] the templated-reply one, [MAYBE]
// sits just under the default 0.6 threshold.
function styleScore(text) {
  if (text.includes("[AI]")) return 0.95;
  if (text.includes("[MAYBE]")) return 0.5;
  return 0.05;
}
const echoScore = (text) => (text.includes("[ECHO]") ? 0.93 : 0.03);

const api = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== "Bearer test-key") return send(401, { detail: "Invalid API key" });
  if (req.method === "GET" && req.url === "/v1/models") {
    return send(200, { models: [{ name: "jev-1.14.0", description: "Jev 1.14", release_date: "2026-10-14" }] });
  }
  if (req.method === "POST" && req.url === "/v1/systemone") {
    const body = JSON.parse(raw);
    calls.push(body);
    const text = body.state.post.text;
    if (text.includes("[RATE]") && !rateLimitedOnce.has(text)) {
      rateLimitedOnce.add(text);
      return send(429, { detail: "rate limited" }, { "retry-after": "0" });
    }
    const answers = { ai_generated: { type: "noul", noul: styleScore(text) } };
    if (body.questions.templated_reply) answers.templated_reply = { type: "noul", noul: echoScore(text) };
    return send(200, { model: "jev-1.14.0", answers, usage: { input_tokens: 100, output_tokens: 1 } });
  }
  send(404, { detail: "not found" });
});

// ---- X-like markup ----

function article({ id, handle, text, quote }) {
  const quoteHtml = quote
    ? `<div role="link" tabindex="0"><div data-testid="User-Name"><span>@quoted</span>` +
      `<a href="/quoted/status/9${id}" role="link"><time>2h</time></a></div>` +
      `<div data-testid="tweetText"><span>${quote}</span></div></div>`
    : "";
  return (
    `<div data-testid="cellInnerDiv"><div><div>` +
    `<article data-testid="tweet" role="article" tabindex="0">` +
    `<div data-testid="User-Name"><a href="/${handle}" role="link"><span>${handle}</span></a>` +
    `<a href="/${handle}" role="link"><span>@${handle}</span></a>` +
    `<a href="/${handle}/status/${id}" role="link"><time datetime="2026-11-06T10:00:00Z">1h</time></a></div>` +
    `<div data-testid="tweetText" lang="en"><span>${text}</span></div>${quoteHtml}` +
    `</article></div></div></div>`
  );
}

const TIMELINE = [
  { id: "1001", handle: "alice", text: "[AI] In today's fast-paced world, embracing innovation is key 🚀 Here are 3 takeaways:" },
  { id: "1002", handle: "bob", text: "missed my train again, third time this week, unbelievable" },
  { id: "1003", handle: "carol", text: "this is exactly what I was saying yesterday", quote: "[AI] Unlock your potential with these tips" },
  { id: "1004", handle: "dave", text: 'Launch day <img alt="🚀" src="data:,"> for our tiny cafe app' },
  { id: "1007", handle: "erin", text: "ok" },
  { id: "1008", handle: "frank", text: "[MAYBE] Honestly a solid thread, thanks for sharing" },
  { id: "1009", handle: "gina", text: "[RATE] [AI] Absolutely! Consistency is the key to success." },
];

const DETAIL = [
  { id: "1999", handle: "alice", text: "Working on v2 of our editor, almost there" },
  { id: "2000", handle: "alice", text: "We shipped v2 of our editor today, finally." },
  { id: "2001", handle: "replyguy", text: "[AI] Great point! This is a game-changer for productivity." },
  { id: "2002", handle: "mia", text: "lol finally, the old one kept crashing on my laptop" },
  { id: "2003", handle: "echobot", text: "[ECHO] Shipping v2 of the editor is a big milestone, the hard work clearly paid off." },
  { id: "2004", handle: "kim", text: "nice" },
];

function page(posts, dark = false) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font: 15px system-ui; color: ${dark ? "#e7e9ea" : "#0f1419"}; }
    main { max-width: 600px; margin: 0 auto; border-left: 1px solid #8884; border-right: 1px solid #8884; }
    article { display: block; padding: 12px 16px; border-bottom: 1px solid #8884; }
    [data-testid="User-Name"] { display: flex; gap: 6px; font-weight: 600; }
    [data-testid="User-Name"] a { color: inherit; text-decoration: none; }
    div[role="link"] { margin-top: 8px; padding: 8px; border: 1px solid #8884; border-radius: 12px; }
  </style></head><body style="background-color: ${dark ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)"}">
  <main><div aria-label="Timeline">${posts.map(article).join("")}</div></main></body></html>`;
}

// ---- harness ----

let context;
let worker;
let tab;
let apiBase;
let tmp;

before(async () => {
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  apiBase = `http://127.0.0.1:${api.address().port}`;

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aidf-e2e-"));
  const extDir = path.join(tmp, "extension");
  await fs.cp(path.join(ROOT, "extension"), extDir, { recursive: true });
  // The real extension asks for proxy origins at runtime; tests grant it upfront.
  const manifestPath = path.join(extDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions.push("http://127.0.0.1/*");
  await fs.writeFile(manifestPath, JSON.stringify(manifest));

  context = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: { width: 700, height: 900 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate(
    (base) => chrome.storage.local.set({ apiKey: "test-key", apiBase: base }),
    apiBase,
  );

  await context.route("https://x.com/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/home") return route.fulfill({ contentType: "text/html", body: page(TIMELINE) });
    if (url.pathname === "/dark") return route.fulfill({ contentType: "text/html", body: page(TIMELINE.slice(0, 2), true) });
    return route.fulfill({ status: 404, body: "" });
  });
  tab = await context.newPage();
  tab.on("pageerror", (err) => console.error("page error:", err));
});

after(async () => {
  await context?.close();
  api.close();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

const callFor = (text) => calls.filter((c) => c.state.post.text.includes(text));
const isCollapsed = (id) =>
  tab.evaluate((id) => {
    const a = document.querySelector(`article[data-aidf-key="id:${id}"]`);
    return a?.dataset.aidfCollapsed === "1";
  }, id);
const barOf = (id) =>
  tab.evaluate((id) => {
    const a = document.querySelector(`article[data-aidf-key="id:${id}"]`);
    const bar = a?.previousElementSibling;
    if (!bar?.classList.contains("aidf-bar")) return null;
    return {
      variant: bar.dataset.variant,
      label: bar.querySelector(".aidf-label").textContent,
      score: bar.querySelector(".aidf-score").textContent,
      toggle: bar.querySelector(".aidf-toggle").textContent,
      toggleHidden: bar.querySelector(".aidf-toggle").hidden,
    };
  }, id);
const waitFor = (fn, arg) => tab.waitForFunction(fn, arg, { timeout: 8000 });
const waitCollapsed = (id, want = true) =>
  waitFor(
    ([id, want]) => (document.querySelector(`article[data-aidf-key="id:${id}"]`)?.dataset.aidfCollapsed === "1") === want,
    [id, want],
  );
const setSettings = (patch) => worker.evaluate((p) => chrome.storage.local.set(p), patch);
// Same message the popup sends. Without the "tabs" permission tab URLs are
// hidden from the worker, so ask every tab and keep the one that answers.
const pageStats = () =>
  worker.evaluate(async () => {
    for (const t of await chrome.tabs.query({})) {
      const res = await chrome.tabs.sendMessage(t.id, { type: "pageStats" }).catch(() => null);
      if (res) return res;
    }
    return null;
  });

test("timeline: AI posts collapse, human posts stay", async () => {
  await tab.goto("https://x.com/home");
  await waitCollapsed("1001");

  assert.deepEqual(await barOf("1001"), {
    variant: "flag",
    label: "已折叠 · AI 文风 · @alice",
    score: "95%",
    toggle: "展开",
    toggleHidden: false,
  });
  assert.equal(await isCollapsed("1002"), false);
  assert.equal(await barOf("1002"), null);
  assert.ok(await tab.isHidden('article[data-aidf-key="id:1001"]'));
  assert.ok(await tab.isVisible('article[data-aidf-key="id:1002"]'));
});

test("timeline: requests carry the right text, quote and kind", async () => {
  await waitFor(() => document.querySelectorAll("article[data-aidf-key]").length === 7);
  await waitCollapsed("1009"); // also exercises one 429 + retry inside the extension

  const [quotePost] = callFor("exactly what I was saying");
  assert.equal(quotePost.state.post.quoted_post, "[AI] Unlock your potential with these tips");
  assert.equal(quotePost.state.post.kind, "post");
  assert.equal(quotePost.state.replying_to, undefined);
  assert.equal(quotePost.model, "jev-1.14.0");
  assert.equal(await isCollapsed("1003"), false, "a quoted AI post must not flag the quoting post");

  assert.equal(callFor("Launch day")[0].state.post.text, "Launch day 🚀 for our tiny cafe app");
  assert.equal(callFor("ok").filter((c) => c.state.post.text === "ok").length, 0, "short posts are skipped");
  assert.equal(callFor("[RATE]").length, 2, "429 is retried once");
  assert.equal(await isCollapsed("1008"), false, "0.5 is below the default 0.6 threshold");
  assert.deepEqual(Object.keys(quotePost.questions), ["ai_generated"], "timeline posts only get the style question");
});

test("expand and re-collapse from the bar", async () => {
  await tab.click('.aidf-bar[data-key="id:1001"] .aidf-toggle');
  await waitCollapsed("1001", false);
  assert.equal((await barOf("1001")).toggle, "折叠");
  assert.equal((await barOf("1001")).label, "疑似 AI · AI 文风 · @alice");
  assert.equal(new URL(tab.url()).pathname, "/home", "clicking the bar must not navigate");

  await tab.click('.aidf-bar[data-key="id:1001"] .aidf-toggle');
  await waitCollapsed("1001", true);
});

test("new posts from infinite scroll are checked", async () => {
  await tab.evaluate(
    (html) => document.querySelector('[aria-label="Timeline"]').insertAdjacentHTML("beforeend", html),
    article({ id: "1005", handle: "zed", text: "[AI] Embrace the journey. Growth happens outside your comfort zone." }),
  );
  await waitCollapsed("1005");
});

test("a recycled article drops the old post's marks", async () => {
  await tab.evaluate(() => {
    const a = document.querySelector('article[data-aidf-key="id:1001"]');
    a.querySelector('a[href*="/status/"]').setAttribute("href", "/hank/status/1006");
    a.querySelector('[data-testid="tweetText"]').innerHTML = "<span>my cat just knocked the router off the shelf again</span>";
  });
  await waitFor(() => !!document.querySelector('article[data-aidf-key="id:1006"]'));
  await waitCollapsed("1006", false);
  assert.equal(await barOf("1006"), null);
  assert.equal(await tab.locator(".aidf-bar").count(), 2, "only 1005 and 1009 keep bars");
});

test("threshold, label mode, whitelist and on/off apply without new API calls", async () => {
  const before = calls.length;

  await setSettings({ threshold: 0.45 });
  await waitCollapsed("1008");

  await setSettings({ action: "label" });
  await waitCollapsed("1008", false);
  const bar = await barOf("1008");
  assert.equal(bar.label, "疑似 AI · AI 文风 · @frank");
  assert.equal(bar.toggleHidden, true);

  await setSettings({ action: "collapse", whitelist: ["frank"] });
  await waitFor(() => !document.querySelector('article[data-aidf-key="id:1008"]').previousElementSibling?.classList.contains("aidf-bar"));
  assert.equal(await isCollapsed("1008"), false);

  await setSettings({ enabled: false });
  await waitFor(() => document.querySelectorAll(".aidf-bar").length === 0);
  assert.equal(await tab.locator("article[data-aidf-collapsed]").count(), 0);

  await setSettings({ enabled: true, threshold: 0.6, whitelist: [] });
  await waitCollapsed("1005");
  assert.equal(calls.length, before, "decisions come from cached probabilities");
});

test("page stats reach the popup channel", async () => {
  const stats = await pageStats();
  assert.equal(stats.pending, 0);
  assert.equal(stats.lastError, null);
  assert.ok(stats.checked >= 7, `checked=${stats.checked}`);
  assert.equal(stats.flagged, 3); // 1001 (still cached), 1005, 1009
});

test("detail page: replies are sent with the opened post as context", async () => {
  // X is a single-page app: navigate with pushState and swap the content.
  await tab.evaluate((html) => {
    history.pushState({}, "", "/alice/status/2000");
    document.querySelector('[aria-label="Timeline"]').innerHTML = html;
  }, DETAIL.map(article).join(""));
  await waitCollapsed("2001");

  const [ancestor] = callFor("Working on v2");
  assert.equal(ancestor.state.post.kind, "post", "posts above the opened one are thread ancestors");
  assert.equal(ancestor.state.replying_to, undefined);

  const [focal] = callFor("We shipped v2");
  assert.equal(focal.state.post.kind, "post");

  const [aiReply] = callFor("game-changer");
  assert.equal(aiReply.state.post.kind, "reply");
  assert.deepEqual(aiReply.state.replying_to, { author: "@alice", text: "We shipped v2 of our editor today, finally." });
  assert.deepEqual(Object.keys(aiReply.questions), ["ai_generated", "templated_reply"]);
  assert.deepEqual(Object.keys(focal.questions), ["ai_generated"]);

  // Fluent replies that only echo the parent are caught by the second question.
  await waitCollapsed("2003");
  const echo = await barOf("2003");
  assert.equal(echo.label, "已折叠 · 套话式回复 · @echobot");
  assert.equal(echo.score, "93%");

  await waitFor(() => !!document.querySelector('article[data-aidf-key="id:2002"]'));
  assert.equal(callFor("crashing on my laptop")[0].state.post.kind, "reply");
  assert.equal(await isCollapsed("2002"), false);
  assert.equal(await isCollapsed("2000"), false);

  if (SHOTS) await tab.screenshot({ path: path.join(SHOTS, "detail-light.png") });
});

test("diagnostics mode shows every score and skip reason", async () => {
  await setSettings({ showScores: true });
  await waitFor(() => document.querySelectorAll('.aidf-bar[data-variant="info"]').length === 4);
  const human = await barOf("2002");
  assert.equal(human.variant, "info");
  assert.equal(human.label, "低于阈值 60% · AI 文风 5% · 套话式回复 3%");
  assert.equal(human.score, "5%");
  assert.equal((await barOf("2004")).label, "未检测：少于 15 字");
  assert.equal((await barOf("2001")).variant, "flag", "flagged posts keep their normal bar");

  await setSettings({ showScores: false });
  await waitFor(() => document.querySelectorAll('.aidf-bar[data-variant="info"]').length === 0);
  assert.equal(await isCollapsed("2001"), true);
});

test("dark theme is detected", async () => {
  await tab.goto("https://x.com/dark");
  await waitCollapsed("1001");
  assert.equal(await tab.evaluate(() => document.documentElement.dataset.aidfTheme), "dark");
  if (SHOTS) await tab.screenshot({ path: path.join(SHOTS, "timeline-dark.png") });
});

test("options page lists models through the background worker", async () => {
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  const errors = [];
  options.on("pageerror", (e) => errors.push(e));
  await options.goto(`chrome-extension://${id}/options/options.html`);
  assert.equal(await options.inputValue("#apiKey"), "test-key");
  assert.equal(await options.inputValue("#model"), "jev-1.14.0");
  await options.click("#testKey");
  await options.waitForFunction(() => document.querySelector("#keyStatus").dataset.tone === "ok");
  assert.match(await options.textContent("#keyStatus"), /连接成功/);

  await options.fill("#whitelist", "@Foo, bar\n@foo");
  await options.locator("#whitelist").blur();
  await options.waitForFunction(() => document.querySelector("#whitelist").value === "@foo\n@bar");
  assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get("whitelist")), { whitelist: ["foo", "bar"] });
  assert.deepEqual(errors, []);
  if (SHOTS) await options.screenshot({ path: path.join(SHOTS, "options.png"), fullPage: true });
  await options.close();
});

test("a bad key stops requests and is reported", async () => {
  await setSettings({ apiKey: "wrong", whitelist: [] });
  await tab.bringToFront();
  await tab.evaluate(
    (html) => document.querySelector('[aria-label="Timeline"]').insertAdjacentHTML("beforeend", html),
    article({ id: "3001", handle: "newbie", text: "[AI] Leverage synergies to maximise stakeholder value today." }),
  );
  let stats = null;
  for (let i = 0; i < 40 && !stats?.halted; i++) {
    await new Promise((r) => setTimeout(r, 200));
    stats = await pageStats();
  }
  assert.equal(stats?.halted, "auth");
  assert.match(stats.lastError, /API Key 无效/);
});
