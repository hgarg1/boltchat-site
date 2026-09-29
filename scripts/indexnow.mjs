import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const scriptPath = new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, match => match.slice(1));
const root = resolve(dirname(scriptPath), '..');
const host = 'boltchat.harshit-garg.com';
const key = '4a3210c58dfb465f96e66c485f2a96c8';
const keyLocation = `https://${host}/${key}.txt`;
const sitemap = readFileSync(resolve(root, 'sitemap.xml'), 'utf8');
const allUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
const before = process.env.INDEXNOW_BEFORE;
const after = process.env.INDEXNOW_AFTER || 'HEAD';
const dryRun = process.argv.includes('--dry-run');

let urlList = allUrls;
if (before && !/^0+$/.test(before)) {
  const changed = execFileSync('git', ['diff', '--name-only', before, after], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  const shared = changed.some(file => ['style.css', 'site.js', 'app-demo.css', 'sitemap.xml', 'robots.txt', 'llms.txt'].includes(file) || file.startsWith('assets/'));
  if (!shared) {
    const changedHtml = new Set(changed.filter(file => file.endsWith('.html') && file !== '404.html'));
    urlList = allUrls.filter(url => {
      const path = new URL(url).pathname;
      const file = path === '/' ? 'index.html' : path.slice(1);
      return changedHtml.has(file);
    });
  }
}

if (!urlList.length) {
  console.log('IndexNow: no indexable public URLs changed.');
  process.exit(0);
}

if (dryRun) {
  console.log(`IndexNow dry run: ${urlList.length} URL${urlList.length === 1 ? '' : 's'} would be submitted.`);
  for (const url of urlList) console.log(`- ${url}`);
  process.exit(0);
}

const response = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host, key, keyLocation, urlList })
});

if (![200, 202].includes(response.status)) {
  throw new Error(`IndexNow rejected the submission with HTTP ${response.status}: ${await response.text()}`);
}

console.log(`IndexNow accepted ${urlList.length} changed URL${urlList.length === 1 ? '' : 's'} with HTTP ${response.status}.`);
