# The web chat

Boltchat in the browser. `../chat.html` shows `index.html` from this folder in a frame; opening
`app/` directly gives the chat full screen.

Everything here is plain HTML, CSS and JavaScript. There is no build step: edit a file and push.

## What it does with data

- Nothing is sent to this website. There is no backend.
- Chats, settings, memories, projects, project files and the Groq API key are stored in the
  visitor's browser (IndexedDB), encrypted with a key the page cannot export.
- Requests go from the page straight to `api.groq.com`. The Content-Security-Policy in `index.html`
  allows this site's own files and `api.groq.com`, and nothing else.

Keep it that way: no analytics, CDNs, proxies or sync, here or on any other page of the site.

## Files

| | |
|---|---|
| `index.html` | The page. Loads the libraries, then the engine, then the page's scripts, in that order |
| `styles.css`, `projects.css` | The chat's styles, shared with the Windows app |
| `web.css` | Styles only the web chat needs (phone layout, backup controls, full-page notes) |
| `renderer.js`, `projects.js`, `project-files-ui.js`, `project-memory-ui.js`, `voice-chat.js`, `voice-chat-ui.js`, `voice-capture-worklet.js`, `conversation-history.js`, `project-context.js` | The page's scripts, shared with the Windows app. They call `window.groq` for everything |
| `web-shell.js` | Web-only controls: backup, restore, erase, storage warnings, the phone sidebar |
| `engine/engine.js` | `window.groq`: settings, the key, memory, chat streaming, voice requests, projects. The only file that talks to Groq |
| `engine/storage.js` | Keeps the data folder in IndexedDB, encrypted; backup, restore and erase |
| `engine/fs.js`, `path.js`, `crypto.js`, `buffer.js` | Small stand-ins for the Node modules the shared code uses; `fs.js` is the in-memory data folder |
| `engine/loader.js` | A tiny module registry (`Boltchat.define` / `require`), so the engine can be separate files without a bundler |
| `engine/shared/` | Projects, file indexing and search, shared with the Windows app |
| `engine/ingest-worker.js` | A Web Worker that reads, chunks and embeds project files |
| `sw.js`, `manifest.webmanifest` | Offline copy of the chat's files, and install-as-app details |
| `vendor/` | Libraries, unmodified: marked, DOMPurify, KaTeX, JSZip, pdf.js, ONNX Runtime Web, tokenizers |
| `models/` | The embedding model for project search (`bge-small-en-v1.5`, 34 MB, fetched only when a project has files) |
| `THIRD-PARTY-NOTICES.txt` | Licenses of everything in `vendor/` and `models/` |

## Shared with the Windows app

The files marked "shared" started as copies of the Windows app's sources (`src/` in its repository),
with wording changed where it said "this PC". When one of them changes there, copy the change here
by hand. Files in `engine/shared/` are wrapped in `Boltchat.define('name', function (require, module, exports) { … })`
and say at the top which file they come from.

Not in the web chat: the Code workspace, terminal and built-in browser, news-based start-screen
ideas (the newsrooms' feeds can't be read from a web page) and the rate-limit meters (Groq doesn't
let browsers read those response headers).

## Trying it locally

Serve the site folder with any static server (`npx serve .` from the repository root) and open
`/chat.html`. It talks to the real Groq API with whatever key is entered.

After replacing the model or a large library, change `HEAVY_CACHE` in `sw.js` so browsers fetch the new one.
