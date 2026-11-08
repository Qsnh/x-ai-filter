import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIGNALS,
  buildRequest,
  parseAnswer,
  describeErrorBody,
  retryDelayMs,
  classify,
  listModels,
  TypeSafeError,
} from "../extension/src/typesafe.js";

const reply = {
  key: "id:2",
  kind: "reply",
  author: "@bot",
  text: "Great point! This is a game-changer.",
  parent: { author: "@alice", text: "We shipped v2 today." },
};

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("replies are asked both questions, with the parent post as context", () => {
  const req = buildRequest(reply, "jev-1.14.0");
  assert.equal(req.model, "jev-1.14.0");
  assert.deepEqual(req.state.post, { kind: "reply", author: "@bot", text: reply.text });
  assert.deepEqual(req.state.replying_to, reply.parent);
  assert.deepEqual(Object.keys(req.questions), SIGNALS);
  for (const q of Object.values(req.questions)) {
    assert.equal(q.type, "noul");
    assert.match(q.instructions, /post\.text/);
    assert.ok(q.criteria.true && q.criteria.false);
  }
  assert.match(req.questions.templated_reply.instructions, /`replying_to`/);
});

test("posts, and replies without a known parent, only get the style question", () => {
  const post = buildRequest({ kind: "post", author: "@a", text: "hi there", quoted: "q" }, "m");
  assert.equal(post.state.replying_to, undefined);
  assert.equal(post.state.post.quoted_post, "q");
  assert.deepEqual(Object.keys(post.questions), ["ai_generated"]);

  const orphan = buildRequest({ ...reply, parent: undefined }, "m");
  assert.equal(orphan.state.replying_to, undefined);
  assert.deepEqual(Object.keys(orphan.questions), ["ai_generated"]);
});

test("parseAnswer takes the highest signal and clamps it", () => {
  const body = {
    model: "jev-1.14.0",
    answers: { ai_generated: { type: "noul", noul: 0.31 }, templated_reply: { type: "noul", noul: 0.95 } },
    usage: { input_tokens: 120 },
  };
  assert.deepEqual(parseAnswer(body), {
    probability: 0.95,
    signals: { ai_generated: 0.31, templated_reply: 0.95 },
    model: "jev-1.14.0",
    usage: { input_tokens: 120 },
  });
  assert.equal(parseAnswer({ answers: { ai_generated: { noul: 1.2 } } }).probability, 1);
  assert.deepEqual(parseAnswer({ answers: { ai_generated: { noul: 0.4 } } }).signals, { ai_generated: 0.4 });
  assert.throws(() => parseAnswer({ answers: {} }), TypeSafeError);
});

test("describeErrorBody handles string, object and 422 list details", () => {
  assert.equal(describeErrorBody({ detail: "bad model" }), "bad model");
  assert.equal(
    describeErrorBody({ detail: [{ loc: ["body", "state"], msg: "Field required", type: "missing" }] }),
    "body.state: Field required",
  );
  assert.equal(
    describeErrorBody({ detail: { error_type: "authentication_error", message: "Cannot authenticate with the server." } }),
    "Cannot authenticate with the server.",
  );
  assert.equal(describeErrorBody({ detail: { code: "max_tokens_exceeded" } }), '{"code":"max_tokens_exceeded"}');
  assert.equal(describeErrorBody(null), "");
});

test("retryDelayMs honours retry-after, else backs off exponentially", () => {
  assert.equal(retryDelayMs(0, "2"), 2000);
  assert.equal(retryDelayMs(0, "0"), 0);
  assert.equal(retryDelayMs(0, null, () => 0), 500);
  assert.equal(retryDelayMs(2, null, () => 0), 2000);
  assert.equal(retryDelayMs(2, null, () => 1), 4000);
  assert.equal(retryDelayMs(10, null, () => 1), 15000);
});

test("classify posts to /v1/systemone with a bearer key", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, { model: "jev-1.14.0", answers: { ai_generated: { type: "noul", noul: 0.91 } }, usage: { input_tokens: 99, output_tokens: 1 } });
  };
  const r = await classify(reply, { apiBase: "https://api.typesafe.ai/", apiKey: "k", model: "jev-1.14.0", fetchImpl });
  assert.equal(r.probability, 0.91);
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer k");
  assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body).questions), SIGNALS);
});

test("classify retries 429 and 529, then succeeds", async () => {
  const statuses = [429, 529, 200];
  const waits = [];
  const fetchImpl = async () => {
    const status = statuses.shift();
    if (status !== 200) return jsonResponse(status, { detail: "slow down" }, { "retry-after": "1" });
    return jsonResponse(200, { answers: { ai_generated: { noul: 0.2 } } });
  };
  const r = await classify(reply, { apiBase: "x", apiKey: "k", model: "m", fetchImpl, wait: async (ms) => waits.push(ms) });
  assert.equal(r.probability, 0.2);
  assert.deepEqual(waits, [1000, 1000]);
});

test("classify does not retry 401 and reports a readable error", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    return jsonResponse(401, { detail: "Invalid API key" });
  };
  await assert.rejects(
    classify(reply, { apiBase: "x", apiKey: "bad", model: "m", fetchImpl, wait: async () => {} }),
    (err) => err instanceof TypeSafeError && err.status === 401 && !err.retryable && /Invalid API key/.test(err.message),
  );
  assert.equal(n, 1);
});

test("classify gives up after maxRetries on persistent 529", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    return jsonResponse(529, {});
  };
  await assert.rejects(
    classify(reply, { apiBase: "x", apiKey: "k", model: "m", fetchImpl, wait: async () => {}, maxRetries: 2 }),
    (err) => err.status === 529 && err.retryable,
  );
  assert.equal(n, 3);
});

test("listModels reads the models array", async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/models");
    assert.equal(init.method, "GET");
    return jsonResponse(200, { models: [{ name: "jev-latest", description: "General-purpose system one model.", release_date: "2026-09-15" }] });
  };
  const models = await listModels({ apiBase: "https://api.typesafe.ai", apiKey: "k", fetchImpl });
  assert.deepEqual(models.map((m) => m.name), ["jev-latest"]);
});
