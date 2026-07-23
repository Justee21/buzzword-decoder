// Injected on demand by the popup (activeTab + scripting). Chrome re-runs this
// file on every click, so everything is guarded against double initialisation.
(() => {
  if (window.__buzzwordDecoderReady) return;
  window.__buzzwordDecoderReady = true;

  const PANEL_ID = "buzzword-decoder-panel";
  const MAX_CHUNK_CHARS = 4500;
  const MAX_CHUNKS = 12;
  const MIN_BLOCK_CHARS = 25;

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS",
    "IFRAME", "OBJECT", "AUDIO", "VIDEO", "CODE", "PRE", "KBD", "SAMP",
    "TEXTAREA", "INPUT", "SELECT", "OPTION",
  ]);

  // Elements that end a "block" of text — anything else is treated as inline
  // and folded into its nearest block ancestor, so sentences stay intact.
  const BLOCK_TAGS = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "MAIN", "ASIDE", "HEADER", "FOOTER",
    "NAV", "LI", "TD", "TH", "BLOCKQUOTE", "FIGCAPTION", "DD", "DT",
    "H1", "H2", "H3", "H4", "H5", "H6", "SUMMARY", "DETAILS", "BODY",
  ]);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "DECODE_PAGE") return false;

    runDecode()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: String(err?.message ?? err) }));

    return true; // async response
  });

  // -------------------------------------------------------------------------
  // Orchestration
  // -------------------------------------------------------------------------

  async function runDecode() {
    const blocks = extractBlocks();

    if (blocks.length === 0) {
      renderEmpty("There's not much readable text on this page.");
      return { ok: true, count: 0, blocksScanned: 0 };
    }

    const chunks = buildChunks(blocks);
    renderLoading(chunks.length);

    const response = await chrome.runtime.sendMessage({
      type: "DECODE_CHUNKS",
      chunks,
    });

    if (!response?.ok) {
      const message = response?.message ?? "The decode request failed.";
      renderError(message);
      return { ok: false, message };
    }

    const pairs = flattenResults(response.results);

    if (pairs.length === 0) {
      renderEmpty("No corporate jargon found. This page is refreshingly clear.");
    } else {
      renderResults(pairs);
    }

    return { ok: true, count: pairs.length, blocksScanned: blocks.length };
  }

  function flattenResults(results) {
    const seen = new Set();
    const pairs = [];

    for (const group of results ?? []) {
      for (const item of group ?? []) {
        const original = typeof item?.original === "string" ? item.original.trim() : "";
        const plain = typeof item?.plain === "string" ? item.plain.trim() : "";
        if (!original || !plain) continue;

        const key = original.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        pairs.push({ original, plain });
      }
    }

    return pairs;
  }

  // -------------------------------------------------------------------------
  // Text extraction
  // -------------------------------------------------------------------------

  /** Returns the page's visible text, grouped by block-level element. */
  function extractBlocks() {
    const walker = document.createTreeWalker(
      document.body ?? document.documentElement,
      NodeFilter.SHOW_TEXT,
      { acceptNode },
    );

    // Map keyed by the block element preserves document order.
    const byBlock = new Map();

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const block = nearestBlock(node.parentElement);
      if (!block) continue;

      const existing = byBlock.get(block);
      byBlock.set(block, existing ? `${existing} ${node.nodeValue}` : node.nodeValue);
    }

    const blocks = [];
    for (const text of byBlock.values()) {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (normalized.length >= MIN_BLOCK_CHARS) blocks.push(normalized);
    }

    return blocks;
  }

  function acceptNode(node) {
    if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;

    const parent = node.parentElement;
    if (!parent) return NodeFilter.FILTER_REJECT;
    if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
    if (parent.closest(`#${PANEL_ID}`)) return NodeFilter.FILTER_REJECT;
    if (parent.closest('[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
    if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;

    return NodeFilter.FILTER_ACCEPT;
  }

  function isVisible(el) {
    // checkVisibility covers display:none on any ancestor, but the visibility
    // and content-visibility checks are opt-in — without these flags,
    // visibility:hidden text gets scraped.
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({
        visibilityProperty: true,
        contentVisibilityAuto: true,
      });
    }

    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return el.offsetParent !== null || style.position === "fixed";
  }

  function nearestBlock(el) {
    for (let current = el; current; current = current.parentElement) {
      if (BLOCK_TAGS.has(current.tagName)) return current;
    }
    return document.body ?? null;
  }

  /** Packs blocks into request-sized chunks, keeping whole blocks together. */
  function buildChunks(blocks) {
    const chunks = [];
    let current = "";

    for (const block of blocks) {
      // A single oversized block gets truncated rather than split mid-sentence.
      const piece = block.length > MAX_CHUNK_CHARS ? block.slice(0, MAX_CHUNK_CHARS) : block;

      if (current && current.length + piece.length + 2 > MAX_CHUNK_CHARS) {
        chunks.push(current);
        if (chunks.length >= MAX_CHUNKS) return chunks;
        current = piece;
      } else {
        current = current ? `${current}\n\n${piece}` : piece;
      }
    }

    if (current) chunks.push(current);
    return chunks.slice(0, MAX_CHUNKS);
  }

  // -------------------------------------------------------------------------
  // Panel
  // -------------------------------------------------------------------------

  let shadow = null;

  function getPanel() {
    if (shadow && shadow.host.isConnected) return shadow;

    const host = document.createElement("div");
    host.id = PANEL_ID;
    document.documentElement.appendChild(host);

    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        * { box-sizing: border-box; }

        .panel {
          position: fixed;
          top: 0;
          right: 0;
          z-index: 2147483647;
          display: flex;
          flex-direction: column;
          width: min(420px, 92vw);
          height: 100vh;
          background: #ffffff;
          color: #16181d;
          font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          box-shadow: -8px 0 32px rgba(15, 18, 25, 0.18);
          transform: translateX(100%);
          transition: transform 260ms cubic-bezier(0.22, 0.61, 0.36, 1);
        }

        .panel.open { transform: translateX(0); }

        header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 16px 18px;
          border-bottom: 1px solid #e6e8ec;
        }

        .title { font-size: 14px; font-weight: 650; letter-spacing: -0.01em; }
        .count { flex: 1; color: #6b7280; font-size: 12.5px; }

        .close {
          padding: 4px 8px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: #6b7280;
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
        }
        .close:hover { background: #f1f3f6; color: #16181d; }

        .body {
          flex: 1;
          overflow-y: auto;
          padding: 14px 18px 28px;
        }

        .card {
          margin-bottom: 12px;
          padding: 13px 14px;
          border: 1px solid #e6e8ec;
          border-radius: 10px;
          cursor: pointer;
          transition: border-color 120ms ease, background 120ms ease;
        }
        .card:hover { border-color: #d9b48a; background: #fdfaf6; }

        .original {
          margin: 0 0 9px;
          padding-left: 10px;
          border-left: 3px solid #e0c39c;
          color: #5b6169;
          font-size: 13px;
          font-style: italic;
        }

        .plain {
          margin: 0;
          font-size: 13.5px;
          font-weight: 500;
          color: #16181d;
        }

        .note {
          margin: 0;
          padding: 24px 4px;
          color: #6b7280;
          font-size: 13px;
          text-align: center;
        }

        .note.error { color: #a3241f; }

        .spinner {
          display: block;
          width: 18px;
          height: 18px;
          margin: 0 auto 12px;
          border: 2px solid #d8dbe0;
          border-top-color: #b4530a;
          border-radius: 50%;
          animation: spin 0.75s linear infinite;
        }

        @keyframes spin { to { transform: rotate(360deg); } }

        @media (prefers-color-scheme: dark) {
          .panel { background: #17191d; color: #eceef1; }
          header { border-bottom-color: #2c2f36; }
          .count, .close, .note { color: #9aa1ad; }
          .close:hover { background: #23262c; color: #eceef1; }
          .card { border-color: #2c2f36; }
          .card:hover { border-color: #6d4a29; background: #1e2025; }
          .original { color: #a8afba; border-left-color: #7a5a32; }
          .plain { color: #eceef1; }
          .note.error { color: #ef8d86; }
        }
      </style>

      <div class="panel" part="panel">
        <header>
          <span class="title">Buzzword Decoder</span>
          <span class="count"></span>
          <button class="close" type="button" aria-label="Close">&times;</button>
        </header>
        <div class="body"></div>
      </div>
    `;

    shadow.querySelector(".close").addEventListener("click", closePanel);

    // Force a style flush so the off-screen transform is the computed starting
    // point, then slide in. Doing this synchronously (rather than in
    // requestAnimationFrame) means the panel still appears if frames are being
    // throttled — otherwise it would sit parked off-screen.
    const panel = shadow.querySelector(".panel");
    void panel.offsetWidth;
    panel.classList.add("open");

    return shadow;
  }

  function closePanel() {
    if (!shadow) return;
    const panel = shadow.querySelector(".panel");
    panel.classList.remove("open");
    const host = shadow.host;
    setTimeout(() => host.remove(), 280);
    shadow = null;
  }

  function setBody(countText, build) {
    const root = getPanel();
    root.querySelector(".count").textContent = countText;

    const body = root.querySelector(".body");
    body.textContent = "";
    build(body);
  }

  function renderLoading(chunkCount) {
    setBody("", (body) => {
      const spinner = document.createElement("div");
      spinner.className = "spinner";

      const note = document.createElement("p");
      note.className = "note";
      note.textContent = `Reading ${chunkCount} ${chunkCount === 1 ? "section" : "sections"} of this page…`;

      body.append(spinner, note);
    });
  }

  function renderEmpty(message) {
    setBody("", (body) => {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = message;
      body.appendChild(note);
    });
  }

  function renderError(message) {
    setBody("", (body) => {
      const note = document.createElement("p");
      note.className = "note error";
      note.textContent = message;
      body.appendChild(note);
    });
  }

  function renderResults(pairs) {
    setBody(`${pairs.length} found`, (body) => {
      for (const pair of pairs) {
        const card = document.createElement("div");
        card.className = "card";
        card.title = "Click to find this on the page";

        const original = document.createElement("p");
        original.className = "original";
        original.textContent = pair.original;

        const plain = document.createElement("p");
        plain.className = "plain";
        plain.textContent = pair.plain;

        card.append(original, plain);
        card.addEventListener("click", () => revealOnPage(pair.original));
        body.appendChild(card);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Click a card to jump to the phrase on the page
  // -------------------------------------------------------------------------

  function revealOnPage(phrase) {
    try {
      const target = findElementContaining(phrase);
      if (!target) return;

      target.scrollIntoView({ behavior: "smooth", block: "center" });

      const previous = target.style.backgroundColor;
      const previousTransition = target.style.transition;
      target.style.transition = "background-color 400ms ease";
      target.style.backgroundColor = "rgba(226, 168, 90, 0.35)";

      setTimeout(() => {
        target.style.backgroundColor = previous;
        setTimeout(() => {
          target.style.transition = previousTransition;
        }, 450);
      }, 1400);
    } catch {
      // Locating is a convenience — never let it break the panel.
    }
  }

  function findElementContaining(phrase) {
    const needle = phrase.replace(/\s+/g, " ").trim().toLowerCase();
    if (!needle) return null;

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      { acceptNode },
    );

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const haystack = node.nodeValue.replace(/\s+/g, " ").toLowerCase();
      if (haystack.includes(needle)) return node.parentElement;
    }

    // The phrase may span several inline nodes — fall back to the block.
    for (const el of document.body.querySelectorAll("p, li, td, h1, h2, h3, h4, blockquote, div")) {
      if (el.closest(`#${PANEL_ID}`)) continue;
      const text = (el.textContent ?? "").replace(/\s+/g, " ").toLowerCase();
      if (text.includes(needle) && el.children.length < 12) return el;
    }

    return null;
  }
})();
