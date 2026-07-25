# Privacy Policy — Buzzword Decoder

**Last updated:** July 2026

## What the extension does with your data

When you click "Decode This Page," Buzzword Decoder reads the visible text
content of the current tab (skipping scripts, hidden elements, and form
inputs) and sends it to a server (the "proxy") for processing. The proxy
forwards that text to Anthropic's Claude API, which identifies corporate
jargon and returns plain-English rewrites. The extension then underlines the
matched phrases directly on the page.

This only happens when you click the extension's button. Nothing is sent
anywhere automatically, on every page load, or in the background.

## What's stored, and where

- **Locally, in your browser** (`chrome.storage.local`, never transmitted
  except to the proxy you've configured): the proxy server address, and an
  optional auth token if one is set.
- **On the proxy server**: nothing. The page text you send is forwarded to
  Anthropic and the response is returned — it is not logged, stored, or
  retained by the proxy itself.
- **With Anthropic**: subject to Anthropic's own data handling and retention
  policies for API usage. See
  [anthropic.com/legal/privacy](https://www.anthropic.com/legal/privacy).

## What's never collected

No analytics, no tracking, no cookies, no account, no data sold or shared
with any third party other than Anthropic (solely to perform the translation
you requested).

## Permissions this extension requests, and why

- **activeTab** — lets the extension read the current tab's content only
  when you click the extension icon, not on every page you visit.
- **scripting** — used to inject the code that reads page text and displays
  the underline/hover results, only on the tab you're actively using.
- **storage** — saves your proxy server address and auth token locally.
- **Host permission for the proxy server** — required to send page text to
  the server that performs the translation.

## Questions

This is an open-source project — the full source code is available at
[github.com/Justee21/buzzword-decoder](https://github.com/Justee21/buzzword-decoder)
if you'd like to verify any of the above yourself.
