// Voice chat core: everything that can be decided without a microphone, a speaker or the network.
// A pure turn state machine (reduce), an energy VAD, the text cleaner and chunker that prepare a
// reply for speech, the filters for Whisper's empty-audio hallucinations, and a WAV encoder.
// The desktop UI (voice-chat-ui.js) and the Android port (audio/*.kt) run the same logic against
// test-fixtures/voice-cases.json and voice-traces.json. See docs/voice-chat/README.md.
(function exposeVoiceChat(globalScope, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalScope.VoiceChat = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, () => {
  // Groq's Orpheus accepts at most 200 characters per request; stay under it so a vocal tag still fits
  const MAX_CHUNK = 200;
  const MERGE_TO = 170;
  const CODE_NOTE = 'The code is on screen.';

  // ---------- Text cleaning ----------

  const ABBREVIATIONS = ['e.g.', 'i.e.', 'vs.', 'etc.', 'Dr.', 'Mr.', 'Mrs.', 'Ms.', 'Prof.', 'Sr.', 'Jr.', 'St.', 'U.S.', 'U.K.', 'No.'];

  function cleanForSpeech(input) {
    let s = String(input || '');
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
    s = s.replace(/<think>[\s\S]*$/i, ' '); // still open while streaming
    s = s.replace(/【[^】]*】/g, ''); // 【3†L10-L14】 citations
    s = s.replace(/\[(?:\d+(?:\s*[,–-]\s*\d+)*)\]/g, ''); // [1] [1, 2] [1-3]
    s = s.replace(/(^|\n)\s*(?:Sources?|References?)\s*:[\s\S]*$/i, '$1');
    s = s.replace(/```[\s\S]*?```/g, ` ${CODE_NOTE} `);
    s = s.replace(/```[\s\S]*$/g, ` ${CODE_NOTE} `); // an unfinished fence
    s = s.replace(/`([^`\n]*)`/g, '$1');
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1');
    s = s.replace(/https?:\/\/\S+/g, 'a link');
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    s = s.replace(/^\s{0,3}>\s?/gm, '');
    s = s.replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/gm, '');
    s = s.split('\n').map(line => {
      if (/^[\s|:-]+$/.test(line) && /-{2,}/.test(line)) return ''; // | --- | --- |
      if (!line.includes('|')) return line;
      return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()).filter(Boolean).join(', ');
    }).join('\n');
    s = s.replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2');
    s = s.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, '$1 dollars');
    s = s.replace(/(\d)\s?%/g, '$1 percent');
    s = s.replace(/\be\.g\./gi, 'for example').replace(/\bi\.e\./gi, 'that is').replace(/\bvs\./gi, 'versus');
    s = s.replace(/\s*(?:->|=>|→|⇒)\s*/g, ' to ');
    s = s.replace(/[\p{Extended_Pictographic}️‍]/gu, '');
    s = s.replace(/[*_~#^]+/g, ' ');
    // a line that ended without punctuation (a list item, a heading) becomes its own sentence
    s = s.split('\n').map(line => {
      const t = line.trim();
      return t && !/[.!?…:;,)"'”]$/.test(t) ? `${t}.` : t;
    }).join('\n');
    return s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  }

  // ---------- Chunking for TTS ----------

  function isAbbreviation(text, endIndex) {
    const head = text.slice(Math.max(0, endIndex - 6), endIndex + 1).toLowerCase();
    return ABBREVIATIONS.some(a => {
      const abbr = a.toLowerCase();
      if (!head.endsWith(abbr)) return false;
      const before = head.charAt(head.length - abbr.length - 1);
      return !/[\p{L}\p{N}]/u.test(before); // "test." is a word, "St." is not
    });
  }

  // Index just past the next stable sentence boundary at or after `from`, or -1
  function nextBoundary(raw, from) {
    for (let i = from; i < raw.length; i++) {
      const c = raw[i];
      if (c === '`' && raw.startsWith('```', i)) {
        // a fenced block is one unit: wait for the closing fence, then end after its line
        const close = raw.indexOf('```', i + 3);
        if (close < 0) return -1;
        const eol = raw.indexOf('\n', close + 3);
        return eol < 0 ? (raw.length > close + 3 ? raw.length : -1) : eol + 1;
      }
      if (c === '\n') return i + 1;
      if (c === '.' || c === '!' || c === '?' || c === '…') {
        let j = i + 1;
        while (j < raw.length && /["')\]”*_]/.test(raw[j])) j++;
        if (j >= raw.length) return -1; // can't tell yet: more text may follow ("3.5")
        if (!/\s/.test(raw[j])) continue; // 3.5, example.com
        if (c === '.' && (isAbbreviation(raw, i) || /\d$/.test(raw.slice(Math.max(0, i - 1), i)) && /\d/.test(raw[j + 1] || ''))) continue;
        return j;
      }
    }
    return -1;
  }

  function splitLong(text) {
    const out = [];
    let rest = text.trim();
    while (rest.length > MAX_CHUNK) {
      let cut = -1;
      for (const re of [/[;:—]\s/g, /,\s/g, /\s/g]) {
        let m;
        let best = -1;
        while ((m = re.exec(rest.slice(0, MAX_CHUNK - 1)))) best = m.index + m[0].length;
        if (best > 40) {
          cut = best;
          break;
        }
      }
      if (cut < 0) cut = MAX_CHUNK;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
  }

  // Feeds on the raw (uncleaned) reply as it grows; hands back speakable chunks with their offsets in
  // that raw text, so the spoken position can be mapped back to what is on screen.
  class SpeechChunker {
    constructor() {
      this.consumed = 0;
      this.emitted = 0;
      this.codeNoted = false;
    }

    // `raw` is the whole reply so far. `final` flushes whatever is left.
    push(raw, final = false) {
      const segments = [];
      let guard = 0;
      while (guard++ < 400) {
        const open = this.openStart(raw);
        const view = raw.slice(0, open >= 0 ? open : raw.length);
        let end = nextBoundary(view, this.consumed);
        if (end < 0 && this.emitted === 0 && segments.length === 0) end = this.pendingFirst(view);
        if (end < 0 && final && open < 0 && this.consumed < view.length) end = view.length;
        if (end <= this.consumed) break;
        segments.push({ rawStart: this.consumed, rawEnd: end, text: this.speak(raw.slice(this.consumed, end)) });
        this.consumed = end;
      }
      if (final && this.consumed < raw.length) {
        // an unfinished <think> is dropped and an unfinished code fence becomes the code note
        segments.push({ rawStart: this.consumed, rawEnd: raw.length, text: this.speak(raw.slice(this.consumed)) });
        this.consumed = raw.length;
      }
      return this.assemble(segments);
    }

    // Where an unfinished <think> or code fence starts (we wait for it to close), else -1
    openStart(raw) {
      const t = raw.toLowerCase().lastIndexOf('<think>');
      if (t >= this.consumed && raw.toLowerCase().indexOf('</think>', t) === -1) return t;
      const fences = [...raw.matchAll(/```/g)].map(m => m.index);
      if (fences.length % 2 === 1 && fences[fences.length - 1] >= this.consumed) return fences[fences.length - 1];
      return -1;
    }

    // Low latency: with nothing spoken yet, a long first sentence may be cut at a comma
    pendingFirst(view) {
      const tail = view.slice(this.consumed);
      if (tail.length <= 80) return 0;
      const re = /[,;:—]\s/g;
      let m;
      let best = 0;
      while ((m = re.exec(tail))) if (m.index >= 25) {
        best = this.consumed + m.index + m[0].length;
        break;
      }
      return best;
    }

    speak(rawPart) {
      let text = cleanForSpeech(rawPart);
      if (text.includes(CODE_NOTE)) {
        text = this.codeNoted ? text.split(CODE_NOTE).join(' ') : text;
        this.codeNoted = true;
        text = text.replace(/\s+/g, ' ').trim();
      }
      return text;
    }

    assemble(segments) {
      const out = [];
      for (const seg of segments) {
        if (!seg.text || !/[\p{L}\p{N}]/u.test(seg.text)) continue;
        const last = out[out.length - 1];
        const mergeable = last && this.emitted + out.length > 1 && last.text.length + 1 + seg.text.length <= MERGE_TO;
        if (mergeable) {
          last.text += ` ${seg.text}`;
          last.rawEnd = seg.rawEnd;
        } else out.push({ ...seg });
      }
      const result = [];
      for (const c of out) {
        for (const piece of splitLong(c.text)) result.push({ text: piece, rawStart: c.rawStart, rawEnd: c.rawEnd });
      }
      this.emitted += result.length;
      return result;
    }
  }

  // ---------- Spoken position and history ----------

  // How much of the raw reply had been heard when playback stopped: `index` is the chunk that was
  // playing and `fraction` (0..1) how far through it, snapped back to a word boundary
  function spokenChars(raw, chunks, index, fraction) {
    if (!chunks.length || index < 0) return 0;
    const c = chunks[Math.min(index, chunks.length - 1)];
    const f = Math.max(0, Math.min(1, fraction));
    let n = c.rawStart + Math.floor((c.rawEnd - c.rawStart) * f);
    if (f < 1) while (n > c.rawStart && !/\s/.test(raw[n - 1] || ' ')) n--;
    return Math.max(0, Math.min(raw.length, n));
  }

  // What the model should see for an interrupted reply
  function historyForInterrupted(raw, spoken) {
    const heard = raw.slice(0, spoken).trim();
    return heard ? `${heard} [interrupted by user]` : '[interrupted by user before speaking]';
  }

  // ---------- Whisper filters ----------

  const HALLUCINATIONS = [
    'thank you', 'thanks', 'thank you for watching', 'thanks for watching', 'thank you very much', 'you', 'bye', 'bye bye', 'goodbye',
    'subtitles by', 'subtitle by', 'amara org', 'please subscribe', 'like and subscribe', 'music', 'applause', 'silence', 'the end', 'uh', 'um', 'hmm', 'mm', 'oh'
  ];
  const BACKCHANNELS = ['mm hmm', 'mhm', 'mm', 'uh huh', 'yeah', 'yep', 'yes', 'okay', 'ok', 'right', 'sure', 'i see', 'got it', 'go on', 'oh', 'ah', 'hm', 'hmm', 'cool', 'nice', 'wow', 'really'];
  const STOP_COMMANDS = ['stop', 'wait', 'hold on', 'hang on', 'never mind', 'nevermind', 'cancel', 'be quiet', 'shut up', 'enough', 'pause', 'one second', 'one sec'];

  const normalize = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

  // `result` is Groq's verbose_json: { text, segments: [{ no_speech_prob, avg_logprob, compression_ratio }] }
  function isHallucination(result, durationMs = 0) {
    const text = normalize(result && result.text);
    if (!text) return true;
    if (!/[\p{L}\p{N}]/u.test(text) || (text.match(/[\p{L}\p{N}]/gu) || []).length < 2) return true;
    const segs = (result && result.segments) || [];
    const noSpeech = segs.length ? Math.max(...segs.map(s => s.no_speech_prob || 0)) : 0;
    const logprob = segs.length ? Math.min(...segs.map(s => (typeof s.avg_logprob === 'number' ? s.avg_logprob : 0))) : 0;
    const ratio = segs.length ? Math.max(...segs.map(s => s.compression_ratio || 0)) : 0;
    if (ratio > 2.4) return true;
    if (noSpeech > 0.6 && logprob < -1) return true;
    const known = HALLUCINATIONS.some(h => text === h || text.startsWith(`${h} `) && text.length <= h.length + 12);
    if (known && (durationMs < 2000 || noSpeech > 0.5)) return true;
    return false;
  }

  const isBackchannel = text => {
    const t = normalize(text);
    return !!t && BACKCHANNELS.includes(t);
  };
  const isStopCommand = text => {
    const t = normalize(text);
    return !!t && STOP_COMMANDS.some(c => t === c || t === `${c} please` || t === `please ${c}` || t.startsWith(`${c} `) && t.split(' ').length <= 3);
  };

  // Share of the words in `heard` that the model had just said: high means the mic picked up the speaker
  function echoSimilarity(heard, spoken) {
    const a = normalize(heard).split(' ').filter(Boolean);
    const b = new Set(normalize(spoken).split(' ').filter(Boolean));
    if (!a.length) return 0;
    return a.filter(w => b.has(w)).length / a.length;
  }

  // ---------- WAV ----------

  function encodeWav(samples, sampleRate = 16000) {
    const n = samples.length;
    const out = new Uint8Array(44 + n * 2);
    const view = new DataView(out.buffer);
    const str = (o, s) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, samples[i], true);
    return out;
  }

  // ---------- Voice activity detection ----------

  const FULL_SCALE = 32768;
  function frameStats(frame) {
    let sum = 0;
    let diff = 0;
    let prev = 0;
    const scale = frame instanceof Float32Array ? 1 : FULL_SCALE;
    for (let i = 0; i < frame.length; i++) {
      const x = frame[i] / scale;
      sum += x * x;
      const d = x - prev;
      diff += d * d;
      prev = x;
    }
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    const db = 20 * Math.log10(Math.max(rms, 1e-7));
    const hp = rms > 1e-7 ? Math.sqrt(diff / Math.max(1, frame.length)) / rms : 0;
    return { db, hp };
  }

  const DEFAULT_VAD = {
    sampleRate: 16000, hangoverMs: 700, minVoicedMs: 250, maxUtteranceMs: 30000, preRollMs: 400,
    startMarginDb: 12, stopMarginDb: 6, minStartDb: -45, floorMin: -70, floorMax: -35
  };

  // Push fixed-size frames (any length, normally 20 ms); get back SPEECH_START / SPEECH_END events
  class Vad {
    constructor(options = {}) {
      this.o = { ...DEFAULT_VAD, ...options };
      this.reset();
    }

    reset() {
      this.floor = -60;
      this.speaking = false;
      this.recent = [];
      this.preRoll = [];
      this.preRollMs = 0;
      this.utterance = [];
      this.utteranceMs = 0;
      this.voicedMs = 0;
      this.quietMs = 0;
      this.level = -100;
    }

    // Forget the audio buffered so far (an utterance in progress, the pre-roll) but keep what was learned
    // about the room: used when frames were skipped, e.g. while the model was speaking
    flush() {
      this.speaking = false;
      this.recent = [];
      this.preRoll = [];
      this.preRollMs = 0;
      this.utterance = [];
      this.utteranceMs = 0;
      this.voicedMs = 0;
      this.quietMs = 0;
    }

    thresholds() {
      return { start: Math.max(this.floor + this.o.startMarginDb, this.o.minStartDb), stop: this.floor + this.o.stopMarginDb };
    }

    push(frame) {
      const events = [];
      const ms = (frame.length / this.o.sampleRate) * 1000;
      const { db, hp } = frameStats(frame);
      this.level = db;
      const { start, stop } = this.thresholds();
      const rumble = hp < 0.06; // low-frequency hum carries almost no high-frequency energy
      const loud = db > (this.speaking ? stop : start) && !(rumble && !this.speaking);

      if (!this.speaking) {
        // the noise floor only learns from frames that are not speech: quickly down, slowly up
        const tau = db < this.floor ? 300 : 3000;
        this.floor += (db - this.floor) * (1 - Math.exp(-ms / tau));
        this.floor = Math.max(this.o.floorMin, Math.min(this.o.floorMax, this.floor));
        this.recent.push(loud);
        if (this.recent.length > 5) this.recent.shift();
        this.preRoll.push(frame.slice ? frame.slice() : frame);
        this.preRollMs += ms;
        while (this.preRollMs - (this.preRoll.length ? (this.preRoll[0].length / this.o.sampleRate) * 1000 : 0) >= this.o.preRollMs) {
          this.preRollMs -= (this.preRoll[0].length / this.o.sampleRate) * 1000;
          this.preRoll.shift();
        }
        if (this.recent.filter(Boolean).length >= 3 && loud) {
          this.speaking = true;
          this.utterance = this.preRoll.slice();
          this.utteranceMs = this.preRollMs;
          this.voicedMs = ms * this.recent.filter(Boolean).length;
          this.quietMs = 0;
          this.preRoll = [];
          this.preRollMs = 0;
          this.recent = [];
          events.push({ type: 'SPEECH_START' });
        }
        return events;
      }

      this.utterance.push(frame.slice ? frame.slice() : frame);
      this.utteranceMs += ms;
      if (loud) {
        this.voicedMs += ms;
        this.quietMs = 0;
      } else this.quietMs += ms;

      const long = this.utteranceMs >= this.o.maxUtteranceMs;
      if (this.quietMs >= this.o.hangoverMs || long) {
        const tooShort = this.voicedMs < this.o.minVoicedMs;
        events.push({ type: 'SPEECH_END', tooShort, reason: long ? 'max' : 'silence', voicedMs: this.voicedMs, audio: tooShort ? null : this.takeAudio() });
        this.speaking = false;
        this.utterance = [];
        this.utteranceMs = 0;
        this.voicedMs = 0;
        this.quietMs = 0;
        this.recent = [];
      }
      return events;
    }

    // The utterance as one Int16Array at the VAD's sample rate
    takeAudio() {
      const total = this.utterance.reduce((n, f) => n + f.length, 0);
      const out = new Int16Array(total);
      let at = 0;
      for (const f of this.utterance) {
        for (let i = 0; i < f.length; i++) {
          const v = f instanceof Float32Array ? Math.max(-1, Math.min(1, f[i])) * 32767 : f[i];
          out[at++] = Math.round(v);
        }
      }
      return out;
    }
  }

  const frameDb = frame => frameStats(frame).db;

  // Decides when the user is talking over the model (only used when "interrupt by speaking" is on).
  // Each frame it gets the mic level, the level of what the speaker is playing, and the room's noise
  // floor. The speaker leaks into the mic by some amount (the "coupling"); that is learned from the last
  // two seconds so the bar sits above it. Speech has to stay above the bar for a while: a duck first
  // (tier 1), then a cut (tier 2); headphones leak almost nothing, so they react sooner.
  class BargeInDetector {
    constructor(options = {}) {
      this.headphones = !!options.headphones;
      this.marginDb = options.marginDb || 0;
      this.reset();
    }

    reset() {
      this.window = [];
      this.sustainedMs = 0;
      this.quietMs = 0;
      this.tier = 0;
    }

    couplingDb() {
      if (this.window.length < 25) return -25; // until learned: assume the speaker leaks 25 dB down
      const sorted = [...this.window].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.75)];
    }

    // The user's own voice must not teach it that the speaker is loud, so only frames that did not
    // beat the bar are used to learn the leak. A leak that does fool it is handled by falseBarge().
    // -> null, 'tier1' or 'tier2' (each at most once per stretch of speech)
    push({ micDb, ttsDb, floorDb, ms }) {
      const threshold = bargeInThresholdDb(floorDb, ttsDb, this.couplingDb()) + this.marginDb;
      const loud = micDb > threshold;
      if (!loud) {
        this.window.push(Math.max(-60, Math.min(20, micDb - ttsDb)));
        if (this.window.length > 100) this.window.shift();
      }
      if (loud) {
        this.sustainedMs += ms;
        this.quietMs = 0;
      } else {
        this.quietMs += ms;
        if (this.quietMs > 60) {
          this.sustainedMs = 0;
          this.tier = 0;
        }
      }
      const t1 = this.headphones ? 200 : 300;
      const t2 = this.headphones ? 400 : 550;
      if (this.tier < 2 && this.sustainedMs >= t2) {
        this.tier = 2;
        return 'tier2';
      }
      if (this.tier < 1 && this.sustainedMs >= t1) {
        this.tier = 1;
        return 'tier1';
      }
      return null;
    }

    // A "barge-in" turned out to be the model hearing itself: ask for 6 dB more next time
    falseBarge() {
      this.marginDb = Math.min(24, this.marginDb + 6);
      this.sustainedMs = 0;
      this.tier = 0;
    }
  }

  // Threshold to beat while the model is speaking, when voice interruption is on:
  // the quieter of "well above the room" and "well above what the speaker leaks into the mic"
  function bargeInThresholdDb(floorDb, ttsLevelDb, couplingDb) {
    return Math.max(floorDb + 15, ttsLevelDb + couplingDb + 10);
  }

  // ---------- Turn state machine ----------

  function initialState(options = {}) {
    return {
      phase: 'IDLE', epoch: 0, turnId: 0, muted: false, ducked: false,
      pending: '', lastUserText: '', sttInFlight: 0, fillerPlayed: false,
      llmDone: false, drained: false, resumePhase: null,
      interruptByVoice: !!options.interruptByVoice
    };
  }

  const fx = (type, extra) => ({ type, ...(extra || {}) });

  // Pure: (state, event) -> { state, effects }. Events carrying `epoch` are dropped when stale.
  function reduce(prev, event) {
    const s = { ...prev };
    const effects = [];
    const type = event.type;
    const stale = typeof event.epoch === 'number' && event.epoch !== s.epoch;
    const done = () => ({ state: s, effects });
    const startTurn = text => {
      s.phase = 'THINKING';
      s.turnId += 1;
      s.lastUserText = text;
      s.pending = '';
      s.llmDone = false;
      s.drained = false;
      s.fillerPlayed = false;
      effects.push(fx('START_LLM', { text, turnId: s.turnId, epoch: s.epoch }));
    };
    const stopOutput = () => {
      effects.push(fx('ABORT_LLM'), fx('CUT_AUDIO'), fx('CLEAR_TTS'));
      s.epoch += 1;
      s.ducked = false;
    };

    if (type === 'END') {
      if (s.phase === 'IDLE') return done();
      if (s.phase === 'THINKING' || s.phase === 'SPEAKING') stopOutput();
      effects.push(fx('COMMIT_SPOKEN'), fx('STOP_MIC'), fx('END_CALL', { reason: event.reason || 'user' }));
      s.epoch += 1;
      s.phase = 'IDLE';
      s.pending = '';
      s.muted = false;
      return done();
    }
    if (type === 'START') {
      if (s.phase !== 'IDLE') return done();
      s.phase = 'LISTENING';
      s.pending = '';
      s.sttInFlight = 0;
      effects.push(fx('START_MIC'), fx('PLAY_CUE', { cue: 'start' }));
      return done();
    }
    if (s.phase === 'IDLE') return done();

    if (type === 'MUTE' || type === 'UNMUTE') {
      const muted = type === 'MUTE';
      if (s.muted === muted) return done();
      s.muted = muted;
      effects.push(fx(muted ? 'MIC_MUTE' : 'MIC_UNMUTE'));
      if (muted && s.phase === 'USER_SPEAKING') {
        effects.push(fx('DISCARD_UTTERANCE'));
        s.phase = s.pending && s.sttInFlight === 0 ? 'THINKING' : s.sttInFlight ? 'TRANSCRIBING' : 'LISTENING';
        if (s.phase === 'THINKING') startTurn(s.pending);
      }
      return done();
    }
    if (type === 'FOCUS_LOST') {
      if (event.permanent) return reduce(prev, { type: 'END', reason: 'focus' });
      if (s.phase !== 'PAUSED') {
        s.resumePhase = s.phase;
        s.phase = 'PAUSED';
        effects.push(fx('PAUSE_ALL'));
      }
      return done();
    }
    if (type === 'FOCUS_GAINED') {
      if (s.phase === 'PAUSED') {
        s.phase = s.resumePhase || 'LISTENING';
        s.resumePhase = null;
        effects.push(fx('RESUME_ALL'));
      }
      return done();
    }
    if (s.phase === 'PAUSED') return done();

    if (type === 'TAP_INTERRUPT') {
      if (s.phase === 'THINKING') {
        stopOutput();
        effects.push(fx('DROP_REPLY'));
        s.phase = 'LISTENING';
      } else if (s.phase === 'SPEAKING') {
        stopOutput();
        effects.push(fx('COMMIT_SPOKEN'));
        s.phase = 'LISTENING';
      } else if (s.phase === 'TRANSCRIBING') {
        s.phase = 'LISTENING';
        s.pending = '';
      }
      return done();
    }

    if (type === 'SPEECH_START') {
      if (s.muted) return done();
      if (s.phase === 'LISTENING') s.phase = 'USER_SPEAKING';
      else if (s.phase === 'TRANSCRIBING') s.phase = 'USER_SPEAKING';
      else if (s.phase === 'THINKING') {
        // spoke again before any audio: fold the new words into the same question
        effects.push(fx('ABORT_LLM'), fx('CLEAR_TTS'), fx('DROP_REPLY'));
        s.epoch += 1;
        s.pending = s.lastUserText;
        s.phase = 'USER_SPEAKING';
      }
      return done();
    }

    if (type === 'SPEECH_END') {
      if (s.phase === 'USER_SPEAKING') {
        if (event.tooShort) {
          effects.push(fx('DISCARD_UTTERANCE'));
          if (s.pending && s.sttInFlight === 0) startTurn(s.pending);
          else s.phase = s.sttInFlight ? 'TRANSCRIBING' : 'LISTENING';
        } else {
          s.phase = 'TRANSCRIBING';
          s.sttInFlight += 1;
          effects.push(fx('SEND_STT', { epoch: s.epoch, purpose: 'turn' }));
        }
      } else if (s.phase === 'SPEAKING' && s.ducked && !event.tooShort) {
        s.sttInFlight += 1;
        effects.push(fx('SEND_STT', { epoch: s.epoch, purpose: 'barge' }));
      }
      return done();
    }

    if (type === 'SPEECH_SUSTAINED') {
      if (s.phase === 'SPEAKING' && s.interruptByVoice) {
        if (event.tier === 1 && !s.ducked) {
          s.ducked = true;
          effects.push(fx('DUCK', { gain: 0.25 }));
        } else if (event.tier === 2) {
          stopOutput();
          effects.push(fx('COMMIT_SPOKEN'), fx('KEEP_BUFFER'));
          s.phase = 'USER_SPEAKING';
        }
      } else if (s.phase === 'THINKING' && event.tier === 2) {
        return reduce(prev, { type: 'SPEECH_START' });
      }
      return done();
    }

    if (type === 'STT_OK' || type === 'STT_EMPTY' || type === 'STT_ERR') {
      if (stale) return done();
      s.sttInFlight = Math.max(0, s.sttInFlight - 1);
      const text = type === 'STT_OK' ? String(event.text || '').trim() : '';
      if (event.purpose === 'barge' || (s.phase === 'SPEAKING' && s.ducked)) {
        if (s.phase !== 'SPEAKING') return done();
        if (!text || isBackchannel(text) || echoSimilarity(text, event.spokenTail || '') > 0.6) {
          s.ducked = false;
          effects.push(fx('UNDUCK', { reason: text && isBackchannel(text) ? 'backchannel' : 'echo' }));
        } else if (isStopCommand(text)) {
          stopOutput();
          effects.push(fx('COMMIT_SPOKEN'));
          s.phase = 'LISTENING';
        } else {
          stopOutput();
          effects.push(fx('COMMIT_SPOKEN'));
          startTurn(text);
        }
        return done();
      }
      if (type === 'STT_ERR') {
        if (s.phase === 'TRANSCRIBING') {
          s.phase = 'LISTENING';
          effects.push(fx('SHOW_NOTICE', { text: event.message || "Couldn't transcribe that." }));
        }
        return done();
      }
      if (s.phase === 'TRANSCRIBING') {
        const full = [s.pending, text].filter(Boolean).join(' ').trim();
        if (full) startTurn(full);
        else s.phase = 'LISTENING';
      } else if (s.phase === 'USER_SPEAKING' && text) {
        s.pending = [s.pending, text].filter(Boolean).join(' ');
      }
      return done();
    }

    if (type === 'LLM_TOOL') {
      if (!stale && s.phase === 'THINKING' && !s.fillerPlayed) {
        s.fillerPlayed = true;
        effects.push(fx('PLAY_FILLER'));
      }
      return done();
    }
    if (type === 'TTS_STARTED') {
      if (!stale && s.phase === 'THINKING') {
        s.phase = 'SPEAKING';
        s.drained = false;
      } else if (!stale && s.phase === 'SPEAKING') s.drained = false;
      return done();
    }
    if (type === 'LLM_DONE') {
      if (stale) return done();
      s.llmDone = true;
      if (s.phase === 'THINKING') s.phase = 'LISTENING'; // nothing to say
      else if (s.phase === 'SPEAKING' && s.drained) {
        s.phase = 'LISTENING';
        effects.push(fx('COMMIT_SPOKEN'));
      }
      return done();
    }
    if (type === 'PLAY_DRAINED') {
      if (stale) return done();
      s.drained = true;
      if (s.phase === 'SPEAKING' && s.llmDone) {
        s.phase = 'LISTENING';
        s.ducked = false;
        effects.push(fx('COMMIT_SPOKEN'));
      }
      return done();
    }
    if (type === 'LLM_ERR') {
      if (stale) return done();
      if (s.phase === 'THINKING' || s.phase === 'SPEAKING') {
        stopOutput();
        effects.push(fx('SHOW_NOTICE', { text: event.message || 'Something went wrong.' }), fx('SPEAK_ERROR'));
        s.phase = 'LISTENING';
      }
      return done();
    }
    if (type === 'SILENCE_TIMEOUT') {
      if (s.phase === 'LISTENING') return reduce(prev, { type: 'END', reason: 'silence' });
      return done();
    }
    return done();
  }

  return {
    MAX_CHUNK, CODE_NOTE,
    cleanForSpeech, SpeechChunker, spokenChars, historyForInterrupted,
    isHallucination, isBackchannel, isStopCommand, echoSimilarity, normalize,
    encodeWav, Vad, frameDb, BargeInDetector, bargeInThresholdDb,
    initialState, reduce
  };
});
