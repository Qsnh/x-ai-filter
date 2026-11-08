// Minimal client for the TypeSafe System One API (https://docs.typesafe.ai).
// Jev answers typed questions about a "state". We ask Noul (yes/no) questions
// and treat the highest "yes" probability as the post's AI score.

// Bump whenever the questions change, so cached answers to old ones are dropped.
export const QUESTION_VERSION = 3;

// Signal names, in the order the UI lists them.
export const SIGNALS = Object.freeze(["ai_generated", "templated_reply"]);

const QUESTIONS = Object.freeze({
  // How the text itself reads.
  ai_generated: {
    type: "noul",
    instructions:
      "Was `post.text` written by an AI language model (for example ChatGPT-style " +
      "generated text or an automated AI reply bot) rather than typed by a human? " +
      "The text may be in any language.",
    criteria: {
      true:
        "Reads as LLM output: generic, polished, template-like phrasing; balanced " +
        "summary sentences that sound like a conclusion; formulaic praise or engagement " +
        'bait ("Great point!", "This is a game-changer", "说得太对了", "真正的价值在于"); ' +
        "tidy lists, emoji bullets, em dashes or hashtags arranged the way people rarely " +
        "type; could be pasted under almost any post",
      false:
        "Reads as written by a person: specific personal experience or opinion, slang, " +
        "typos, in-jokes, terse or messy wording, or details only a human would add; " +
        "short casual replies count as human unless clearly bot-like",
    },
  },
  // How a reply relates to the post it answers. AI reply bots write fluent,
  // natural-sounding replies, so their style alone often passes as human; what
  // gives them away is that they only echo the parent post.
  templated_reply: {
    type: "noul",
    instructions:
      "Is `post.text` a templated reply of the kind AI reply bots post, instead of a " +
      "reaction in the replier's own voice? Templated replies sum up `replying_to` (its " +
      "text, or what it shows) as a neat verdict, echo its punchline back, or wrap polished " +
      "praise, congratulations or encouragement around a restatement of the post. " +
      "The text may be in any language.",
    criteria: {
      true:
        "Paraphrases or sums up the parent post, or the product, screenshot or idea it " +
        "shows, as a tidy high-level verdict or insight (\"brings the big-company AI " +
        'workflow to your desktop", "把…直接塞进…", "这才是…该有的样子", "思路很清晰", ' +
        '"真正释放了生产力", "is the future of productivity"), echoes the parent\'s own ' +
        'words or punchline back ("这下是真停不下来了", "the key is still…"), or wraps ' +
        "polished praise, congratulations or encouragement around a restatement of the " +
        "post's own details (\"shipping v2 in 3 weeks with a team of two is next-level " +
        'execution", "这份坚持本身就是最好的答案"). A ' +
        "high-level description of the product or topic counts as summing up even when " +
        "those words are not in the parent text, because the parent may include images. " +
        "No personal experience, specific question, disagreement or joke of its own",
      false:
        "Reacts in the replier's own voice: what they personally did, saw or felt, with " +
        'specifics ("昨晚玩到三点", "used it to write my weekly report"), a concrete ' +
        "question, a comparison they ask about, disagreement or criticism, a joke or " +
        "teasing of its own (such as pointing out a typo), casual slangy reactions " +
        '("牛逼", "this is sick"), saying they will follow, try or wait for it, or asking ' +
        "for access. A stock phrase on its own (\"congrats, well deserved\", \"love this\", " +
        '"恭喜恭喜") is too short to judge: answer no unless it also restates or sums up ' +
        "the post. Repeating a word from the post is fine when the reply also adds " +
        "something personal",
    },
  },
});

const RETRYABLE_STATUS = new Set([429, 529, 500, 502, 503, 504]);

export class TypeSafeError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = "TypeSafeError";
    this.status = status;
    this.retryable = retryable;
  }
}

const hasParent = (item) => item.kind === "reply" && !!item.parent?.text;

/**
 * item: { kind: "post" | "reply", author, text, quoted?, parent?: { author, text } }
 */
export function buildState(item) {
  const post = { kind: item.kind, author: item.author, text: item.text };
  if (item.quoted) post.quoted_post = item.quoted;
  const state = { platform: "X (formerly Twitter)", post };
  if (hasParent(item)) {
    state.replying_to = { author: item.parent.author, text: item.parent.text };
  }
  return state;
}

export function buildRequest(item, model) {
  const questions = { ai_generated: QUESTIONS.ai_generated };
  if (hasParent(item)) questions.templated_reply = QUESTIONS.templated_reply;
  return { model, state: buildState(item), questions };
}

// → { probability, signals: { ai_generated, templated_reply? }, model, usage }
export function parseAnswer(body) {
  const signals = {};
  for (const name of SIGNALS) {
    const p = body?.answers?.[name]?.noul;
    if (typeof p === "number" && !Number.isNaN(p)) signals[name] = Math.min(1, Math.max(0, p));
  }
  const values = Object.values(signals);
  if (!values.length) throw new TypeSafeError("响应里没有 noul 概率字段");
  return { probability: Math.max(...values), signals, model: body.model, usage: body.usage };
}

// Error bodies carry `detail`: a string, an object such as
// { error_type, message }, or (422) a list of { loc, msg, type } entries.
export function describeErrorBody(body) {
  const detail = body?.detail;
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => [Array.isArray(d.loc) ? d.loc.join(".") : "", d.msg].filter(Boolean).join(": "))
      .join("; ");
  }
  if (typeof detail.message === "string") return detail.message;
  return JSON.stringify(detail);
}

function statusMessage(status, detail) {
  const base =
    {
      400: "请求无效",
      401: "API Key 无效或已失效",
      403: "没有权限访问该模型",
      413: "请求体过大",
      422: "请求格式校验失败",
      429: "超出速率限制",
      529: "TypeSafe 服务繁忙",
    }[status] ?? `HTTP ${status}`;
  return detail ? `${base}：${detail}` : base;
}

// Delay before retry `attempt` (0-based): honour retry-after, else exponential
// backoff with jitter, as the TypeSafe docs ask for 429 / 529.
export function retryDelayMs(attempt, retryAfterHeader, random = Math.random) {
  const seconds = Number(retryAfterHeader);
  if (retryAfterHeader != null && retryAfterHeader !== "" && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 30_000);
  }
  const base = 500 * 2 ** attempt;
  return Math.min(base + random() * base, 15_000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, init, { fetchImpl = fetch, maxRetries = 3, wait = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      if (attempt >= maxRetries) throw new TypeSafeError(`网络错误：${err.message}`, { retryable: true });
      await wait(retryDelayMs(attempt, null));
      continue;
    }
    if (res.ok) return res.json();

    let detail = "";
    try {
      detail = describeErrorBody(await res.json());
    } catch {
      // Non-JSON error body; the status code is enough.
    }
    const retryable = RETRYABLE_STATUS.has(res.status);
    if (!retryable || attempt >= maxRetries) {
      throw new TypeSafeError(statusMessage(res.status, detail), { status: res.status, retryable });
    }
    await wait(retryDelayMs(attempt, res.headers.get("retry-after")));
  }
}

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

export async function classify(item, { apiBase, apiKey, model, ...opts }) {
  const body = await request(
    `${apiBase.replace(/\/+$/, "")}/v1/systemone`,
    { method: "POST", headers: authHeaders(apiKey), body: JSON.stringify(buildRequest(item, model)) },
    opts,
  );
  return parseAnswer(body);
}

// GET /v1/models → { models: [{ name, description, release_date }] }
export async function listModels({ apiBase, apiKey, ...opts }) {
  const body = await request(
    `${apiBase.replace(/\/+$/, "")}/v1/models`,
    { method: "GET", headers: authHeaders(apiKey) },
    { maxRetries: 1, ...opts },
  );
  return Array.isArray(body?.models) ? body.models : [];
}
