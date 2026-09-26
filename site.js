// Small progressive enhancements; the site reads fine without them.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Reveal elements as they scroll into view
const revealer = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.classList.add('in');
      revealer.unobserve(e.target);
    }
  }
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => revealer.observe(el));

// Feature cards: glow follows the cursor
document.querySelectorAll('.card').forEach(card => {
  card.addEventListener('pointermove', e => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--x', `${e.clientX - r.left}px`);
    card.style.setProperty('--y', `${e.clientY - r.top}px`);
  });
});

// Hero screenshot tilts upright as you scroll
const tilted = document.querySelector('.stage .window');
if (tilted && !reduceMotion) {
  const update = () => {
    const r = tilted.getBoundingClientRect();
    const progress = Math.min(1, Math.max(0, 1 - (r.top - innerHeight * 0.15) / (innerHeight * 0.6)));
    tilted.style.transform = `rotateX(${(1 - progress) * 18}deg) scale(${0.96 + progress * 0.04})`;
  };
  addEventListener('scroll', update, { passive: true });
  update();
}

// Count the speed badge up to a real measured number
const counter = document.querySelector('[data-count]');
if (counter) {
  const target = Number(counter.dataset.count);
  if (reduceMotion) counter.textContent = target;
  else {
    const start = performance.now();
    const tick = now => {
      const t = Math.min(1, (now - start) / 1600);
      counter.textContent = Math.round(target * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

// Streaming demo: types a real Boltchat answer at roughly Groq speed, then loops
const demo = document.querySelector('.demo-a');
if (demo) {
  const text = demo.dataset.text;
  const words = text.split(/(\s+)/);
  const tokens = document.querySelector('[data-demo-tokens]');
  const speed = document.querySelector('[data-demo-speed]');
  const caret = '<span class="caret"></span>';
  let started = false;
  const run = () => {
    let i = 0;
    const t0 = performance.now();
    const step = () => {
      i = Math.min(words.length, i + 3);
      demo.innerHTML = words.slice(0, i).join('').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + caret;
      const secs = (performance.now() - t0) / 1000;
      const count = Math.round(i * 0.75 * 1.3);
      tokens.textContent = count;
      speed.textContent = secs > 0.05 ? Math.min(512, Math.round(count / secs)) : '—';
      if (i < words.length) setTimeout(step, 16);
      else setTimeout(run, 3200);
    };
    step();
  };
  if (reduceMotion) demo.textContent = text;
  else {
    new IntersectionObserver((entries, obs) => {
      if (entries[0].isIntersecting && !started) {
        started = true;
        obs.disconnect();
        run();
      }
    }, { threshold: 0.4 }).observe(demo);
  }
}

// Legal pages: highlight the section you're reading in the table of contents
const tocLinks = [...document.querySelectorAll('.toc a')];
if (tocLinks.length) {
  const byId = new Map(tocLinks.map(a => [a.getAttribute('href').slice(1), a]));
  const spy = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      tocLinks.forEach(a => a.classList.remove('active'));
      byId.get(e.target.id)?.classList.add('active');
    }
  }, { rootMargin: '-20% 0px -70% 0px' });
  document.querySelectorAll('.doc h2[id]').forEach(h => spy.observe(h));
}
