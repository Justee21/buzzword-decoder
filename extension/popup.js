const DEFAULT_PROXY_URL = "http://localhost:3000";

const decodeButton = document.getElementById("decode");
const saveButton = document.getElementById("save");
const urlInput = document.getElementById("proxy-url");
const statusEl = document.getElementById("status");

init();

async function init() {
  const { proxyUrl } = await chrome.storage.local.get("proxyUrl");
  urlInput.value = proxyUrl || DEFAULT_PROXY_URL;

  decodeButton.addEventListener("click", onDecode);
  saveButton.addEventListener("click", onSave);
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onSave();
  });
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

async function onDecode() {
  setStatus("loading", "Reading the page…");
  decodeButton.disabled = true;

  try {
    const tab = await getActiveTab();

    if (!tab || !/^https?:/.test(tab.url ?? "")) {
      setStatus("error", "Open a normal web page first — this can't run on browser or extension pages.");
      return;
    }

    // activeTab lets us inject on demand, so no broad content_scripts match is
    // needed. content.js guards against being injected twice.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    setStatus("loading", "Decoding…");

    const response = await chrome.tabs.sendMessage(tab.id, { type: "DECODE_PAGE" });

    if (!response) {
      setStatus("error", "No response from the page. Try reloading it.");
      return;
    }

    if (!response.ok) {
      setStatus("error", response.message ?? "Something went wrong.");
      return;
    }

    const { count, blocksScanned } = response;

    if (count === 0) {
      setStatus(
        "done",
        blocksScanned === 0
          ? "No readable text found on this page."
          : "No corporate jargon found. This page is refreshingly clear.",
      );
      return;
    }

    setStatus("done", `Found ${count} ${count === 1 ? "phrase" : "phrases"}. See the panel on the right.`);
  } catch (err) {
    setStatus("error", friendlyError(err));
  } finally {
    decodeButton.disabled = false;
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
// Settings
// ---------------------------------------------------------------------------

async function onSave() {
  const raw = urlInput.value.trim() || DEFAULT_PROXY_URL;
  let parsed;

  try {
    parsed = new URL(raw);
  } catch {
    setStatus("error", "That isn't a valid URL.");
    return;
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    setStatus("error", "The proxy URL must start with http:// or https://.");
    return;
  }

  // Store without a trailing slash so `${proxyUrl}/decode` is always clean.
  const proxyUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "");

  // The manifest only grants localhost:3000 up front. Anything else needs the
  // user to approve host access — this click is the required user gesture.
  const granted = await ensureHostPermission(proxyUrl);
  if (!granted) {
    setStatus("error", "Host access denied, so the extension can't reach that server.");
    return;
  }

  await chrome.storage.local.set({ proxyUrl });
  urlInput.value = proxyUrl;
  setStatus("done", "Proxy URL saved.");
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

function setStatus(kind, message) {
  statusEl.className = `status visible ${kind}`;
  statusEl.textContent = "";

  if (kind === "loading") {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    statusEl.appendChild(spinner);
  }

  statusEl.appendChild(document.createTextNode(message));
}
