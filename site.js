// Small progressive enhancements; the site reads fine without them.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Navbar ----------
const header = document.querySelector('.site-header');
const nav = document.querySelector('.nav');
const indicator = document.querySelector('.nav-indicator');
const toggle = document.querySelector('.nav-toggle');

// Shrink into a tighter pill once you scroll, and fill the progress line as you read
function onScroll() {
  header?.classList.toggle('scrolled', scrollY > 16);
  const max = document.documentElement.scrollHeight - innerHeight;
  header?.style.setProperty('--progress', max > 0 ? Math.min(1, scrollY / max).toFixed(4) : 0);
}
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// A soft pill glides to the hovered link and settles back on the current page
if (nav && indicator) {
  const current = nav.querySelector('[aria-current="page"]');
  const moveTo = link => {
    if (!link) {
      indicator.style.opacity = '0';
      return;
    }
    indicator.style.width = `${link.offsetWidth}px`;
    indicator.style.transform = `translateX(${link.offsetLeft}px)`;
    indicator.style.opacity = '1';
  };
  nav.querySelectorAll('a').forEach(a => a.addEventListener('pointerenter', () => moveTo(a)));
  nav.addEventListener('pointerleave', () => moveTo(current));
  // wait for fonts so the first measurement is right
  (document.fonts?.ready || Promise.resolve()).then(() => moveTo(current));
  addEventListener('resize', () => moveTo(current));
}

// Mobile: hamburger opens a drop-down sheet
function setMenu(open) {
  header.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}
if (toggle) {
  toggle.addEventListener('click', () => setMenu(!header.classList.contains('open')));
  nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
  document.addEventListener('click', e => { if (!header.contains(e.target)) setMenu(false); });
}

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
  let onScreen = false;
  let waiting = false; // a replay is due but the demo is off screen
  new IntersectionObserver(entries => {
    onScreen = entries[0].isIntersecting;
    if (onScreen && waiting) {
      waiting = false;
      run();
    }
  }).observe(demo);
  const replay = () => (onScreen ? run() : (waiting = true));
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
      else setTimeout(replay, 3200);
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

// Live app demos: the app recreated in HTML (see app-demo.css), played step by step.
// [data-at="n"] appears at step n and [data-done="n"] gets ticked off at step n; a demo with
// several scenes moves to the next one after its last step and loops. The Chat/Code switch
// in the hero is clickable. Only plays while on screen; reduced motion shows the finished state.
const typeset = () => {
  if (!window.katex) return;
  document.querySelectorAll('[data-tex]').forEach(node => {
    try {
      katex.render(node.dataset.tex, node, { throwOnError: false });
    } catch {
      // keep the plain-text fallback
    }
  });
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', typeset);
else typeset();

document.querySelectorAll('.app[data-demo]').forEach(app => {
  const canvas = app.querySelector('.app-canvas');
  const scenes = [...app.querySelectorAll('.scene')];
  const lastStep = scene => Math.max(0, ...[...scene.querySelectorAll('[data-at], [data-done]')].map(n => Number(n.dataset.at || n.dataset.done)));
  let index = 0;
  let step = 0;
  let timer = 0;
  let onScreen = false;

  const paint = () => {
    const scene = scenes[index];
    scene.querySelectorAll('[data-at]').forEach(n => n.classList.toggle('on', Number(n.dataset.at) <= step));
    scene.querySelectorAll('[data-done]').forEach(n => n.classList.toggle('done', Number(n.dataset.done) <= step));
  };
  const show = i => {
    index = i;
    step = reduceMotion ? Infinity : 0;
    canvas.dataset.mode = scenes[i].dataset.scene;
    scenes.forEach((s, j) => s.classList.toggle('is-active', j === i));
    paint();
  };
  const stop = () => {
    clearTimeout(timer);
    timer = 0;
  };
  const tick = () => {
    stop();
    if (!onScreen || reduceMotion) return;
    const scene = scenes[index];
    if (step < lastStep(scene)) {
      step++;
      paint();
      timer = setTimeout(tick, Number(scene.dataset.ms) || 650);
    } else {
      timer = setTimeout(() => {
        show((index + 1) % scenes.length);
        timer = setTimeout(tick, 450);
      }, Number(scene.dataset.hold) || 3200);
    }
  };

  app.classList.add('js');
  show(0);
  app.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => {
    const i = scenes.findIndex(s => s.dataset.scene === button.dataset.go);
    if (i === -1) return;
    stop();
    show(i);
    timer = setTimeout(tick, 300);
  }));
  new IntersectionObserver(entries => {
    onScreen = entries[0].isIntersecting;
    if (!onScreen) stop();
    else if (!timer) timer = setTimeout(tick, 350);
  }, { threshold: 0.25 }).observe(app);
});

// Contact form: checks fields as you go, sends to Formspree in place (the form also works as a
// plain POST without JavaScript), shows Formspree's own field errors, and falls back to the normal
// submit if Formspree asks for a CAPTCHA, which only its hosted page can show.
const contactForm = document.getElementById('contact-form');
if (contactForm) {
  const $ = id => document.getElementById(id);
  const fields = { name: $('cf-name'), email: $('cf-email'), message: $('cf-message') };
  const status = $('cf-status');
  const submit = $('cf-submit');
  const done = $('contact-done');
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  const problem = name => {
    const value = fields[name].value.trim();
    if (name === 'name') return value ? '' : 'Please tell us your name.';
    if (name === 'email') return !value ? 'We need an email to reply to.' : EMAIL.test(value) ? '' : 'That email address doesn’t look right.';
    if (!value) return 'Please write a message.';
    return value.length < 10 ? 'A little more detail, please (at least 10 characters).' : '';
  };
  const showError = (name, message) => {
    const input = fields[name];
    const slot = $(`cf-${name}-error`);
    if (!input || !slot) return;
    slot.textContent = message;
    input.toggleAttribute('aria-invalid', !!message);
    if (message) input.setAttribute('aria-describedby', slot.id);
    else input.removeAttribute('aria-describedby');
  };
  // Only complain about a field once you've left it (or tried to send)
  for (const [name, input] of Object.entries(fields)) {
    input.addEventListener('blur', () => input.value && showError(name, problem(name)));
    input.addEventListener('input', () => input.hasAttribute('aria-invalid') && showError(name, problem(name)));
  }

  const count = $('cf-count');
  const updateCount = () => {
    const n = fields.message.value.length;
    count.textContent = `${n} / 5000`;
    count.classList.toggle('near', n > 4500);
  };
  fields.message.addEventListener('input', updateCount);

  // The subject line and the version field follow the chosen topic
  const versionField = $('cf-version-field');
  const onTopic = () => {
    const topic = contactForm.querySelector('input[name="topic"]:checked')?.value || 'Question';
    $('cf-subject').value = `Boltchat contact: ${topic}`;
    versionField.hidden = topic !== 'Bug report';
    $('cf-version').disabled = versionField.hidden; // disabled fields aren't sent
  };
  contactForm.addEventListener('change', e => e.target.name === 'topic' && onTopic());
  onTopic();

  const setBusy = busy => {
    submit.disabled = busy;
    submit.classList.toggle('busy', busy);
    submit.querySelector('.btn-label').textContent = busy ? 'Sending…' : 'Send message';
  };

  contactForm.addEventListener('submit', async e => {
    e.preventDefault();
    status.textContent = '';
    status.className = 'form-status';
    const bad = Object.keys(fields).map(name => [name, problem(name)]).filter(([, m]) => m);
    Object.keys(fields).forEach(name => showError(name, ''));
    bad.forEach(([name, m]) => showError(name, m));
    if (bad.length) {
      fields[bad[0][0]].focus();
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(contactForm.action, { method: 'POST', body: new FormData(contactForm), headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        $('cf-done-name').textContent = fields.name.value.trim().split(/\s+/)[0];
        $('cf-done-email').textContent = fields.email.value.trim();
        contactForm.hidden = true;
        done.hidden = false;
        done.focus();
        return;
      }
      const errors = Array.isArray(data.errors) ? data.errors : [];
      if (errors.some(err => /captcha/i.test(`${err.code} ${err.message}`))) {
        contactForm.submit(); // Formspree's hosted page handles the CAPTCHA
        return;
      }
      let general = '';
      for (const err of errors) {
        if (err.field && fields[err.field]) showError(err.field, err.message);
        else general = err.message;
      }
      status.textContent = general || (errors.length ? 'Please fix the highlighted fields.' : `Couldn’t send (error ${res.status}). Please try again in a moment.`);
      status.classList.add('error');
    } catch {
      status.innerHTML = 'Couldn’t reach the server — check your connection, or email <a href="mailto:harshit.garg@harshit-garg.com">harshit.garg@harshit-garg.com</a>.';
      status.classList.add('error');
    } finally {
      setBusy(false);
    }
  });

  $('cf-again').addEventListener('click', () => {
    contactForm.reset();
    updateCount();
    onTopic();
    done.hidden = true;
    contactForm.hidden = false;
    fields.message.focus();
  });
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
