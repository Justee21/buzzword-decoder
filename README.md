# Buzzword Decoder

A Chrome extension that underlines corporate jargon on any webpage and shows
you what it actually means when you hover over it — with a bit of snark.

> "We will **leverage our core synergies** to unlock stakeholder value."
> → *Get people to actually talk to each other.*

Nothing is inline-replaced or hidden — the page stays exactly as it was, with
a dotted underline under the jargon-y bits and a small popover on hover.

## How it works

Two pieces, split on purpose:

- **The extension** (`extension/`) — plain JS/HTML/CSS, no build step. Reads
  the visible text on the current tab, sends it off to be translated, and
  underlines whatever comes back.
- **The proxy** (`proxy/`) — a small Node/Express server that holds your
  Anthropic API key and calls Claude on the extension's behalf.

The extension **never** touches an API key and never talks to
`api.anthropic.com` directly. It only ever talks to your proxy. This means
your key stays on a server you control, not inside browser-extension code
that anyone could inspect.

**Each person who wants to use this runs their own proxy with their own
Anthropic API key.** There's no shared/hosted instance — that's deliberate.
An API key baked into distributed extension code isn't actually private (it's
readable by anyone who inspects the extension or reads this repo), so a
shared setup means everyone spends against one person's account. Running
your own keeps costs — and usage — entirely yours.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer, to run the proxy
- An [Anthropic API key](https://console.anthropic.com/settings/keys)
- Google Chrome (or another Chromium-based browser that supports Manifest V3
  extensions)

## Setup

### 1. Run the proxy

```bash
git clone https://github.com/Justee21/buzzword-decoder.git
cd buzzword-decoder/proxy
npm install
cp -n .env.example .env
```

Open `proxy/.env` and paste in your API key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then start it:

```bash
npm start
```

You should see:

```
Buzzword Decoder proxy listening on http://localhost:3000
  model: claude-haiku-4-5-20251001
  auth: PROXY_AUTH_TOKEN is not set — /decode is open to any chrome-extension:// caller
        set it before deploying anywhere other than localhost
```

That's enough to use it locally. Skip to step 2.

**Deploying it somewhere other than your own machine** (so it's always on,
not just while your laptop's running `npm start`) — [Render](https://render.com)
or [Railway](https://railway.app) both run this as-is with no code changes:
point them at this repo, set **Root Directory** to `proxy`, **Build Command**
to `npm install`, **Start Command** to `npm start`, and add
`ANTHROPIC_API_KEY` as an environment variable in their dashboard (never in
a file you commit).

If you deploy it anywhere reachable from the internet, also set
`PROXY_AUTH_TOKEN` in that same environment-variable panel — generate one
with:

```bash
openssl rand -hex 32
```

Without this, anyone who finds your server's URL can spend against your
Anthropic key; the CORS check alone only stops browser JavaScript, not a
script hitting the URL directly. You'll enter this same token into the
extension's settings in step 2.

### 2. Load the extension

No build step — Chrome loads the plain files directly.

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `extension/` folder from this repo
4. Pin "Buzzword Decoder" to your toolbar

Click the icon, then **change** next to the proxy address:

- **Proxy server** — `http://localhost:3000` if you're running it locally
  (the default), or your deployed URL if you followed the deploy step above
- **Auth token** — leave blank for localhost; paste the `PROXY_AUTH_TOKEN`
  value if you set one

Save, then open any page and click **Decode This Page**.

## What you get

- **Inline, not a takeover** — jargon gets a dotted underline where it
  already sits on the page; nothing else about the page changes until you
  hover
- **Hover for the translation** — a small "Plain English" popover next to
  the underlined phrase, dismissed by moving your mouse away
- **A tone, not just a translation** — the rewrites lean dry and a little
  sarcastic rather than being a flat corporate-to-plain-English swap
- **Toolbar status at a glance** — the extension icon itself shows idle,
  working, and done states, so you know it's finished without opening the
  popup

## Cost

Decoding uses `claude-haiku-4-5-20251001` — cheap, but not free. Set a
spend limit on your Anthropic account
([console.anthropic.com](https://console.anthropic.com) → Limits) so a
runaway loop or heavy usage can't surprise you. `proxy/server.js` also caps
how much text gets sent per request (`MAX_CHUNKS`, `MAX_CHUNK_CHARS` in
`.env`), but that bounds a single request's cost, not total usage over time.

## License

MIT — see [`LICENSE`](LICENSE).
