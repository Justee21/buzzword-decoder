const DEFAULT_PROXY_URL = "http://localhost:3000";

const decodeButton = document.getElementById("decode");
const proxyRow = document.getElementById("proxy-row");
const proxyDisplay = document.getElementById("proxy-display");
const changeButton = document.getElementById("change");
const proxyEdit = document.getElementById("proxy-edit");
const urlInput = document.getElementById("proxy-url");
const saveButton = document.getElementById("save");
const statusEl = document.getElementById("status");
const progressTrack = document.getElementById("progress-track");
const progressFill = document.getElementById("progress-fill");

let currentProxyUrl = DEFAULT_PROXY_URL;
let progressTimer = null;

init();

async function init() {
  const { proxyUrl } = await chrome.storage.local.get("proxyUrl");
  currentProxyUrl = proxyUrl || DEFAULT_PROXY_URL;
  proxyDisplay.textContent = displayUrl(currentProxyUrl);

  decodeButton.addEventListener("click", onDecode);
  changeButton.addEventListener("click", openEdit);
  saveButton.addEventListener("click", onSave);
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSave();
    if (e.key === "Escape") closeEdit();
  });
}

/** Drops the http:// prefix for display; keeps https:// visible as a signal. */
function displayUrl(url) {
  return url.replace(/^http:\/\//, "");
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

async function onDecode() {
  setDecoding();
  startProgress();

  try {
    const tab = await getActiveTab();

    if (!tab || !/^https?:/.test(tab.url ?? "")) {
      finishProgress();
      setIdle("error", "Open a normal web page first — this can't run on browser or extension pages.");
      return;
    }

    // activeTab lets us inject on demand, so no broad content_scripts match is
    // needed. content.js guards against being injected twice.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    const response = await chrome.tabs.sendMessage(tab.id, { type: "DECODE_PAGE" });

    finishProgress();

    if (!response) {
      setIdle("error", "No response from the page. Try reloading it.");
      return;
    }

    if (!response.ok) {
      setIdle("error", response.message ?? "Something went wrong.");
      return;
    }

    const { count, blocksScanned } = response;

    if (count === 0) {
      setIdle(
        "ok",
        blocksScanned === 0
          ? "There's not much readable text on this page."
          : "No buzzwords found — this page is refreshingly clear.",
      );
      return;
    }

    setIdle("ok", `Found ${count} ${count === 1 ? "buzzword" : "buzzwords"} — panel opened.`);
  } catch (err) {
    finishProgress();
    setIdle("error", friendlyError(err));
  }
}

function friendlyError(err) {
  const message = String(err?.message ?? err);

  if (message.includes("Receiving end does not exist")) {
    return "Couldn't reach the page. Reload the tab and try again.";
  }
  if (message.includes("Cannot access") || message.includes("chrome://")) {
    return "Chrome blocks extensions on this page. Try a normal website.";
  }
  return message;
}

// ---------------------------------------------------------------------------
// Button / status state
// ---------------------------------------------------------------------------

function setDecoding() {
  decodeButton.disabled = true;
  decodeButton.textContent = "Decoding...";
  statusEl.className = "status";
  statusEl.textContent = "Reading page, translating jargon...";
}

/** Returns the button to its ready state. `kind` is "ok" or "error"; the
 * status message persists until the next decode, matching the design. */
function setIdle(kind, message) {
  decodeButton.disabled = false;
  decodeButton.textContent = "Decode This Page";
  statusEl.className = `status ${kind}`;
  statusEl.textContent = message;
}

// ---------------------------------------------------------------------------
// Progress bar — eases toward ~88% while waiting (duration is unknown ahead
// of time), then snaps to 100% on completion for a clean finish.
// ---------------------------------------------------------------------------

function startProgress() {
  progressTrack.hidden = false;
  progressFill.style.transition = "none";
  progressFill.style.width = "0%";
  void progressFill.offsetWidth; // flush before re-enabling the transition
  progressFill.style.transition = "";

  const start = performance.now();
  const ceiling = 88;
  const timeConstant = 3000;

  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    const elapsed = performance.now() - start;
    const pct = ceiling * (1 - Math.exp(-elapsed / timeConstant));
    progressFill.style.width = `${pct.toFixed(1)}%`;
  }, 100);
}

function finishProgress() {
  clearInterval(progressTimer);
  progressTimer = null;
  progressFill.style.width = "100%";
  setTimeout(() => {
    progressTrack.hidden = true;
    progressFill.style.width = "0%";
  }, 280);
}

// ---------------------------------------------------------------------------
// Proxy URL — "change" swaps the display row for an editable one
// ---------------------------------------------------------------------------

function openEdit() {
  urlInput.value = currentProxyUrl;
  proxyRow.hidden = true;
  proxyEdit.hidden = false;
  urlInput.focus();
  urlInput.select();
}

function closeEdit() {
  proxyEdit.hidden = true;
  proxyRow.hidden = false;
}

async function onSave() {
  const raw = urlInput.value.trim() || DEFAULT_PROXY_URL;
  let parsed;

  try {
    parsed = new URL(raw);
  } catch {
    setIdle("error", "That isn't a valid URL.");
    return;
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    setIdle("error", "The proxy URL must start with http:// or https://.");
    return;
  }

  // Store without a trailing slash so `${proxyUrl}/decode` is always clean.
  const proxyUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "");

  // The manifest only grants localhost:3000 up front. Anything else needs the
  // user to approve host access — this click is the required user gesture.
  const granted = await ensureHostPermission(proxyUrl);
  if (!granted) {
    setIdle("error", "Host access denied, so the extension can't reach that server.");
    return;
  }

  await chrome.storage.local.set({ proxyUrl });
  currentProxyUrl = proxyUrl;
  proxyDisplay.textContent = displayUrl(proxyUrl);
  closeEdit();
  setIdle("ok", "Proxy URL saved.");
}

async function ensureHostPermission(proxyUrl) {
  const origins = [`${new URL(proxyUrl).origin}/*`];

  if (await chrome.permissions.contains({ origins })) return true;

  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
