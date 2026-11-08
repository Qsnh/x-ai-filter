import "./settings.js";
import { QUESTION_VERSION, classify, listModels } from "./typesafe.js";

const CONCURRENCY = 4;
const CACHE_KEY = "resultCache";
const CACHE_MAX = 3000;

// ---- result cache (model|question version|verdict key -> { p, s, at }), persisted, LRU-trimmed ----

let cachePromise = null;
let persistTimer = null;

function getCache() {
  cachePromise ??= chrome.storage.local
    .get(CACHE_KEY)
    .then(({ [CACHE_KEY]: entries = [] }) => new Map(entries));
  return cachePromise;
}

function remember(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => chrome.storage.local.set({ [CACHE_KEY]: [...cache] }), 1000);
}

async function clearCache() {
  clearTimeout(persistTimer);
  cachePromise = Promise.resolve(new Map());
  await chrome.storage.local.remove(CACHE_KEY);
}

// ---- concurrency limit: a released slot is handed straight to the next waiter ----

let active = 0;
const waiting = [];

async function withSlot(fn) {
  if (active >= CONCURRENCY) await new Promise((resolve) => waiting.push(resolve));
  else active++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

// ---- session stats shown in the popup ----

let statsPromise = null;

function getStats() {
  statsPromise ??= chrome.storage.session
    .get("stats")
    .then(({ stats }) => stats ?? { requests: 0, inputTokens: 0 });
  return statsPromise;
}

async function recordCall({ usage, error }) {
  const stats = await getStats();
  stats.requests += 1;
  stats.inputTokens += usage?.input_tokens ?? 0;
  await chrome.storage.session.set({
    stats: { ...stats },
    lastError: error ? { message: error, at: Date.now() } : null,
  });
}

// ---- classification ----

const inflight = new Map();

async function handleClassify(item) {
  const settings = await aidfLoadSettings();
  if (!settings.apiKey) return { error: "未配置 TypeSafe API Key", code: "no_key" };

  const key = `${settings.model}|v${QUESTION_VERSION}|${item.key}`;
  const cache = await getCache();
  const hit = cache.get(key);
  if (hit) return { probability: hit.p, signals: hit.s, cached: true };

  let job = inflight.get(key);
  if (!job) {
    const { apiBase, apiKey, model } = settings;
    job = withSlot(() => classify(item, { apiBase, apiKey, model }))
      .then((result) => {
        remember(cache, key, { p: result.probability, s: result.signals, at: Date.now() });
        recordCall({ usage: result.usage });
        return result;
      })
      .catch((err) => {
        recordCall({ error: err.message });
        throw err;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
  }

  try {
    const { probability, signals } = await job;
    return { probability, signals };
  } catch (err) {
    const code = err.status === 401 || err.status === 403 ? "auth" : err.retryable ? "retry" : "fail";
    return { error: err.message, code };
  }
}

async function handleListModels({ apiKey, apiBase }) {
  const settings = await aidfLoadSettings();
  try {
    const models = await listModels({
      apiKey: apiKey ?? settings.apiKey,
      apiBase: apiBase ?? settings.apiBase,
    });
    return { models };
  } catch (err) {
    return { error: err.message };
  }
}

const handlers = {
  classify: (msg) => handleClassify(msg.item),
  listModels: (msg) => handleListModels(msg),
  clearCache: () => clearCache().then(() => ({ ok: true })),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg).then(sendResponse, (err) => sendResponse({ error: String(err?.message ?? err) }));
  return true;
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;
  const { apiKey } = await aidfLoadSettings();
  if (!apiKey) chrome.runtime.openOptionsPage();
});
