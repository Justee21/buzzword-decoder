const DEFAULT_PROXY_URL = "http://localhost:3000";
const REQUEST_TIMEOUT_MS = 90_000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "DECODE_CHUNKS") return false;

  decode(message.chunks)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, message: String(err?.message ?? err) }));

  // Keep the message channel open for the async response.
  return true;
});

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
