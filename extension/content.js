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
          padding: 17px 18px;
          border-bottom: 1px solid #eceeef;
        }

        .heading {
          flex: 1;
          margin: 0;
          font-size: 15px;
          font-weight: 700;
          letter-spacing: -0.01em;
        }

        .close {
          flex: none;
          padding: 4px 8px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: #9aa0a8;
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
        }
        .close:hover { background: #f1f3f6; color: #16181d; }

        .body {
          flex: 1;
          overflow-y: auto;
          padding: 4px 18px 28px;
        }

        .item {
          padding: 16px 0;
          border-bottom: 1px solid #eceeef;
        }
        .item:last-child { border-bottom: 0; }

        .quote {
          margin: 0 0 8px;
          color: #b4530a;
          font-size: 13.5px;
          line-height: 1.5;
        }
        .quote::before { content: "\\201C"; }
        .quote::after { content: "\\201D"; }

        .plain {
          margin: 0 0 8px;
          font-size: 13.5px;
          font-weight: 600;
          color: #16181d;
        }

        .jump {
          color: #2f5fd1;
          font-size: 12.5px;
          text-decoration: underline;
          text-underline-offset: 2px;
        }
        .jump:hover { color: #1f45a8; }

        .note {
          margin: 0;
          padding: 24px 4px;
          color: #9aa0a8;
          font-size: 13px;
          text-align: center;
        }

        .note.error { color: #a3241f; }

        .spinner {
          display: block;
          width: 18px;
          height: 18px;
          margin: 0 auto 12px;
          border: 2px solid #e5e7ea;
          border-top-color: #16181d;
          border-radius: 50%;
          animation: spin 0.75s linear infinite;
        }

        @keyframes spin { to { transform: rotate(360deg); } }

        @media (prefers-color-scheme: dark) {
          .panel { background: #17191d; color: #eceef1; }
          header { border-bottom-color: #2a2d33; }
          .close { color: #868c96; }
          .close:hover { background: #23262c; color: #eceef1; }
          .item { border-bottom-color: #2a2d33; }
          .quote { color: #e2924e; }
          .plain { color: #eceef1; }
          .jump { color: #7ea1ff; }
          .jump:hover { color: #a9c2ff; }
          .note { color: #868c96; }
          .note.error { color: #ef8d86; }
          .spinner { border-color: #2a2d33; border-top-color: #eceef1; }
        }
      </style>

      <div class="panel" part="panel">
        <header>
          <p class="heading">Buzzword Decoder</p>
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

  function setBody(headingText, build) {
    const root = getPanel();
    root.querySelector(".heading").textContent = headingText;

    const body = root.querySelector(".body");
    body.textContent = "";
    build(body);
  }

  function renderLoading(chunkCount) {
    setBody("Buzzword Decoder", (body) => {
      const spinner = document.createElement("div");
      spinner.className = "spinner";

      const note = document.createElement("p");
      note.className = "note";
      note.textContent = `Reading ${chunkCount} ${chunkCount === 1 ? "section" : "sections"} of this page…`;

      body.append(spinner, note);
    });
  }

  function renderEmpty(message) {
    setBody("Buzzword Decoder", (body) => {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = message;
      body.appendChild(note);
    });
  }

  function renderError(message) {
    setBody("Buzzword Decoder", (body) => {
      const note = document.createElement("p");
      note.className = "note error";
      note.textContent = message;
      body.appendChild(note);
    });
  }

  function renderResults(pairs) {
    setBody(`${pairs.length} ${pairs.length === 1 ? "buzzword" : "buzzwords"} found`, (body) => {
      for (const pair of pairs) {
        const item = document.createElement("div");
        item.className = "item";

        const quote = document.createElement("p");
        quote.className = "quote";
        quote.textContent = pair.original;

        const plain = document.createElement("p");
        plain.className = "plain";
        plain.textContent = pair.plain;

        const jump = document.createElement("a");
        jump.className = "jump";
        jump.href = "#";
        jump.textContent = "Jump to spot ↗";
        jump.addEventListener("click", (e) => {
          e.preventDefault();
          revealOnPage(pair.original);
        });

        item.append(quote, plain, jump);
        body.appendChild(item);
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
