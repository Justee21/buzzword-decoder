// Injected on demand by the popup (activeTab + scripting). Chrome re-runs this
// file on every click, so everything is guarded against double initialisation.
(() => {
  if (window.__buzzwordDecoderReady) return;
  window.__buzzwordDecoderReady = true;

  const MARK_CLASS = "bd-mark";
  const POPOVER_HOST_ID = "buzzword-decoder-popover";
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

  injectMarkStyles();

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
    hidePopoverNow();
    clearMarks();
    sendStatus({ status: "scanning" });

    const blocks = extractBlocks();
    if (blocks.length === 0) {
      sendStatus({ status: "empty" });
      return { ok: true, count: 0, blocksScanned: 0 };
    }

    const chunks = buildChunks(blocks);

    const response = await chrome.runtime.sendMessage({
      type: "DECODE_CHUNKS",
      chunks,
    });

    if (!response?.ok) {
      const message = response?.message ?? "The decode request failed.";
      sendStatus({ status: "error" });
      return { ok: false, message };
    }

    const pairs = flattenResults(response.results);
    const highlighted = highlightPairs(pairs);

    sendStatus({ status: highlighted > 0 ? "found" : "empty" });
    return { ok: true, count: highlighted, blocksScanned: blocks.length };
  }

  /** Fire-and-forget status ping to the service worker, which owns the
   * toolbar icon/badge. Never lets a messaging failure affect the actual
   * decode flow — this is a UI touch, not load-bearing. */
  function sendStatus(payload) {
    chrome.runtime.sendMessage({ type: "DECODE_STATUS", ...payload }).catch(() => {});
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
    if (parent.closest(`.${MARK_CLASS}`)) return NodeFilter.FILTER_REJECT;
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
  // Inline highlighting — wrap each phrase in the live DOM with an underline
  // span, rather than rendering results in a separate panel.
  // -------------------------------------------------------------------------

  /** WeakMap so removed marks don't leak entries; keyed by the <span>. */
  let markPlainText = new WeakMap();

  function injectMarkStyles() {
    if (document.getElementById("bd-styles")) return;

    const style = document.createElement("style");
    style.id = "bd-styles";
    style.textContent = `
      .${MARK_CLASS} {
        text-decoration-line: underline !important;
        text-decoration-style: dotted !important;
        text-decoration-color: #b4530a !important;
        text-decoration-thickness: 1.5px !important;
        text-underline-offset: 3px !important;
        cursor: help !important;
        border-radius: 2px;
        transition: background-color 120ms ease;
      }
      .${MARK_CLASS}:hover, .${MARK_CLASS}:focus-visible {
        background-color: rgba(180, 83, 10, 0.14);
        outline: none;
      }
      @media (prefers-color-scheme: dark) {
        .${MARK_CLASS} {
          text-decoration-color: #e2924e !important;
        }
        .${MARK_CLASS}:hover, .${MARK_CLASS}:focus-visible {
          background-color: rgba(226, 146, 78, 0.18);
        }
      }
    `;
    document.head.appendChild(style);
  }

  function clearMarks() {
    document.querySelectorAll(`.${MARK_CLASS}`).forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
    markPlainText = new WeakMap();
  }

  function highlightPairs(pairs) {
    let placed = 0;
    for (const pair of pairs) {
      if (markPhrase(pair)) placed++;
    }
    return placed;
  }

  /**
   * Finds the first live text node containing `pair.original` and wraps it
   * in a `.bd-mark` span. The phrase was extracted from whitespace-collapsed
   * text (see extractBlocks), so the live text node is collapsed the same way
   * for matching, then the match position is mapped back to real offsets in
   * the uncollapsed node so the DOM split lands in the right place. Phrases
   * split across multiple inline nodes (e.g. by an <em>) aren't matched —
   * skipped silently rather than attempting a fragile multi-node wrap.
   */
  function markPhrase(pair) {
    const needle = pair.original;
    if (!needle) return false;

    const walker = document.createTreeWalker(
      document.body ?? document.documentElement,
      NodeFilter.SHOW_TEXT,
      { acceptNode },
    );

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const { collapsed, map } = collapseWithMap(node.nodeValue);
      const idx = collapsed.indexOf(needle);
      if (idx === -1) continue;

      const startOrig = map[idx];
      const endOrig = map[idx + needle.length - 1] + 1;

      const before = node.nodeValue.slice(0, startOrig);
      const matchedText = node.nodeValue.slice(startOrig, endOrig);
      const after = node.nodeValue.slice(endOrig);

      const mark = document.createElement("span");
      mark.className = MARK_CLASS;
      mark.textContent = matchedText;
      mark.tabIndex = 0;
      mark.setAttribute("role", "button");
      mark.setAttribute("aria-label", `Corporate jargon: "${matchedText}". Plain English: ${pair.plain}`);
      markPlainText.set(mark, pair.plain);
      attachMarkEvents(mark);

      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(mark);
      if (after) frag.appendChild(document.createTextNode(after));

      node.replaceWith(frag);
      return true;
    }

    return false;
  }

  /** Collapses runs of whitespace to a single space, without trimming, and
   * returns a map from each collapsed-string index back to the original
   * string index that produced it — needed to translate a match position
   * back into real offsets for splitting the text node. */
  function collapseWithMap(str) {
    let collapsed = "";
    const map = [];
    let inWhitespace = false;

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (/\s/.test(ch)) {
        if (!inWhitespace) {
          collapsed += " ";
          map.push(i);
          inWhitespace = true;
        }
      } else {
        collapsed += ch;
        map.push(i);
        inWhitespace = false;
      }
    }

    return { collapsed, map };
  }

  // -------------------------------------------------------------------------
  // Hover / focus popover
  // -------------------------------------------------------------------------

  let popoverShadow = null;
  let hideTimer = null;

  function getPopover() {
    if (popoverShadow) return popoverShadow;

    const host = document.createElement("div");
    host.id = POPOVER_HOST_ID;
    document.documentElement.appendChild(host);

    popoverShadow = host.attachShadow({ mode: "open" });
    popoverShadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }

        .bubble {
          position: fixed;
          z-index: 2147483647;
          display: none;
          max-width: 300px;
          padding: 14px 16px;
          border-radius: 12px;
          background: #ffffff;
          box-shadow: 0 12px 32px rgba(15, 18, 25, 0.18), 0 2px 8px rgba(15, 18, 25, 0.08);
          font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        }

        .bubble.visible { display: block; }

        .header {
          display: flex;
          align-items: center;
          gap: 7px;
          margin-bottom: 6px;
        }

        .icon {
          width: 16px;
          height: 16px;
          flex: none;
          border-radius: 4px;
          background: #b4530a;
        }

        .label {
          color: #b4530a;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }

        .plain {
          margin: 0;
          color: #16181d;
          font-size: 14px;
        }

        .tail {
          position: absolute;
          width: 12px;
          height: 12px;
          left: 20px;
          background: #ffffff;
          transform: rotate(45deg);
        }

        .bubble.tail-bottom .tail {
          bottom: -6px;
          box-shadow: 3px 3px 4px -2px rgba(15, 18, 25, 0.12);
        }

        .bubble.tail-top .tail {
          top: -6px;
          box-shadow: -3px -3px 4px -2px rgba(15, 18, 25, 0.12);
        }

        @media (prefers-color-scheme: dark) {
          .bubble { background: #17191d; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.3); }
          .plain { color: #eceef1; }
          .icon { background: #e2924e; }
          .label { color: #e2924e; }
          .tail { background: #17191d; }
        }
      </style>

      <div class="bubble" part="bubble" role="tooltip" aria-hidden="true">
        <div class="header">
          <span class="icon"></span>
          <span class="label">Plain English</span>
        </div>
        <p class="plain"></p>
        <div class="tail"></div>
      </div>
    `;

    const bubble = popoverShadow.querySelector(".bubble");
    bubble.addEventListener("mouseenter", cancelHide);
    bubble.addEventListener("mouseleave", scheduleHide);

    // A stale popover pointing at the wrong spot is worse than a hidden one.
    window.addEventListener("scroll", hidePopoverNow, { capture: true, passive: true });

    return popoverShadow;
  }

  function attachMarkEvents(mark) {
    mark.addEventListener("mouseenter", () => showPopover(mark));
    mark.addEventListener("mouseleave", scheduleHide);
    mark.addEventListener("focus", () => showPopover(mark));
    mark.addEventListener("blur", scheduleHide);
  }

  function showPopover(mark) {
    const plain = markPlainText.get(mark);
    if (!plain) return;

    cancelHide();

    const shadow = getPopover();
    const bubble = shadow.querySelector(".bubble");
    shadow.querySelector(".plain").textContent = plain;

    // Measure with the bubble laid out but not yet visible, so its final
    // size (before we know placement) doesn't include a flash at 0,0.
    bubble.classList.add("visible");
    bubble.style.visibility = "hidden";
    bubble.style.top = "0px";
    bubble.style.left = "0px";

    const popRect = bubble.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    const margin = 10;

    let top = markRect.top - popRect.height - margin;
    let tailClass = "tail-bottom"; // bubble above the mark, tail points down
    if (top < 8) {
      top = markRect.bottom + margin;
      tailClass = "tail-top"; // not enough room above — flip below
    }

    let left = markRect.left;
    const maxLeft = window.innerWidth - popRect.width - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < 8) left = 8;

    bubble.classList.remove("tail-top", "tail-bottom");
    bubble.classList.add(tailClass);
    bubble.style.top = `${top}px`;
    bubble.style.left = `${left}px`;
    bubble.style.visibility = "visible";
  }

  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(hidePopoverNow, 150);
  }

  function cancelHide() {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  function hidePopoverNow() {
    cancelHide();
    popoverShadow?.querySelector(".bubble")?.classList.remove("visible");
  }
})();
