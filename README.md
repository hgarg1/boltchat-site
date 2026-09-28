<div align="center">

<img src="assets/icon.png" alt="Boltchat" width="96" height="96">

# Boltchat — website

**AI chat at the speed of thought.**
The marketing, leadership and legal site for Boltchat, a fast Windows chat app for the open models on Groq.

[**boltchat.harshit-garg.com**](https://boltchat.harshit-garg.com) · [Privacy](https://boltchat.harshit-garg.com/privacy.html) · [Terms](https://boltchat.harshit-garg.com/terms.html) · [Legal](https://boltchat.harshit-garg.com/legal.html) · [Leadership](https://boltchat.harshit-garg.com/leadership.html)

<img src="assets/og-image.png" alt="Boltchat — AI chat at the speed of thought" width="760">

</div>

---

## About Boltchat

Boltchat is a Windows desktop app that streams answers from the open models on [Groq](https://groq.com) at hundreds of tokens per second. It is built by **Harshit Garg, Founder & CEO**.

| | |
|---|---|
| ⚡ **Fast** | 400+ tokens/sec on GPT-OSS 120B, with live speed on every reply |
| 🌐 **Web search** | `/web` — the model searches, reads pages and cites its sources |
| 🐍 **Code runner** | `/code` — real Python for exact answers, with code and output shown |
| ∑ **Beautiful math** | LaTeX, matrices and chemistry typeset with KaTeX |
| 🎙 **Voice input** | Whisper transcription in well under a second |
| ✦ **Memory** | Optional: remembers facts about you across chats — add, review and delete them in Settings |
| 📰 **Fresh ideas** | New-chat suggestions from your memories, today's top stories (merged from seven public-service newsrooms and ranked by coverage) and fun ideas |
| 🔒 **Private** | No account, no tracking; chats and memories stay on your PC |

Boltchat is coming soon to the Microsoft Store. It needs your own Groq API key ([free tier available](https://console.groq.com/keys)).

## This repository

A dependency-free static site — no build step, no framework, no tracking.

```
.
├── index.html          Landing page (hero, features, live streaming demo)
├── leadership.html     Leadership team
├── privacy.html        Privacy policy  ─┐
├── terms.html          Terms of use     ├─ linked from the Microsoft Store listing and the app
├── legal.html          Legal & licenses ─┘
├── 404.html            Not-found page
├── style.css           All styles (dark + light themes, reduced-motion aware)
├── site.js             Progressive enhancements: navbar, scroll reveal, demo, TOC
├── assets/             Icon, screenshots, social image, leadership photo
├── robots.txt, sitemap.xml
└── CNAME               Custom domain for GitHub Pages
```

### Preview locally

```bash
npx serve .
```
Then open http://localhost:3000. (Any static file server works; opening the HTML files directly also works, except the root-relative links on `404.html`.)

### Deploy

Every push to `main` is published by **GitHub Pages** to https://boltchat.harshit-garg.com, with HTTPS enforced.
DNS: a `CNAME` record for `boltchat` pointing to `hgarg1.github.io`.

### Common edits

| To change… | Edit |
|---|---|
| Leadership bio or links | `leadership.html` (`.leader-info`) |
| App screenshots | Replace `assets/screenshot-*.png` (1280×800, use a chat with no personal content) |
| Policy wording | The page, **and** its "Effective"/"Updated" date near the top |
| Social preview image | `assets/og-image.png` (1200×630) |
| New page | Copy an existing page's `<head>`, header and footer; add it to `sitemap.xml` |

### Design notes
- Honors the visitor's **light/dark** preference and **reduced motion** setting.
- Accessible by keyboard: skip-to-content link, visible focus rings, semantic headings.
- Images carry dimensions and lazy-load below the fold; the demo pauses while off screen.

## Contact

Harshit Garg — [harshit.garg@harshit-garg.com](mailto:harshit.garg@harshit-garg.com)

## Copyright

Copyright © 2026 Harshit Garg (Boltchat). All rights reserved.

The content, design, text, images and branding of this website, including the Boltchat name and logo, are not licensed for reuse. See [`COPYRIGHT`](COPYRIGHT) for details. The Boltchat desktop app is licensed separately under the MIT License, as described on the [Legal](https://boltchat.harshit-garg.com/legal.html) page.

Boltchat is an independent product and is not affiliated with, endorsed by or sponsored by Groq, Inc. "Groq" is a trademark of Groq, Inc.
