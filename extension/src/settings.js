// Shared defaults. Loaded as a classic script by the content script, popup and
// options page, and imported for its side effect by the background module.
globalThis.AIDF_DEFAULTS = Object.freeze({
  enabled: true,
  apiKey: "",
  apiBase: "https://api.typesafe.ai",
  model: "jev-1.14.0",
  // Probability (0–1) at or above which a post is treated as AI-written.
  // Live tests on Jev 1.14: casual human posts and replies scored ≤ 0.15,
  // polished human ones (announcements, news) up to 0.53, AI ones mostly ≥ 0.6.
  threshold: 0.6,
  // "collapse" hides the post behind a bar; "label" only adds the bar.
  action: "collapse",
  scanPosts: true,
  scanReplies: true,
  // Posts shorter than this (after trimming) are skipped: too little signal.
  minLength: 15,
  // Lower-case handles without "@" that are never checked.
  whitelist: [],
  // Diagnostics: show the score (or why it is missing) above every post.
  showScores: false,
});

globalThis.aidfLoadSettings = async function aidfLoadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(globalThis.AIDF_DEFAULTS));
  return { ...globalThis.AIDF_DEFAULTS, ...stored };
};
