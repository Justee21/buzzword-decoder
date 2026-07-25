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

- An Anthropic account and API key (free to create — see step 1 below)
- [Node.js](https://nodejs.org) 18 or newer, to run the proxy (step 3 below
  covers checking whether you already have it)
- Google Chrome (or another Chromium-based browser that supports Manifest V3
  extensions)

**Before you start:** this isn't a one-click install. You're running a small
server on your own computer (or a free hosting account), which means typing
a handful of commands into a terminal. If you've never done that before,
budget 15–20 minutes and follow each step in order — none of it requires
knowing how to code, just copying and pasting exactly what's shown.

## Setup

### 1. Get an Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com) and sign up
   or log in
2. In the left sidebar, click **Settings → API Keys** (or go directly to
   [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys))
3. Click **Create Key**, give it any name, and copy the key it shows you
   (it starts with `sk-ant-`) — you won't be able to see it again after you
   navigate away, so paste it somewhere safe for a moment
4. While you're there, it's worth setting a spend limit — see
   [Cost](#cost) below

### 2. Open a terminal

- **Mac:** open **Terminal** (search for it with Spotlight — press `Cmd+Space`,
  type "Terminal", press Enter)
- **Windows:** open **PowerShell** (search for it in the Start menu)

Everything from here is typed into that window, one block at a time.

### 3. Check you have Node.js, and get the code

```bash
node --version
```

If that prints something like `v18.x.x` or higher, you're set. If it says
"command not found," install Node from [nodejs.org](https://nodejs.org)
(the "LTS" button) and try the command again.

Then download this repository. If you have `git` installed:

```bash
git clone https://github.com/Justee21/buzzword-decoder.git
cd buzzword-decoder
```

If you don't have `git` (or don't know if you do), it's just as easy to
click the green **Code** button at the top of this repo's GitHub page →
**Download ZIP**, unzip it, and open a terminal inside the unzipped folder
instead.

### 4. Set up and start the proxy

```bash
cd proxy
npm install
cp -n .env.example .env
```

Now open the `.env` file that just appeared inside the `proxy` folder in any
text editor (Notepad, TextEdit, VS Code — whatever you have). It's a plain
text file; on Mac, files starting with a dot are hidden in Finder by
default, so it's easiest to open it from your editor's "Open File" dialog
rather than hunting for it visually, or just run `open .env` (Mac) /
`notepad .env` (Windows) from the terminal you already have open.

Find this line:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Replace the `sk-ant-...` part with the real key you copied in step 1, save,
and close the file. Then, back in the terminal:

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

That last part is expected and fine — it just means this copy is only
reachable from your own computer, which is exactly what you want for
personal use. Leave this terminal window open (closing it stops the
server) and move on to [step 5](#5-load-the-extension).

### Optional: deploy it so it's always on

The steps above only work while that terminal window stays open on your own
computer. If you'd rather it run all the time without your laptop needing to
be on, [Render](https://render.com) or [Railway](https://railway.app) will
run this exact code with no changes — free to sign up, connect this GitHub
repo, and set:

| Setting | Value |
|---|---|
| Root Directory | `proxy` |
| Build Command | `npm install` |
| Start Command | `npm start` |

Then add `ANTHROPIC_API_KEY` (the same key from step 1) as an environment
variable in that platform's dashboard — never paste it into a file you'd
commit to GitHub.

Because a hosted URL is reachable by anyone, not just you, also generate a
second secret to lock it down. Run this in your terminal:

```bash
openssl rand -hex 32
```

That prints a random string — set it as a second environment variable,
`PROXY_AUTH_TOKEN`, on the same hosting dashboard. Without this, anyone who
finds your server's URL could use your Anthropic key; this makes the server
reject any request that doesn't include the matching token. You'll paste
this same value into the extension's settings in the next step, in the
"Auth token" field — the value has to match exactly on both sides.

### 5. Load the extension

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
