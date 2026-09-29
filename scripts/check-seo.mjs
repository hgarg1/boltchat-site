import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import process from 'node:process';

const scriptPath = new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, match => match.slice(1));
const root = resolve(dirname(scriptPath), '..');
const origin = 'https://boltchat.harshit-garg.com';
const errors = [];

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function matches(html, pattern) {
  return [...html.matchAll(pattern)].map(match => match[1]);
}

function check(condition, message) {
  if (!condition) errors.push(message);
}

function localTarget(fromFile, reference) {
  const clean = reference.split('#')[0].split('?')[0];
  if (!clean) return fromFile;
  if (clean === '/' || clean === './') return 'index.html';
  if (clean.startsWith('/')) return clean.slice(1);
  return join(dirname(fromFile), clean).replaceAll('\\', '/');
}

const htmlFiles = readdirSync(root).filter(name => name.endsWith('.html')).sort();
const indexableCanonicals = [];
const titles = new Map();
const canonicals = new Map();

for (const file of htmlFiles) {
  const html = read(file);
  const title = matches(html, /<title>([\s\S]*?)<\/title>/gi);
  const description = matches(html, /<meta\s+name="description"\s+content="([^"]+)"/gi);
  const canonical = matches(html, /<link\s+rel="canonical"\s+href="([^"]+)"/gi);
  const h1 = matches(html, /<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/gi);
  const robots = matches(html, /<meta\s+name="robots"\s+content="([^"]+)"/gi);
  const noindex = robots.some(value => /\bnoindex\b/i.test(value));

  check(title.length === 1, `${file}: expected exactly one title`);
  check(h1.length === 1, `${file}: expected exactly one h1`);
  check(robots.length === 1, `${file}: expected exactly one robots meta tag`);

  if (file === '404.html') {
    check(noindex, '404.html: must include noindex');
    check(canonical.length === 0, '404.html: should not declare a canonical URL');
  } else {
    check(!noindex, `${file}: public page must be indexable`);
    check(description.length === 1, `${file}: expected exactly one description`);
    check(description[0]?.length >= 50 && description[0]?.length <= 165, `${file}: description should be 50-165 characters`);
    check(canonical.length === 1, `${file}: expected exactly one canonical URL`);
    check(canonical[0]?.startsWith(`${origin}/`), `${file}: canonical must use the production origin`);
    check(matches(html, /<meta\s+property="og:url"\s+content="([^"]+)"/gi)[0] === canonical[0], `${file}: og:url must match canonical`);
    for (const field of ['og:title', 'og:description', 'og:image', 'og:image:alt']) {
      check(new RegExp(`<meta\\s+property="${field}"\\s+content="[^"]+"`, 'i').test(html), `${file}: missing ${field}`);
    }
    for (const field of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt']) {
      check(new RegExp(`<meta\\s+name="${field}"\\s+content="[^"]+"`, 'i').test(html), `${file}: missing ${field}`);
    }
    indexableCanonicals.push(canonical[0]);
    if (title[0]) {
      check(!titles.has(title[0]), `${file}: duplicate title also used by ${titles.get(title[0])}`);
      titles.set(title[0], file);
    }
    if (canonical[0]) {
      check(!canonicals.has(canonical[0]), `${file}: duplicate canonical also used by ${canonicals.get(canonical[0])}`);
      canonicals.set(canonical[0], file);
    }
  }

  for (const script of matches(html, /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try {
      JSON.parse(script);
    } catch (error) {
      errors.push(`${file}: invalid JSON-LD (${error.message})`);
    }
  }

  const ids = new Set(matches(html, /\sid="([^"]+)"/gi));
  for (const reference of matches(html, /(?:href|src|srcset)="([^"]+)"/gi)) {
    if (/^(?:https?:|mailto:|data:|javascript:)/i.test(reference)) continue;
    for (const candidate of reference.split(',').map(value => value.trim().split(/\s+/)[0])) {
      const target = localTarget(file, candidate);
      check(existsSync(join(root, target)), `${file}: missing local target ${candidate}`);
      const fragment = candidate.includes('#') ? candidate.split('#', 2)[1] : '';
      if (fragment) {
        const targetHtml = target === file ? html : existsSync(join(root, target)) && extname(target) === '.html' ? read(target) : '';
        const targetIds = target === file ? ids : new Set(matches(targetHtml, /\sid="([^"]+)"/gi));
        check(targetIds.has(fragment), `${file}: missing fragment target ${candidate}`);
      }
    }
  }
}

const sitemap = read('sitemap.xml');
const sitemapUrls = matches(sitemap, /<loc>([^<]+)<\/loc>/gi).sort();
const expectedUrls = [...indexableCanonicals].sort();
check(JSON.stringify(sitemapUrls) === JSON.stringify(expectedUrls), 'sitemap.xml: URLs must exactly match indexable page canonicals');
for (const lastmod of matches(sitemap, /<lastmod>([^<]+)<\/lastmod>/gi)) {
  check(/^\d{4}-\d{2}-\d{2}$/.test(lastmod), `sitemap.xml: invalid lastmod ${lastmod}`);
}

const robots = read('robots.txt');
check(robots.includes(`Sitemap: ${origin}/sitemap.xml`), 'robots.txt: missing production sitemap declaration');
for (const agent of ['OAI-SearchBot', 'GPTBot', 'Claude-SearchBot', 'ClaudeBot', 'Google-Extended', 'PerplexityBot']) {
  check(robots.includes(`User-agent: ${agent}`), `robots.txt: missing explicit ${agent} policy`);
}

const llms = read('llms.txt');
check(llms.startsWith('# Boltchat\n'), 'llms.txt: must start with the product H1');
for (const url of [`${origin}/`, `${origin}/privacy.html`, 'https://apps.microsoft.com/detail/9NXXLRNBMWG0']) {
  check(llms.includes(url), `llms.txt: missing authoritative URL ${url}`);
}

for (const asset of ['assets/icon-128.png', 'assets/harshit-garg-450.jpg']) {
  check(existsSync(join(root, asset)), `missing optimized asset ${asset}`);
}

if (errors.length) {
  console.error(`SEO validation failed with ${errors.length} issue${errors.length === 1 ? '' : 's'}:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`SEO validation passed: ${expectedUrls.length} indexable pages, ${htmlFiles.length} HTML files, valid metadata, links, sitemap, robots and llms.txt.`);
