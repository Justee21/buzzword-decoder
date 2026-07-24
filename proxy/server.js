import "dotenv/config";

import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const PORT = Number(process.env.PORT ?? 3000);
const MODEL = process.env.MODEL ?? "claude-haiku-4-5-20251001";
const MAX_CHUNKS = Number(process.env.MAX_CHUNKS ?? 20);
const MAX_CHUNK_CHARS = Number(process.env.MAX_CHUNK_CHARS ?? 6000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);

// The unedited value in .env.example. Treated as "not configured" so a copied
// but unedited .env fails loudly at startup instead of on the first request.
const PLACEHOLDER_KEY = "sk-ant-...";

const rawKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
const keyIsPlaceholder = rawKey === PLACEHOLDER_KEY;
const apiKey = rawKey && !keyIsPlaceholder ? rawKey : undefined;

// Constructed even when the key is missing so the process still boots and can
// return a clear error per request instead of crashing on startup.
const client = new Anthropic({ apiKey: apiKey ?? "missing" });

const SYSTEM_PROMPT = `You translate corporate jargon into plain English — with a dry,
slightly sarcastic wit. Think a sharp coworker rolling their eyes at a deck,
not a thesaurus.

You will be given a block of text scraped from a web page. Find the phrases and
sentences that are corporate buzzwords, jargon, or deliberately vague
business-speak, and rewrite each one plainly, with a bit of snark.

Rules:
- "original" must be an EXACT substring of the input text, copied verbatim
  (matching case, punctuation and spacing). Prefer a full sentence or a complete
  clause over a single word, so the reader can find it on the page.
- "plain" must say what the original actually means in concrete terms. Do not
  just swap in synonyms. If the phrase is vague because it is hiding something
  (layoffs, price increases, a missed deadline, a lack of a real answer), say so
  directly — the snark should come from calling that out plainly, not from
  mocking the reader or the company by name. Dry wit, not cruelty; informative
  first, funny second. Keep it to one short sentence.
- SKIP anything already written in plain language. Ordinary clear prose,
  navigation labels, dates, numbers, code, and legal boilerplate are not jargon.
- Never invent text that is not in the input.
- Tone reference (do not reuse these verbatim):
  "leverage synergies" → "Get people to actually talk to each other."
  "right-size the organization" → "Lay people off, but say it softer."
  "holistically empower end-to-end workflows" → "Make the tool do the whole job so you don't have to."
- If the input contains no corporate jargon, return an empty list. An empty list
  is a correct and expected answer — do not stretch to fill it.
- Return at most 12 items, choosing the most egregious ones.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          original: {
            type: "string",
            description: "The exact jargon phrase, copied verbatim from the input.",
          },
          plain: {
            type: "string",
            description: "What it actually means, in plain concrete English.",
          },
        },
        required: ["original", "plain"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

// Flipped to false if the API rejects output_config (e.g. the model or account
// does not support structured outputs), so we degrade to prompt-only JSON.
let structuredOutputsAvailable = true;

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------------------------------------------------------------------------
// CORS — chrome-extension:// origins only.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  } else if (origin) {
    // A browser page on some other origin is trying to use the proxy.
    return res.status(403).json({
      error: "forbidden_origin",
      message: "This proxy only accepts requests from chrome-extension:// origins.",
    });
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    apiKeyConfigured: Boolean(apiKey),
  });
});

// ---------------------------------------------------------------------------
// POST /decode
//   body:    { chunks: ["...", "..."] }
//   returns: { results: [[{original, plain}, ...], ...] }  (one array per chunk)
// ---------------------------------------------------------------------------
app.post("/decode", async (req, res) => {
  if (!apiKey) {
    return res.status(500).json({
      error: "missing_api_key",
      message: keyIsPlaceholder
        ? "ANTHROPIC_API_KEY in .env is still the placeholder (sk-ant-...). Replace it with a real key, then restart the server."
        : "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill in your key, then restart the server.",
    });
  }

  const { chunks } = req.body ?? {};

  if (!Array.isArray(chunks) || chunks.some((c) => typeof c !== "string")) {
    return res.status(400).json({
      error: "invalid_request",
      message: 'Body must be { "chunks": ["text", ...] }.',
    });
  }

  const trimmed = chunks
    .slice(0, MAX_CHUNKS)
    .map((c) => c.slice(0, MAX_CHUNK_CHARS));

  // Nothing worth sending to the model.
  if (trimmed.every((c) => c.trim().length < 40)) {
    return res.json({ results: trimmed.map(() => []) });
  }

  try {
    const results = await mapWithConcurrency(trimmed, CONCURRENCY, (chunk) =>
      decodeChunk(chunk),
    );
    return res.json({ results });
  } catch (err) {
    return res.status(err.httpStatus ?? 502).json({
      error: err.errorCode ?? "upstream_error",
      message: err.publicMessage ?? "The Anthropic API call failed.",
    });
  }
});

/**
 * Decode a single chunk. Retries once on malformed model output, then gives up
 * and returns an empty array rather than failing the whole request.
 *
 * Errors that retrying cannot fix (bad key, rate limit) are rethrown with
 * response metadata attached so the handler can surface them properly.
 */
async function decodeChunk(chunk) {
  if (chunk.trim().length < 40) return [];

  for (let attempt = 0; attempt < 2; attempt++) {
    let message;

    try {
      message = await callModel(chunk, attempt === 1);
    } catch (err) {
      const fatal = toFatalError(err);
      if (fatal) throw fatal;
      // Transient/unknown failure: let the loop retry once, then give up.
      if (attempt === 1) return [];
      continue;
    }

    const parsed = parsePairs(message, chunk);
    if (parsed) return parsed;
    // Malformed output — fall through and retry once with a stricter nudge.
  }

  return [];
}

async function callModel(chunk, isRetry) {
  const userText = isRetry
    ? `Your previous response was not valid JSON. Respond with JSON only.\n\nText to analyze:\n\n${chunk}`
    : `Text to analyze:\n\n${chunk}`;

  const params = {
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userText }],
  };

  if (structuredOutputsAvailable) {
    try {
      return await client.messages.create({
        ...params,
        output_config: {
          format: { type: "json_schema", schema: RESPONSE_SCHEMA },
        },
      });
    } catch (err) {
      if (isStructuredOutputRejection(err)) {
        console.warn(
          "[buzzword-decoder] Structured outputs rejected; falling back to prompt-only JSON.",
        );
        structuredOutputsAvailable = false;
      } else {
        throw err;
      }
    }
  }

  return client.messages.create({
    ...params,
    system: `${SYSTEM_PROMPT}\n\nRespond with ONLY a JSON array of {"original": "...", "plain": "..."} objects. No prose, no markdown fences. If there is no jargon, respond with [].`,
  });
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Returns an array of {original, plain}, or null if the output was unusable. */
function parsePairs(message, chunk) {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!text) return null;

  const raw = extractJson(text);
  if (raw === null) return null;

  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.items)
      ? raw.items
      : null;

  if (!list) return null;

  const seen = new Set();
  const pairs = [];

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;

    const original = typeof entry.original === "string" ? entry.original.trim() : "";
    const plain = typeof entry.plain === "string" ? entry.plain.trim() : "";
    if (!original || !plain) continue;

    // Drop hallucinated quotes that are not actually on the page.
    if (!chunk.includes(original)) continue;

    const key = original.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    pairs.push({ original, plain });
  }

  return pairs;
}

/** Tolerates markdown fences and leading prose around the JSON payload. */
function extractJson(text) {
  const candidates = [text];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);

  const firstBracket = text.search(/[[{]/);
  const lastBracket = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(text.slice(firstBracket, lastBracket + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // try the next candidate
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Maps errors that retrying cannot fix into a shape the route handler can
 * return. Returns null for errors worth one more attempt.
 */
function toFatalError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return decorate(err, 500, "invalid_api_key", "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in your .env file.");
  }

  if (err instanceof Anthropic.PermissionDeniedError) {
    return decorate(err, 500, "permission_denied", "This API key does not have access to the requested model.");
  }

  if (err instanceof Anthropic.RateLimitError) {
    return decorate(err, 429, "rate_limited", "Anthropic rate limit hit. Wait a moment and try again.");
  }

  if (err instanceof Anthropic.NotFoundError) {
    return decorate(err, 500, "unknown_model", `The model "${MODEL}" was not found. Check the MODEL value in your .env file.`);
  }

  if (err instanceof Anthropic.BadRequestError) {
    return decorate(err, 400, "bad_request", `Anthropic rejected the request: ${err.message}`);
  }

  // Connection errors and 5xx: the SDK already retried, but one more attempt
  // from our loop is cheap.
  return null;
}

function decorate(err, httpStatus, errorCode, publicMessage) {
  err.httpStatus = httpStatus;
  err.errorCode = errorCode;
  err.publicMessage = publicMessage;
  console.error(`[buzzword-decoder] ${errorCode}: ${err.message}`);
  return err;
}

function isStructuredOutputRejection(err) {
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  return /output_config|output_format|json_schema|structured/i.test(err.message);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Runs `worker` over `items` with a bounded number in flight, preserving order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

const server = app.listen(PORT, () => {
  console.log(`Buzzword Decoder proxy listening on http://localhost:${PORT}`);
  console.log(`  model: ${MODEL}`);
  if (keyIsPlaceholder) {
    console.warn("\n  WARNING: ANTHROPIC_API_KEY in .env is still the placeholder (sk-ant-...).");
    console.warn("  Open proxy/.env, paste your real key, and restart. Decoding will fail until then.\n");
  } else if (!apiKey) {
    console.warn("\n  WARNING: ANTHROPIC_API_KEY is not set — /decode will return an error.\n");
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error(`  If that's another copy of this proxy, just use it:`);
    console.error(`      curl http://localhost:${PORT}/health`);
    console.error(`  To stop it:      lsof -ti:${PORT} | xargs kill`);
    console.error(`  Or use another:  PORT=3001 npm start`);
    console.error(`                   (then update the proxy URL in the extension popup)\n`);
    process.exit(1);
  }

  console.error(`\nCould not start the server: ${err.message}\n`);
  process.exit(1);
});
