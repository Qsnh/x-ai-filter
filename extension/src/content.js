// Scans posts on x.com, asks the background worker for an AI-written
// probability per post, and collapses the ones at or above the threshold.
//
// X re-renders and recycles <article> nodes as you scroll, so every mark we
// leave is keyed by the post it belongs to and re-checked on each scan. We use
// data-* attributes rather than classes because React rewrites className.
(() => {
  const SEL = {
    article: 'article[data-testid="tweet"]',
    text: '[data-testid="tweetText"]',
    userName: '[data-testid="User-Name"]',
    quote: 'div[role="link"]',
  };
  const BAR_CLASS = "aidf-bar";
  const RETRY_AFTER_MS = 30_000;
  const MAX_TEXT = 4000;
  const MAX_QUOTE = 1000;

  let settings = null;
  // Keyed by verdict key: the post key, plus "@reply" when the post was judged
  // as a reply with its parent as context (a different question set).
  const results = new Map(); // verdict key -> { probability, signals } | { error, code, at }
  const pending = new Set(); // verdict keys awaiting a response
  const revealed = new Set(); // verdict keys the user expanded
  let focalPost = null; // the post opened on a /status/ page, context for replies
  let halted = null; // "no_key" | "auth": stop sending until settings change
  let lastError = null;

  // ---- extraction ----

  function isInsideQuote(el, article) {
    const quote = el.parentElement?.closest(SEL.quote);
    return !!quote && article.contains(quote);
  }

  // Text nodes plus emoji, which X renders as <img alt="😀">.
  function readText(el, max) {
    let out = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue;
      else if (n.tagName === "IMG" && n.alt) out += n.alt;
      else if (n.tagName === "BR") out += "\n";
    }
    return out.replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
  }

  // The timestamp links to the post itself; a quoted post's timestamp sits
  // inside the quote card, so skip those.
  function statusOf(article) {
    for (const time of article.querySelectorAll("a[href*='/status/'] time")) {
      const a = time.closest("a");
      const m = a.getAttribute("href").match(/^\/([^/]+)\/status\/(\d+)/);
      if (m && !isInsideQuote(a, article)) return { handle: m[1], id: m[2] };
    }
    return null;
  }

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
  }

  function extract(article) {
    const status = statusOf(article);
    const texts = [...article.querySelectorAll(SEL.text)];
    const main = texts.find((el) => !isInsideQuote(el, article));
    const quote = texts.find((el) => isInsideQuote(el, article));
    const text = main ? readText(main, MAX_TEXT) : "";
    const author = status
      ? `@${status.handle}`
      : (article.querySelector(SEL.userName)?.textContent.match(/@\w{1,15}/)?.[0] ?? "");
    const key = status ? `id:${status.id}` : text ? `h:${hash(`${author}\n${text}`)}` : null;
    return {
      key,
      id: status?.id ?? null,
      author,
      text,
      quoted: quote ? readText(quote, MAX_QUOTE) : "",
    };
  }

  function focalId() {
    return location.pathname.match(/\/status\/(\d+)/)?.[1] ?? null;
  }

  // ---- eligibility ----

  // null when the post should be checked, else why it is skipped.
  function skipReason(item, isReply) {
    if (!item.text) return "没有文字";
    if (!(isReply ? settings.scanReplies : settings.scanPosts)) return isReply ? "回复扫描已关闭" : "帖子扫描已关闭";
    if (item.text.length < settings.minLength) return `少于 ${settings.minLength} 字`;
    const handle = item.author.replace(/^@/, "").toLowerCase();
    if (settings.whitelist.includes(handle)) return "白名单账号";
    return null;
  }

  // ---- talking to the background worker ----

  function requestVerdict(item) {
    const vkey = item.verdictKey;
    if (halted || pending.has(vkey)) return;
    const prev = results.get(vkey);
    if (prev?.error && Date.now() - prev.at < RETRY_AFTER_MS) return;

    pending.add(vkey);
    const payload = {
      key: vkey,
      kind: item.kind,
      author: item.author,
      text: item.text,
      quoted: item.quoted || undefined,
      parent: item.parent || undefined,
    };
    // sendMessage throws synchronously once the extension has been reloaded
    // under this tab; going through a promise turns that into a rejection.
    Promise.resolve()
      .then(() => chrome.runtime.sendMessage({ type: "classify", item: payload }))
      .then((res) => {
        if (res && typeof res.probability === "number") {
          results.set(vkey, { probability: res.probability, signals: res.signals ?? {} });
          lastError = null;
          return;
        }
        const error = res?.error ?? "后台无响应";
        if (res?.code === "no_key" || res?.code === "auth") halted = res.code;
        lastError = error;
        results.set(vkey, { error, code: res?.code, at: Date.now() });
      })
      .catch((err) => {
        lastError = String(err?.message ?? err);
        results.set(vkey, { error: lastError, at: Date.now() });
      })
      .finally(() => {
        pending.delete(vkey);
        scheduleScan();
      });
  }

  // ---- rendering ----

  function barOf(article) {
    const prev = article.previousElementSibling;
    return prev?.classList.contains(BAR_CLASS) ? prev : null;
  }

  function resetArticle(article) {
    barOf(article)?.remove();
    delete article.dataset.aidfCollapsed;
  }

  function setText(el, value) {
    if (el.textContent !== value) el.textContent = value;
  }

  const pct = (p) => `${Math.round(p * 100)}%`;

  const SIGNAL_NAMES = { ai_generated: "AI 文风", templated_reply: "套话式回复" };

  function describeSignals(signals) {
    return Object.entries(signals)
      .map(([name, p]) => `${SIGNAL_NAMES[name] ?? name} ${pct(p)}`)
      .join(" · ");
  }

  // The signal that pushed the score up, e.g. "套话式回复".
  function topSignal(signals) {
    let best = null;
    for (const [name, p] of Object.entries(signals)) if (!best || p > best[1]) best = [name, p];
    return best ? (SIGNAL_NAMES[best[0]] ?? best[0]) : "AI";
  }

  function createBar() {
    const bar = document.createElement("div");
    bar.className = BAR_CLASS;
    bar.innerHTML =
      '<span class="aidf-badge"></span>' +
      '<span class="aidf-label"></span>' +
      '<span class="aidf-score"></span>' +
      '<button type="button" class="aidf-toggle"></button>';
    bar.addEventListener("click", (e) => {
      // Keep X from treating the click as "open this post".
      e.preventDefault();
      e.stopPropagation();
      if (!e.target.closest(".aidf-toggle")) return;
      const key = bar.dataset.key;
      if (revealed.has(key)) revealed.delete(key);
      else revealed.add(key);
      scan();
    });
    return bar;
  }

  function ensureBar(article, item) {
    let bar = barOf(article);
    if (!bar) {
      bar = createBar();
      article.before(bar);
    }
    bar.dataset.key = item.verdictKey;
    bar.dataset.post = item.key;
    return bar;
  }

  function fillBar(bar, { variant, badge, label, score, title, toggle }) {
    bar.dataset.variant = variant;
    setText(bar.querySelector(".aidf-badge"), badge);
    setText(bar.querySelector(".aidf-label"), label);
    setText(bar.querySelector(".aidf-score"), score);
    if (bar.title !== title) bar.title = title;
    const button = bar.querySelector(".aidf-toggle");
    button.hidden = !toggle;
    setText(button, toggle ?? "");
  }

  function render(article, item, skip) {
    const result = results.get(item.verdictKey);
    const scored = typeof result?.probability === "number";
    const flagged = !skip && scored && result.probability >= settings.threshold;

    if (flagged) {
      const bar = ensureBar(article, item);
      const collapsible = settings.action === "collapse";
      const collapsed = collapsible && !revealed.has(item.verdictKey);
      if (collapsed) article.dataset.aidfCollapsed = "1";
      else delete article.dataset.aidfCollapsed;
      bar.dataset.collapsed = collapsed ? "1" : "0";
      const reason = topSignal(result.signals);
      fillBar(bar, {
        variant: "flag",
        badge: "AI",
        label: `${collapsed ? "已折叠" : "疑似 AI"} · ${reason} · ${item.author}`,
        score: pct(result.probability),
        title: describeSignals(result.signals),
        toggle: collapsible ? (collapsed ? "展开" : "折叠") : null,
      });
      return;
    }

    delete article.dataset.aidfCollapsed;
    if (!settings.showScores) {
      barOf(article)?.remove();
      return;
    }

    // Diagnostics: say what happened to every post, not just flagged ones.
    let label;
    let score = "";
    let title = "";
    if (skip) label = `未检测：${skip}`;
    else if (scored) {
      label = `低于阈值 ${pct(settings.threshold)} · ${describeSignals(result.signals)}`;
      score = pct(result.probability);
      title = label;
    } else if (result?.error && !pending.has(item.verdictKey)) label = `检测失败：${result.error}`;
    else if (halted && !pending.has(item.verdictKey)) label = `未检测：${halted === "no_key" ? "未配置 API Key" : "API Key 无效"}`;
    else label = "检测中…";
    const bar = ensureBar(article, item);
    bar.dataset.collapsed = "0";
    fillBar(bar, { variant: "info", badge: "检测", label, score, title, toggle: null });
  }

  function removeOrphanBars() {
    for (const bar of document.querySelectorAll(`.${BAR_CLASS}`)) {
      const next = bar.nextElementSibling;
      if (!next?.matches(SEL.article) || next.dataset.aidfKey !== bar.dataset.post) bar.remove();
    }
  }

  function syncTheme() {
    const [r, g, b] = (getComputedStyle(document.body).backgroundColor.match(/\d+/g) ?? [255, 255, 255]).map(Number);
    const dark = 0.299 * r + 0.587 * g + 0.114 * b < 128;
    document.documentElement.dataset.aidfTheme = dark ? "dark" : "light";
  }

  // ---- main loop ----

  function scan() {
    if (!settings) return;
    syncTheme();

    const fid = focalId();
    const articles = [...document.querySelectorAll(SEL.article)];
    const items = articles.map(extract);

    let focalIndex = -1;
    if (fid) {
      focalIndex = items.findIndex((it) => it.id === fid);
      if (focalIndex >= 0) focalPost = { id: fid, author: items[focalIndex].author, text: items[focalIndex].text };
    }
    const parent = fid && focalPost?.id === fid ? { author: focalPost.author, text: focalPost.text } : null;

    articles.forEach((article, i) => {
      const item = items[i];
      if (!item.key) {
        resetArticle(article);
        delete article.dataset.aidfKey;
        return;
      }
      if (article.dataset.aidfKey !== item.key) {
        resetArticle(article);
        article.dataset.aidfKey = item.key;
      }

      // On a /status/ page, posts above the opened one are its thread
      // ancestors; everything after it (or everything, once it has scrolled
      // out of the DOM) is a reply.
      const isReply = !!fid && item.id !== fid && (focalIndex < 0 || i > focalIndex);
      item.kind = isReply ? "reply" : "post";
      if (isReply && parent) item.parent = parent;
      item.verdictKey = item.parent ? `${item.key}@reply` : item.key;

      if (!settings.enabled) {
        resetArticle(article);
        return;
      }
      const skip = skipReason(item, isReply);
      if (!skip && typeof results.get(item.verdictKey)?.probability !== "number") requestVerdict(item);
      render(article, item, skip);
    });

    removeOrphanBars();
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 250);
  }

  // Ignore mutations we caused, or every bar update would trigger a rescan.
  function isOwnMutation(record) {
    if (record.target.closest?.(`.${BAR_CLASS}`)) return true;
    const nodes = [...record.addedNodes, ...record.removedNodes];
    return nodes.length > 0 && nodes.every((n) => n.classList?.contains(BAR_CLASS));
  }

  new MutationObserver((records) => {
    if (records.some((r) => !isOwnMutation(r))) scheduleScan();
  }).observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    const keys = Object.keys(changes).filter((k) => k in AIDF_DEFAULTS);
    if (!keys.length) return;
    if (keys.some((k) => k === "model" || k === "apiBase")) results.clear();
    if (keys.some((k) => k === "apiKey" || k === "model" || k === "apiBase")) {
      halted = null;
      lastError = null;
      for (const [key, r] of results) if (r.error) results.delete(key);
    }
    settings = await aidfLoadSettings();
    scan();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "pageStats" || !settings) return false;
    let checked = 0;
    let flagged = 0;
    for (const r of results.values()) {
      if (typeof r.probability !== "number") continue;
      checked++;
      if (r.probability >= settings.threshold) flagged++;
    }
    sendResponse({ checked, flagged, pending: pending.size, halted, lastError });
    return false;
  });

  aidfLoadSettings().then((s) => {
    settings = s;
    scan();
  });
})();
