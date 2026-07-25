const DEFAULT_PROXY_URL = "https://buzzword-decoder.onrender.com";
const REQUEST_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Toolbar icon — reflects per-tab decode state (idle / working / done) so
// it's visible without opening the popup. Uses the packaged PNG icon set
// (extension/icons/) rather than drawing anything at runtime.
// ---------------------------------------------------------------------------

const ICON_STATE_PATHS = {
  idle: { 16: "icons/icon16-idle.png", 32: "icons/icon32-idle.png", 48: "icons/icon48-idle.png", 128: "icons/icon128-idle.png" },
  working: { 16: "icons/icon16-working.png", 32: "icons/icon32-working.png", 48: "icons/icon48-working.png", 128: "icons/icon128-working.png" },
  done: { 16: "icons/icon16-done.png", 32: "icons/icon32-done.png", 48: "icons/icon48-done.png", 128: "icons/icon128-done.png" },
};

/** Sets the icon for one tab. Swallows errors — a closed or navigated-away
 * tab shouldn't surface as a console error for a non-critical UI touch. */
async function setTabIconState(tabId, state) {
  try {
    await chrome.action.setIcon({ tabId, path: ICON_STATE_PATHS[state] });
  } catch {
    // Tab may have closed or navigated before this resolved.
  }
}

// A fresh page load invalidates whatever icon state was showing for the
// previous page in this tab — don't let a stale "done" icon linger.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    setTabIconState(tabId, "idle");
  }
});

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "DECODE_STATUS") {
    const tabId = sender.tab?.id;
    if (tabId != null) applyDecodeStatus(tabId, message);
    return false; // fire-and-forget, no response expected
  }

  if (message?.type !== "DECODE_CHUNKS") return false;

  decode(message.chunks)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, message: String(err?.message ?? err) }));

  // Keep the message channel open for the async response.
  return true;
});

function applyDecodeStatus(tabId, message) {
  switch (message.status) {
    case "scanning":
      return setTabIconState(tabId, "working");
    case "found":
    case "empty": // scanned successfully either way — just nothing to flag
      return setTabIconState(tabId, "done");
    default: // "error" — nothing completed, back to idle
      return setTabIconState(tabId, "idle");
  }
}

async function decode(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { ok: true, results: [] };
  }

  const { proxyUrl, proxyToken } = await chrome.storage.local.get(["proxyUrl", "proxyToken"]);
  const base = (proxyUrl || DEFAULT_PROXY_URL).replace(/\/+$/, "");
  const endpoint = `${base}/decode`;

  const headers = { "Content-Type": "application/json" };
  if (proxyToken) headers.Authorization = `Bearer ${proxyToken}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ chunks }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return {
        ok: false,
        message: "The local server took too long to respond. Try a shorter page.",
      };
    }
    return {
      ok: false,
      message: `Can't reach the local server at ${base} — is it running?`,
    };
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      ok: false,
      message: payload?.message ?? `The server returned ${response.status}.`,
    };
  }

  if (!payload || !Array.isArray(payload.results)) {
    return { ok: false, message: "The server sent back an unexpected response." };
  }

  return { ok: true, results: payload.results };
}
