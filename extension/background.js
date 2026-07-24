const DEFAULT_PROXY_URL = "http://localhost:3000";
const REQUEST_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Toolbar icon / badge — reflects per-tab decode state (idle / scanning /
// found N / error) so it's visible without opening the popup. Icons are
// drawn at runtime via OffscreenCanvas rather than shipped as PNG assets —
// MV3 service workers can't use a regular <canvas>, but OffscreenCanvas is
// available and this keeps the extension free of binary asset files.
// ---------------------------------------------------------------------------

const ICON_SIZES = [16, 32, 48, 128];
const ICON_COLOR = {
  idle: "#16181d",
  scanning: "#9aa0a8",
  found: "#b4530a",
  error: "#a3241f",
};

const iconCache = new Map(); // hex color -> { [size]: ImageData }

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function buildIconImageData(hexColor) {
  const cached = iconCache.get(hexColor);
  if (cached) return cached;

  const images = {};
  for (const size of ICON_SIZES) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    const inset = Math.round(size * 0.14);
    const w = size - inset * 2;
    const radius = Math.max(2, Math.round(size * 0.22));

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = hexColor;
    roundedRectPath(ctx, inset, inset, w, w, radius);
    ctx.fill();

    images[size] = ctx.getImageData(0, 0, size, size);
  }

  iconCache.set(hexColor, images);
  return images;
}

/** Sets the icon/badge for one tab. Swallows errors — a closed or navigated-
 * away tab shouldn't surface as a console error for a non-critical UI touch. */
async function setTabState(tabId, state, badgeText = "") {
  try {
    await chrome.action.setIcon({ tabId, imageData: buildIconImageData(ICON_COLOR[state]) });
    await chrome.action.setBadgeText({ tabId, text: badgeText });
    if (badgeText) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: ICON_COLOR[state] });
    }
  } catch {
    // Tab may have closed or navigated before this resolved.
  }
}

function setGlobalDefaultIcon() {
  chrome.action.setIcon({ imageData: buildIconImageData(ICON_COLOR.idle) }).catch(() => {});
}

// Establish the branded idle icon as soon as the service worker starts, so
// the toolbar shows it instead of Chrome's generic puzzle-piece icon before
// any tab has triggered a decode.
setGlobalDefaultIcon();
chrome.runtime.onInstalled.addListener(setGlobalDefaultIcon);

// A fresh page load invalidates whatever icon/badge state was showing for
// the previous page in this tab — don't let a stale "Found 4" linger.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    setTabState(tabId, "idle", "");
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
      return setTabState(tabId, "scanning");
    case "found":
      return setTabState(tabId, "found", String(message.count ?? ""));
    case "error":
      return setTabState(tabId, "error", "!");
    default: // "empty" — scanned, nothing to flag
      return setTabState(tabId, "idle", "");
  }
}

async function decode(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { ok: true, results: [] };
  }

  const { proxyUrl } = await chrome.storage.local.get("proxyUrl");
  const base = (proxyUrl || DEFAULT_PROXY_URL).replace(/\/+$/, "");
  const endpoint = `${base}/decode`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
