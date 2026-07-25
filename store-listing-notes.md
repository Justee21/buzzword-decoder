# Chrome Web Store submission notes

Not part of the extension — reference text to paste into the Developer
Dashboard submission form. Delete or keep out of the repo, your call.

## Permission justifications

**activeTab**
> Used to read the visible text of the current tab only when the user
> clicks the extension's "Decode This Page" button. No access to any tab
> the user hasn't explicitly interacted with.

**scripting**
> Injects the content script that reads page text and renders the
> underline/hover UI, scoped to the single active tab the user triggered
> the action on.

**storage**
> Stores the user's configured proxy server address and (optional) auth
> token locally in the browser, so they don't need to re-enter it on every
> use.

**Host permission (proxy server)**
> Required to send extracted page text to the server that performs the
> jargon-to-plain-English translation and returns the results.

**Remote code / third-party API use**
> The extension sends page text to a server the user configures (a small
> open-source proxy — source included in the listing), which forwards it to
> Anthropic's Claude API for processing and returns translated text. No
> code is fetched or executed remotely; only text data is exchanged.

## Store listing description (draft)

> **Buzzword Decoder** underlines corporate jargon on any webpage and shows
> you what it actually means when you hover over it.
>
> No more decoding "leverage synergies" or "right-sizing the organization"
> yourself — click Decode This Page, and jargon gets a dotted underline
> right where it already sits. Hover any underlined phrase for a plain
> English translation, with a bit of dry wit.
>
> This extension requires a small companion server (open source, a few
> minutes to set up) that holds your own Anthropic API key — your key
> never touches the browser. Setup instructions:
> github.com/Justee21/buzzword-decoder

## Privacy policy URL

Once the repo is public, use the raw file link:
`https://github.com/Justee21/buzzword-decoder/blob/main/PRIVACY.md`

(Or host it on your own site if you'd rather not depend on GitHub staying
public — Web Store just needs a stable URL.)
