// Scores hand-written sample posts against the live Jev API, to check the
// questions in extension/src/typesafe.js and pick a threshold.
// Usage: TYPESAFE_API_KEY=... npm run eval:live [-- 0.6]
import { buildRequest, parseAnswer } from "../extension/src/typesafe.js";

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) throw new Error("Set TYPESAFE_API_KEY");
const MODEL = process.env.MODEL ?? "jev-1.14.0";
const THRESHOLD = Number(process.argv[2] ?? 0.6);

const FOCAL = {
  author: "@openbee_dev",
  text:
    "build openbee in public.\n\n跟 Bee 说一句 \"周五发 v0.1\"，它会把活拆开，分给不同的 AI 员工：前端做落地页，文案写发布说明，测试跑完整 e2e 回归。每个员工可以跑 Claude Code、Codex 或 pi，做完把结果发回对话里。\n\n这是现在的主界面 👇",
};

// Used while writing the questions: [label, expected, kind, author, text].
const CASES = [
  ["USER-EXAMPLE", "ai", "reply", "@taiyanghere", "一句话把活拆给不同分工，这套协作方式看着就很顺，关键还是最后能把结果收回来。"],
  ["ai-praise-emoji", "ai", "reply", "@a1", "这个思路太棒了！把复杂任务拆解给不同 AI 角色，真正实现了高效协作，期待 v0.1 的发布！🚀"],
  ["ai-trend", "ai", "reply", "@a2", "多智能体协作是未来的趋势，openbee 的设计非常清晰，任务分发和结果回收形成闭环，值得关注。"],
  ["ai-en", "ai", "reply", "@a3", "Love this! Breaking work down across specialized AI agents is the future of productivity. Can't wait to see v0.1 🚀"],
  ["ai-echo-short", "ai", "reply", "@a4", "让 AI 员工各司其职，再把成果汇总回来，这种模式确实很高效。"],
  ["ai-generic-2", "ai", "reply", "@c1", "从一句话指令到多角色并行执行，再到结果统一回收，这种工作流设计非常优雅，真正释放了团队的生产力。"],
  ["ai-en-2", "ai", "reply", "@c2", "This is exactly where AI is heading — orchestrating specialized agents and bringing the results back together. Huge potential here!"],
  ["human-question", "human", "reply", "@h1", "pi 是哪个？第一次听说，有链接吗"],
  ["human-experience", "human", "reply", "@h2", "我们组试过类似的，最大的问题是几个 agent 改同一个文件会冲突，你们怎么处理的？"],
  ["human-detail-q", "human", "reply", "@h3", "前端那个落地页是 Figma 直接出的还是 AI 自己设计的"],
  ["human-joke", "human", "reply", "@h4", "哈哈 周五发版 周六修 bug 经典"],
  ["human-ui", "human", "reply", "@h5", "界面有点像 Slack，左边那栏能折叠吗，屏幕小的时候挺占地方"],
  ["human-agree-exp", "human", "reply", "@b1", "同意，我们之前也是这么拆的，最难的确实是最后合并结果，经常要人工对一遍"],
  ["human-short-praise", "human", "reply", "@b2", "牛逼，这个必须试试，周末就装上玩玩"],
  ["human-beta", "human", "reply", "@b3", "太酷了 想要内测资格 可以私信吗"],
  ["human-follow", "human", "reply", "@b4", "看着不错，已关注，等开源了第一时间来试"],
  ["human-en-q", "human", "reply", "@b5", "this is sick, how do you handle merge conflicts when two agents touch the same file?"],
  ["human-skeptic", "human", "reply", "@b6", "拆任务谁都会，问题是 AI 写的落地页能直接上线吗，我是不太信"],
  ["post-ai", "ai", "post", "@p1", "在这个快速变化的时代，AI 不是取代你，而是放大你。掌握这三个思维模型，你会比 90% 的人更早看到未来：\n1️⃣ 杠杆思维\n2️⃣ 复利思维\n3️⃣ 系统思维\n转发收藏，慢慢看。"],
  ["post-human", "human", "post", "@p2", "今天地铁又停了二十分钟，迟到被老板逮个正着，烦死"],
];

// Written after the first revision; seen while making the second one.
// [expected, parent, text].
const P2 = { author: "@devlin", text: "Finally migrated our monolith to Postgres 17. Took 3 months, 2 rollbacks and one very long night. Write-up coming soon." };
const P3 = { author: "@lily", text: "今天第一次自己做红烧肉，糖色炒糊了，一家人还是吃光了 😂" };
const HOLDOUT = [
  ["ai", P2, "Congratulations on the successful migration! Moving to Postgres 17 is a big step — looking forward to the write-up and the lessons learned along the way."],
  ["ai", P2, "3 months, 2 rollbacks and one long night — that's what real engineering resilience looks like. Great work!"],
  ["ai", P2, "从单体迁移到 Postgres 17，经历回滚依然坚持到底，这份工程韧性值得学习，期待复盘文章！"],
  ["human", P2, "2 rollbacks only? we did 6 lol. what bit you the hardest, extensions?"],
  ["human", P2, "congrats!! did you use pg_upgrade or logical replication?"],
  ["human", P2, "the 'one very long night' part hurts to read"],
  ["human", P2, "恭喜！我们还卡在 12，DBA 死活不让升"],
  ["ai", P3, "第一次做红烧肉就能让家人吃光，说明用心才是最好的调味料！糖色的掌握需要经验，下次一定会更完美。"],
  ["human", P3, "糖色炒糊太真实了，我第一次直接整锅倒掉"],
  ["human", P3, "下次用冰糖小火，别离开灶台就行"],
  ["human", P3, "能吃光就是成功哈哈哈，求个照片"],
  ["ai", null, "Most people think productivity is about doing more. It's not.\n\nIt's about doing less, better.\n\nHere are 5 habits that changed my life 🧵👇"],
  ["human", null, "why does my cat only want to sit on the keyboard when I'm in a meeting"],
];

// A second reply-bot pattern, from another real reply the user reported: a
// one-line summary of what the post shows (here, its screenshot) plus the
// post's own punchline echoed back. Used while revising the questions, with
// human replies that look alike: [expected, parent, text].
const P4 = { author: "@libukai", text: "完蛋了，DeekSeek Harness 太好玩了，要停不下来了！！！" };
const SUMMARY_ECHO = [
  ["ai", P4, "大厂那套 AI 落地流程直接塞进电脑里，这下是真停不下来了"],
  ["ai", P4, "把专业级的 AI 工作流做成桌面应用，这下效率是真的起飞了"],
  ["ai", P4, "从对话到图表一步到位，DeepSeek 这次是真把生产力玩明白了"],
  ["ai", P4, "AI 助手终于从聊天框走进了真实工作流，难怪停不下来"],
  ["ai", P4, "终端、插件、自动化任务全都打通，这才是 AI 工具该有的样子"],
  ["human", P4, "哈哈哈 我也停不下来，昨晚玩到三点，第二天上班直接睡着"],
  ["human", P4, "真停不下来，刚让它帮我把这周的周报写了，老板还夸了"],
  ["human", P4, "Harness 是开源的吗？想在自己电脑上跑"],
  ["human", P4, "DeekSeek 打错了哈哈哈，不过确实好玩"],
  ["human", P4, "这个和 Claude Code 比怎么样，跑长任务稳不稳"],
  ["human", P4, "看着跟 Cursor 差不多啊，有啥区别"],
  ["human", P4, "停不下来+1，就是 token 烧得有点心疼"],
];

// Written after the summary + echo revision; seen while narrowing it to spare
// casual congratulations.
const P5 = { author: "@maya", text: "We just hit $1M ARR. 18 months, 4 people, zero VC money. Still can't believe it." };
const P6 = { author: "@aqing", text: "用了三年的 MacBook 键盘终于坏了，修一次 2800，不如换新的吧……" };
const HOLDOUT2 = [
  ["ai", P5, "Incredible milestone! Bootstrapping to $1M ARR with a team of 4 shows what focus and grit can achieve. Onward and upward! 🚀"],
  ["ai", P5, "18 months, 4 people, zero VC — this is the blueprint every founder should study."],
  ["human", P5, "Congrats Maya!! Remember when you were demoing it at that tiny meetup in Lisbon, wild"],
  ["human", P5, "huge congrats, well deserved 🎉"],
  ["human", P5, "what's your churn like? curious how you got there without paid ads"],
  ["human", P5, "zero VC and still sane, respect. how many hours a week were you doing?"],
  ["ai", P6, "三年的陪伴终于到了说再见的时候，及时换新也是对效率的投资，期待新机带来更好的体验！"],
  ["ai", P6, "维修成本接近换新，这时候果断升级确实是更明智的选择。"],
  ["human", P6, "别急着换，外接个键盘还能再战两年，我就这么用的"],
  ["human", P6, "2800 也太黑了，去华强北 600 搞定"],
  ["human", P6, "蝴蝶键盘那代吧？那代是真的坑"],
  ["human", P6, "换吧换吧，M4 Air 真香，我上个月刚换"],
  ["ai", null, "Stop chasing motivation. Build systems.\n\nMotivation fades. Systems compound.\n\nHere's the 5-step system I use every single day:"],
  ["human", null, "accidentally replied-all to the whole company with my lunch order. it's been 3 hours. nobody has said anything. I'm dying"],
  ["ai", null, "真正拉开人与人差距的，从来不是智商，而是认知。认知决定选择，选择决定命运。"],
  ["human", null, "楼下新开的面馆，牛肉面 18 块，牛肉给得巨多，老板是兰州人，已经连吃三天"],
];

// Written last and never tuned against.
const P8 = { author: "@sam", text: "Ran my first marathon today. 4:52. Cried at mile 20, cried at the finish. Never again (until next year)." };
const P9 = { author: "@xiaozhou", text: "今天提了离职，组长沉默了半分钟，说了句'我也想走'。" };
const HOLDOUT3 = [
  ["ai", P8, "Finishing your first marathon in 4:52 is a huge achievement — the emotions at mile 20 and the finish line show how much heart you put into it. Proud of you!"],
  ["ai", P8, "From tears at mile 20 to crossing the finish line — that's what perseverance looks like. Congratulations on this incredible milestone!"],
  ["human", P8, "congrats!! mile 20 is where everyone cries, it's basically tradition"],
  ["human", P8, "so proud of you, see you at the start line next year 😤"],
  ["human", P8, "4:52 on your first is solid, what did your training block look like?"],
  ["human", P8, "well done mate 👏 absolute legend"],
  ["ai", P9, "组长的半分钟沉默胜过千言万语，这句'我也想走'道出了无数打工人的心声。"],
  ["ai", P9, "离职是对自己负责的选择，祝你在新的旅程中一切顺利，前程似锦！"],
  ["human", P9, "哈哈哈哈组长：带我一个，下周一起递"],
  ["human", P9, "下家是哪？方便说的话私信我，我们组也在考虑"],
  ["human", P9, "恭喜恭喜，终于跑路了，请吃饭"],
  ["human", P9, "组长这句太真实了，我们组长上个月也这么说，然后他先走了"],
  ["ai", null, "2026 年最值得投资的不是股票，也不是房子，而是你自己。以下 7 个习惯，帮你在一年内脱胎换骨："],
  ["human", null, "隔壁装修第 47 天，今天电钻从早上 8 点开始，我已经会背他们的节奏了"],
];

async function score(item) {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildRequest(item, MODEL)),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return parseAnswer(body);
}

function report(name, rows) {
  console.log(`\n${name}`);
  console.table(rows);
  const wrong = rows.filter((r) => (r.final >= THRESHOLD) !== (r.expected === "ai"));
  const max = (kind) => Math.max(...rows.filter((r) => r.expected === kind).map((r) => r.final));
  const min = (kind) => Math.min(...rows.filter((r) => r.expected === kind).map((r) => r.final));
  console.log(`threshold ${THRESHOLD}: ${rows.length - wrong.length}/${rows.length} correct;`,
    `human max ${max("human")}, ai min ${min("ai")}`, wrong.length ? wrong.map((r) => r.text) : "");
}

const row = (expected, text, r) => ({
  expected,
  text: text.slice(0, 24),
  style: r.signals.ai_generated,
  echo: r.signals.templated_reply ?? null,
  final: r.probability,
});

report("dev set", await Promise.all(CASES.map(async ([, expected, kind, author, text]) =>
  row(expected, text, await score({ kind, author, text, parent: kind === "reply" ? FOCAL : undefined })))));
report("summary + echo set", await Promise.all(SUMMARY_ECHO.map(async ([expected, parent, text]) =>
  row(expected, text, await score({ kind: "reply", author: "@x", text, parent }))),
));
report("holdout set", await Promise.all(HOLDOUT.map(async ([expected, parent, text]) =>
  row(expected, text, await score({ kind: parent ? "reply" : "post", author: "@x", text, parent: parent ?? undefined })))));
report("holdout set 2", await Promise.all(HOLDOUT2.map(async ([expected, parent, text]) =>
  row(expected, text, await score({ kind: parent ? "reply" : "post", author: "@x", text, parent: parent ?? undefined }))),
));
report("holdout set 3", await Promise.all(HOLDOUT3.map(async ([expected, parent, text]) =>
  row(expected, text, await score({ kind: parent ? "reply" : "post", author: "@x", text, parent: parent ?? undefined }))),
));
