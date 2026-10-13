// Voice chat on the desktop: the runtime around the pure core in voice-chat.js. It owns the microphone
// (AudioWorklet), the speaker (WebAudio, one Groq Orpheus WAV per chunk), the overlay, and the glue to
// the chat engine in renderer.js. A plain script that shares globals with renderer.js and loads after it.
(() => {
  const VC = window.VoiceChat;
  if (!VC) return;
  const $ = id => document.getElementById(id);

  const DEFAULTS = {
    ttsModel: 'canopylabs/orpheus-v1-english', voice: 'autumn', llmModel: '', mode: 'handsfree', interruptByVoice: false, headphones: 'auto',
    endOfSpeechMs: 700, autoEndSec: 120, fallbackTts: true, captions: true, filler: true, speakCapChars: 900
  };
  const settings = () => ({ ...DEFAULTS, ...(state.settings?.voiceChat || {}) });

  // Groq models for a voice turn, in order of preference (Groq retired its fast non-reasoning Llama models in
  // August 2026; a call leaves the reasoning level to Groq, see ignoreEffort in main.js)
  const VOICE_MODEL_PREFERENCE = ['openai/gpt-oss-20b'];

  const VOICE_NOTE = [
    'You are in a live voice conversation: your reply is read aloud.',
    'Answer in short, natural spoken sentences, usually one to three, unless asked for more.',
    'No markdown, lists, tables, headings or emoji. Never read code aloud; say you put it on screen.',
    'Say numbers, dates, units and symbols the way a person would. Do not read out URLs.',
    'For a big topic, give the headline, then ask if they want more.',
    'If you were interrupted, do not repeat what they already heard; respond to what they said next.'
  ].join(' ');

  const LABELS = {
    LISTENING: 'Listening', USER_SPEAKING: 'Listening', TRANSCRIBING: 'Thinking', THINKING: 'Thinking', SPEAKING: 'Speaking', PAUSED: 'Paused', IDLE: ''
  };
  const HINTS = {
    LISTENING: 'Just talk. I\'ll answer when you pause.',
    USER_SPEAKING: 'Go on, I\'m listening.',
    TRANSCRIBING: '',
    THINKING: 'Tap the orb or press Space to stop.',
    SPEAKING: 'Tap the orb or press Space to interrupt.',
    PAUSED: 'Audio paused.'
  };

  let call = null;

  // ---------- Microphone ----------

  async function startCapture(c) {
    c.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 }
    });
    c.ctx = new AudioContext({ sampleRate: 16000 });
    c.vad = new VC.Vad({ sampleRate: c.ctx.sampleRate, hangoverMs: settings().endOfSpeechMs });
    const source = c.ctx.createMediaStreamSource(c.stream);
    try {
      await c.ctx.audioWorklet.addModule('voice-capture-worklet.js');
      c.node = new AudioWorkletNode(c.ctx, 'voice-capture');
      c.node.port.onmessage = e => onFrame(c, e.data);
      source.connect(c.node);
    } catch {
      // The worklet could not load (packaging or policy): fall back to the older main-thread processor
      c.node = c.ctx.createScriptProcessor(2048, 1, 1);
      let carry = [];
      c.node.onaudioprocess = e => {
        const input = e.inputBuffer.getChannelData(0);
        for (let i = 0; i < input.length; i++) {
          const v = Math.max(-1, Math.min(1, input[i]));
          carry.push(v < 0 ? v * 32768 : v * 32767);
          if (carry.length === 320) {
            onFrame(c, Int16Array.from(carry));
            carry = [];
          }
        }
      };
      source.connect(c.node);
      c.node.connect(c.ctx.destination);
    }
  }

  function stopCapture(c) {
    try { c.node?.disconnect(); } catch { /* already gone */ }
    c.stream?.getTracks().forEach(t => t.stop());
    c.ctx?.close().catch(() => {});
    c.node = c.stream = null;
  }

  function onFrame(c, frame) {
    if (call !== c) return;
    const phase = c.S.phase;
    c.micLevel = c.vad.level;
    if (c.muted || phase === 'IDLE' || phase === 'PAUSED') return;
    if (settings().mode === 'push') {
      if (c.ptt?.on) c.ptt.frames.push(frame.slice());
      return;
    }
    if (phase === 'SPEAKING' && settings().interruptByVoice) return onFrameWhileSpeaking(c, frame);
    if (phase === 'SPEAKING') {
      c.skipped = true; // the mic is not listened to while the model talks (it would hear itself)
      return;
    }
    if (c.skipped) {
      c.vad.flush();
      c.skipped = false;
      c.deafUntil = performance.now() + 300; // the speaker's tail still rings in the room
    }
    if (performance.now() < (c.deafUntil || 0)) return;
    for (const ev of c.vad.push(frame)) {
      if (ev.type === 'SPEECH_START') dispatch(c, { type: 'SPEECH_START' });
      else if (ev.type === 'SPEECH_END') {
        if (!ev.tooShort) c.utterances.push({ audio: ev.audio, ms: (ev.audio.length / c.ctx.sampleRate) * 1000 });
        dispatch(c, { type: 'SPEECH_END', tooShort: ev.tooShort });
      }
    }
  }

  // Interrupt by speaking: watch for you talking over the model. Speech must stay above an echo-aware bar
  // (VoiceChat.BargeInDetector): first the model ducks, then it is cut. The VAD keeps recording so the
  // words can be transcribed and judged ("mm-hmm" and "stop" are not new questions).
  function onFrameWhileSpeaking(c, frame) {
    const ms = (frame.length / c.ctx.sampleRate) * 1000;
    const tier = c.barge.push({ micDb: VC.frameDb(frame), ttsDb: c.player.levelDb(), floorDb: c.vad.floor, ms });
    if (tier === 'tier1') dispatch(c, { type: 'SPEECH_SUSTAINED', tier: 1 });
    else if (tier === 'tier2') dispatch(c, { type: 'SPEECH_SUSTAINED', tier: 2 });
    if (c.S.phase !== 'SPEAKING' && c.S.phase !== 'USER_SPEAKING') return;
    for (const ev of c.vad.push(frame)) {
      if (ev.type !== 'SPEECH_END') continue;
      if (c.S.phase === 'SPEAKING' && c.S.ducked && !ev.tooShort) {
        c.utterances.push({ audio: ev.audio, ms: (ev.audio.length / c.ctx.sampleRate) * 1000 });
        dispatch(c, { type: 'SPEECH_END', tooShort: false });
      } else if (c.S.phase === 'USER_SPEAKING') {
        if (!ev.tooShort) c.utterances.push({ audio: ev.audio, ms: (ev.audio.length / c.ctx.sampleRate) * 1000 });
        dispatch(c, { type: 'SPEECH_END', tooShort: ev.tooShort });
      }
    }
  }

  // Are the speakers headphones? The default output device's name is the best hint the browser gives.
  async function detectHeadphones() {
    const setting = settings().headphones;
    if (setting === 'on') return true;
    if (setting === 'off') return false;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const out = devices.find(d => d.kind === 'audiooutput' && d.deviceId === 'default') || devices.find(d => d.kind === 'audiooutput');
      return /head(phone|set)|airpods|earbud|buds|earphone|bluetooth|hands-?free/i.test(out?.label || '');
    } catch {
      return false;
    }
  }

  // ---------- Speaker ----------

  class Player {
    constructor(c) {
      this.c = c;
      this.items = [];
      this.nextIndex = 0;
      this.nextStart = 0;
      this.fetching = 0;
      this.synthBusy = false;
      this.fallbackUntil = 0;
      this.lastCut = null;
      this.sources = new Set();
      this.drainedSent = true;
    }

    get ctx() {
      if (!this._ctx) {
        this._ctx = new AudioContext();
        this.gain = this._ctx.createGain();
        this.analyser = this._ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.gain.connect(this.analyser);
        this.analyser.connect(this._ctx.destination);
      }
      return this._ctx;
    }

    level() {
      if (!this.analyser || !this.sources.size) return 0;
      const buf = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / buf.length) * 3);
    }

    levelDb() {
      if (!this.analyser || !this.sources.size) return -100;
      const buf = new Float32Array(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return 20 * Math.log10(Math.max(Math.sqrt(sum / buf.length), 1e-7));
    }

    // Quieter while you might be interrupting (a quick ramp, not a jump)
    duck(gain) {
      if (!this._ctx) return;
      const now = this._ctx.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(this.gain.gain.value, now);
      this.gain.gain.linearRampToValueAtTime(gain, now + 0.04);
    }

    add(chunk) {
      const item = { id: `tts-${call?.id}-${this.nextIndex}`, index: this.nextIndex++, text: chunk.text, rawStart: chunk.rawStart, rawEnd: chunk.rawEnd, status: 'pending', played: false };
      if (chunk.synth) item.status = 'synth';
      this.items.push(item);
      this.drainedSent = false;
      this.c.dispatchTtsQueued();
      this.fetchMore();
    }

    useSynth() {
      return settings().fallbackTts && performance.now() < this.fallbackUntil;
    }

    fetchMore() {
      for (const item of this.items) {
        if (item.status !== 'pending') continue;
        if (this.fetching >= 2) break;
        if (this.useSynth()) {
          item.status = 'synth';
          continue;
        }
        this.fetching++;
        item.status = 'fetching';
        this.fetchItem(item);
      }
      this.pump();
    }

    async fetchItem(item) {
      const s = settings();
      try {
        const res = await api.speak({ id: item.id, text: item.text, voice: s.voice, model: s.ttsModel });
        if (item.status === 'cancelled') return;
        if (!res.ok) throw Object.assign(new Error(res.message || 'Speech failed'), { status: res.status, aborted: res.aborted, retryAfter: res.retryAfter });
        const copy = res.bytes.buffer.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength);
        item.buffer = await this.ctx.decodeAudioData(copy);
        item.status = 'ready';
      } catch (err) {
        if (item.status === 'cancelled' || err.aborted) return;
        // Orpheus is a preview model with tight limits: fall back to the system voice for a minute
        if (s.fallbackTts) {
          this.fallbackUntil = performance.now() + (err.status === 429 ? Math.max(60, err.retryAfter || 0) * 1000 : 60000);
          item.status = 'synth';
          if (!this.warned) {
            this.warned = true;
            toast(err.status === 429 ? 'Groq speech is rate limited, using the system voice for a bit' : `Speech unavailable (${err.message}), using the system voice`, { kind: 'warn' });
          }
        } else {
          item.status = 'failed';
          toast(`Speech failed: ${err.message}`, { kind: 'error' });
        }
      } finally {
        this.fetching = Math.max(0, this.fetching - 1);
        this.fetchMore();
      }
    }

    // Plays items strictly in order: WAV chunks are scheduled back to back on the audio clock so
    // there is no gap; a system-voice chunk waits for the audio before it, then speaks
    pump() {
      if (this.synthBusy) return;
      for (const item of this.items) {
        if (item.scheduled || item.status === 'cancelled') continue;
        if (item.status === 'failed') {
          item.scheduled = item.played = true;
          continue;
        }
        if (item.status === 'ready') this.schedule(item);
        else if (item.status === 'synth') {
          this.speakSynth(item);
          return;
        } else break; // pending or still fetching: wait, order matters
      }
      this.checkDrained();
    }

    schedule(item) {
      const ctx = this.ctx;
      if (ctx.state === 'suspended') ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = item.buffer;
      src.connect(this.gain);
      const start = Math.max(ctx.currentTime + 0.03, this.nextStart);
      src.start(start);
      item.scheduled = true;
      item.start = start;
      item.end = start + item.buffer.duration;
      this.nextStart = item.end;
      this.sources.add(src);
      src.onended = () => {
        this.sources.delete(src);
        item.played = true;
        this.checkDrained();
      };
    }

    speakSynth(item) {
      item.scheduled = true;
      this.synthBusy = true;
      const wait = Math.max(0, (this.nextStart - (this._ctx ? this._ctx.currentTime : 0)) * 1000);
      item.synthStarted = performance.now() + wait;
      item.timer = setTimeout(() => {
        const u = new SpeechSynthesisUtterance(item.text);
        const done = () => {
          this.synthBusy = false;
          item.played = true;
          this.nextStart = this._ctx ? this._ctx.currentTime : 0;
          this.pump();
        };
        u.onend = done;
        u.onerror = done;
        item.utterance = u;
        speechSynthesis.speak(u);
      }, wait);
    }

    checkDrained() {
      if (this.drainedSent) return;
      if (this.items.every(i => i.played || i.status === 'cancelled') && this.fetching === 0 && !this.synthBusy) {
        this.drainedSent = true;
        this.c.dispatchDrained();
      }
    }

    // Where playback is right now, as { index, fraction } of the chunk being heard
    position() {
      const ctx = this._ctx;
      if (!ctx) return null;
      const t = ctx.currentTime - (ctx.outputLatency || 0);
      for (const item of this.items) {
        if (item.start == null || item.played) continue;
        const at = fraction => ({ index: item.index, rawStart: item.rawStart, rawEnd: item.rawEnd, fraction });
        if (t >= item.start && t < item.end) return at((t - item.start) / (item.end - item.start));
        if (t < item.start) return at(0);
      }
      const last = [...this.items].reverse().find(i => i.played);
      return last ? { index: last.index, rawStart: last.rawStart, rawEnd: last.rawEnd, fraction: 1 } : null;
    }

    allSpoken() {
      return this.items.length > 0 && this.items.every(i => i.played);
    }

    // Stops speaking now: a quick fade, then silence. Remembers where it stopped.
    cut() {
      this.lastCut = this.allSpoken() ? null : this.position();
      for (const item of this.items) {
        if (!item.played) item.status = 'cancelled';
        clearTimeout(item.timer);
      }
      try { speechSynthesis.cancel(); } catch { /* none */ }
      api.speakCancel();
      this.synthBusy = false;
      if (this._ctx && this.sources.size) {
        const now = this._ctx.currentTime;
        this.gain.gain.cancelScheduledValues(now);
        this.gain.gain.setValueAtTime(this.gain.gain.value, now);
        this.gain.gain.linearRampToValueAtTime(0, now + 0.07);
        const doomed = [...this.sources];
        setTimeout(() => {
          doomed.forEach(s => { try { s.stop(); } catch { /* ended */ } });
          if (this.gain) this.gain.gain.value = 1;
        }, 90);
        this.sources.clear();
      }
      this.fetching = 0;
      this.nextStart = 0;
      this.drainedSent = true;
    }

    clear() {
      this.items = this.items.filter(i => i.played);
    }

    close() {
      this.cut();
      this._ctx?.close().catch(() => {});
    }
  }

  // ---------- The call ----------

  let nextCallId = 1;
  function dispatch(c, event) {
    if (call !== c) return;
    c.queue.push(event);
    if (c.running) return;
    c.running = true;
    try {
      while (c.queue.length) {
        const ev = c.queue.shift();
        const before = c.S.phase;
        const result = VC.reduce(c.S, ev);
        c.S = result.state;
        if (before === 'SPEAKING' && c.S.phase !== 'SPEAKING' && c.S.phase !== 'USER_SPEAKING') {
          c.vad?.flush();
          c.barge?.reset();
          c.deafUntil = performance.now() + 300;
        }
        if (c.S.phase === 'SPEAKING' && before !== 'SPEAKING') c.barge?.reset();
        if (c.S.phase !== 'LISTENING') c.lastActivity = performance.now();
        for (const effect of result.effects) run(c, effect);
        render(c);
      }
    } finally {
      c.running = false;
    }
  }

  function rawReply(c) {
    return c.reply?.msg?.content || '';
  }

  function addChunks(c, chunks) {
    for (const chunk of chunks) {
      if (c.capped) return;
      c.chunks.push(chunk);
      c.spokenTotal += chunk.text.length;
      c.player.add(chunk);
      if (c.spokenTotal >= settings().speakCapChars && c.S.phase !== 'IDLE') {
        c.capped = true;
        c.player.add({ text: 'I can keep going. Just say continue.', rawStart: chunk.rawEnd, rawEnd: chunk.rawEnd });
      }
    }
  }

  function startLlm(c, effect) {
    const text = effect.text;
    c.chunker = new VC.SpeechChunker();
    c.chunks = [];
    c.spokenTotal = 0;
    c.capped = false;
    c.player.lastCut = null;
    c.player.items = [];
    c.player.nextIndex = 0;
    c.replyEpoch = effect.epoch;
    c.captionUser = text;
    const chat = activeChat();
    const prev = c.lastTurn;
    if (c.mergeFold && prev && chat && chat.id === prev.chatId && text.startsWith(prev.text)) {
      // They spoke again before any answer: one question, not two
      const node = conversationHistory.node(chat, prev.userNodeId);
      if (node) {
        node.content = text;
        startAssistantReply(chat, { replyToNodeId: prev.userNodeId });
      } else sendMessage(text, [], c.tool);
    } else sendMessage(text, [], c.tool);
    c.mergeFold = false;
    const s = state.streaming;
    const chatNow = activeChat();
    if (!s) return;
    c.reply = { requestId: s.requestId, msg: s.msg, chat: chatNow };
    c.lastTurn = { chatId: chatNow.id, userNodeId: chatNow.messages[s.index - 1]?.nodeId, text };
  }

  function run(c, effect) {
    switch (effect.type) {
      case 'START_MIC':
        break; // started before the first event
      case 'STOP_MIC':
        stopCapture(c);
        break;
      case 'MIC_MUTE':
        c.muted = true;
        c.stream?.getAudioTracks().forEach(t => { t.enabled = false; });
        break;
      case 'MIC_UNMUTE':
        c.muted = false;
        c.stream?.getAudioTracks().forEach(t => { t.enabled = true; });
        break;
      case 'DISCARD_UTTERANCE':
        c.vad?.flush();
        break;
      case 'SEND_STT':
        transcribeNext(c, effect);
        break;
      case 'START_LLM':
        startLlm(c, effect);
        break;
      case 'ABORT_LLM':
        if (c.reply && state.streaming?.requestId === c.reply.requestId) stopStreaming();
        c.reply = c.reply ? { ...c.reply, aborted: true } : null;
        break;
      case 'DROP_REPLY':
        c.mergeFold = true;
        break;
      case 'CUT_AUDIO':
        c.player.cut();
        break;
      case 'CLEAR_TTS':
        c.player.clear();
        break;
      case 'COMMIT_SPOKEN':
        commitSpoken(c);
        break;
      case 'PLAY_FILLER':
        if (settings().filler) c.player.add({ text: 'Let me look that up.', rawStart: 0, rawEnd: 0, filler: true });
        break;
      case 'SHOW_NOTICE':
        toast(effect.text, { kind: 'warn' });
        break;
      case 'SPEAK_ERROR':
        try { speechSynthesis.speak(new SpeechSynthesisUtterance('Sorry, something went wrong.')); } catch { /* no voice */ }
        break;
      case 'PAUSE_ALL':
        c.player._ctx?.suspend();
        break;
      case 'RESUME_ALL':
        c.player._ctx?.resume();
        break;
      case 'END_CALL':
        finish(c);
        break;
      case 'DUCK':
        c.player.duck(effect.gain);
        break;
      case 'UNDUCK':
        c.player.duck(1);
        // The model heard itself (or the mic did): be less touchy next time, and say how to avoid it
        if (effect.reason === 'echo') {
          c.barge.falseBarge();
          c.falseBarges = (c.falseBarges || 0) + 1;
          if (c.falseBarges === 2 && !c.headphones) toast('The mic keeps hearing the speakers. Headphones work best for interrupting by voice.', { kind: 'info' });
        }
        break;
      default:
        break; // PLAY_CUE, KEEP_BUFFER: nothing to do (the VAD keeps its buffer)
    }
  }

  // The reply the user did not finish hearing keeps how far they got, so the model can be told
  function commitSpoken(c) {
    const msg = c.reply?.msg;
    if (!msg || !c.player.lastCut) return;
    const raw = msg.content || '';
    const cut = c.player.lastCut;
    const spoken = VC.spokenChars(raw, [{ rawStart: cut.rawStart, rawEnd: cut.rawEnd }], 0, cut.fraction);
    if (spoken < raw.length) {
      msg.spokenChars = spoken;
      msg.interrupted = true;
      persistChats();
    }
    c.player.lastCut = null;
  }

  async function transcribeNext(c, effect) {
    const utter = c.utterances.shift();
    if (!utter) return dispatch(c, { type: 'STT_EMPTY', epoch: effect.epoch, purpose: effect.purpose });
    c.sttMs += Math.max(10000, utter.ms); // Groq bills at least 10 seconds per request
    try {
      const wav = VC.encodeWav(utter.audio, c.ctx?.sampleRate || 16000);
      const result = await api.transcribeVerbose(wav, 'audio/wav');
      if (call !== c) return;
      if (!result.text || VC.isHallucination(result, utter.ms)) return dispatch(c, { type: 'STT_EMPTY', epoch: effect.epoch, purpose: effect.purpose });
      c.captionUser = result.text;
      dispatch(c, { type: 'STT_OK', text: result.text, epoch: effect.epoch, purpose: effect.purpose, spokenTail: c.chunks.slice(-3).map(x => x.text).join(' ') });
    } catch (err) {
      if (call === c) dispatch(c, { type: 'STT_ERR', epoch: effect.epoch, purpose: effect.purpose, message: cleanError(err) });
    }
  }

  // ---------- Events from the chat engine ----------

  function onDelta(requestId, msg) {
    const c = call;
    if (!c || c.reply?.requestId !== requestId || c.reply.aborted) return;
    addChunks(c, c.chunker.push(msg.content || ''));
    c.captionModel = answerText(msg.content || '');
  }

  function onTool(requestId) {
    const c = call;
    if (!c || c.reply?.requestId !== requestId || c.reply.aborted) return;
    dispatch(c, { type: 'LLM_TOOL', epoch: c.replyEpoch });
  }

  function onDone(requestId, finishReason) {
    const c = call;
    if (!c || c.reply?.requestId !== requestId || c.reply.aborted) return;
    if (finishReason === 'stopped') return;
    addChunks(c, c.chunker.push(c.reply.msg.content || '', true));
    c.captionModel = answerText(c.reply.msg.content || '');
    dispatch(c, { type: 'LLM_DONE', epoch: c.replyEpoch });
  }

  function onError(requestId, message) {
    const c = call;
    if (!c || c.reply?.requestId !== requestId || c.reply.aborted) return;
    dispatch(c, { type: 'LLM_ERR', epoch: c.replyEpoch, message });
  }

  // ---------- Overlay ----------

  const overlay = () => $('voice-overlay');

  function render(c) {
    const o = overlay();
    if (!o || call !== c) return;
    const phase = c.S.phase;
    for (const name of Object.keys(LABELS)) o.classList.toggle(`is-${name.toLowerCase()}`, phase === name);
    o.classList.toggle('is-muted', c.muted);
    $('voice-state').textContent = c.muted && (phase === 'LISTENING' || phase === 'USER_SPEAKING') ? 'Muted' : LABELS[phase];
    $('voice-hint').textContent = c.muted ? 'Mic is muted.' : HINTS[phase] || '';
    $('voice-mute').setAttribute('aria-pressed', String(c.muted));
    $('voice-mute').textContent = c.muted ? 'Unmute' : 'Mute';
    $('voice-interrupt').disabled = phase !== 'THINKING' && phase !== 'SPEAKING';
    $('voice-web').setAttribute('aria-pressed', String(c.tool === 'web'));
    $('voice-code').setAttribute('aria-pressed', String(c.tool === 'code'));
    const captions = settings().captions;
    o.classList.toggle('no-captions', !captions);
    $('cap-user').textContent = c.captionUser || '';
    setModelCaption(c);
  }

  // The model's words, with what has been spoken so far in full strength and the rest dimmed
  function setModelCaption(c) {
    const box = $('cap-model');
    const text = c.captionModel || '';
    const heard = c.S.phase === 'SPEAKING' ? Math.min(c.captionHeard || 0, text.length) : 0;
    const key = text.length + ':' + heard + ':' + (c.S.phase === 'SPEAKING');
    if (c.captionKey === key) return;
    c.captionKey = key;
    box.textContent = '';
    if (!heard || heard >= text.length) {
      box.textContent = text;
      return;
    }
    const a = document.createElement('span');
    a.textContent = text.slice(0, heard);
    const b = document.createElement('span');
    b.className = 'cap-rest';
    b.textContent = text.slice(heard);
    box.append(a, b);
  }

  function animate(c) {
    if (call !== c) return;
    const phase = c.S.phase;
    let level = 0;
    if (phase === 'SPEAKING') level = c.player.level();
    else if (phase === 'LISTENING' || phase === 'USER_SPEAKING') level = c.muted ? 0 : Math.max(0, Math.min(1, (c.micLevel + 60) / 45));
    c.smooth = (c.smooth || 0) * 0.7 + level * 0.3;
    const now = performance.now();
    if (phase === 'SPEAKING' && now - (c.capAt || 0) > 120) {
      c.capAt = now;
      const pos = c.player.position();
      const raw = rawReply(c);
      if (pos && raw) {
        const spokenRaw = VC.spokenChars(raw, [{ rawStart: pos.rawStart, rawEnd: pos.rawEnd }], 0, pos.fraction);
        const heard = answerText(raw.slice(0, spokenRaw));
        if (answerText(raw).startsWith(heard)) {
          c.captionHeard = heard.length;
          setModelCaption(c);
        }
      }
    }
    const o = overlay();
    if (o) o.style.setProperty('--level', c.smooth.toFixed(3));
    c.raf = requestAnimationFrame(() => animate(c));
  }

  // ---------- Start and end ----------

  async function start() {
    if (call) return;
    if (!state.settings?.hasKey) {
      toast('Add your Groq API key in Settings first', { kind: 'warn' });
      return;
    }
    if (!window.AudioContext || !navigator.mediaDevices?.getUserMedia) {
      toast('Voice chat needs microphone access, which this window does not have', { kind: 'error' });
      return;
    }
    if (state.streaming) stopStreaming();
    const c = {
      id: nextCallId++, S: VC.initialState({ interruptByVoice: settings().interruptByVoice }), queue: [], running: false, muted: false,
      utterances: [], chunks: [], spokenTotal: 0, sttMs: 0, startedAt: Date.now(), lastActivity: performance.now(), tool: null,
      captionUser: '', captionModel: '', micLevel: -100
    };
    c.player = new Player(c);
    c.barge = new VC.BargeInDetector({});
    c.dispatchTtsQueued = () => dispatch(c, { type: 'TTS_STARTED', epoch: c.replyEpoch });
    c.dispatchDrained = () => dispatch(c, { type: 'PLAY_DRAINED', epoch: c.replyEpoch });
    call = c;
    state.voiceCall = c;
    document.body.classList.add('voice-active');
    overlay().hidden = false;
    $('voice-model').textContent = modelFor(null) ? (state.models.find(m => m.id === modelFor(null))?.name || modelFor(null)) : '';
    try {
      await startCapture(c);
    } catch (err) {
      toast(err?.name === 'NotAllowedError' ? 'Microphone access was blocked' : `Could not start the microphone: ${cleanError(err)}`, { kind: 'error' });
      finish(c);
      return;
    }
    c.headphones = await detectHeadphones();
    c.barge.headphones = c.headphones;
    c.player.ctx; // create the output context inside this user gesture so it may play
    dispatch(c, { type: 'START' });
    animate(c);
    c.silenceTimer = setInterval(() => {
      const limit = settings().autoEndSec * 1000;
      if (limit && c.S.phase === 'LISTENING' && performance.now() - c.lastActivity > limit) {
        toast('Voice chat ended after a long silence', { kind: 'info' });
        dispatch(c, { type: 'SILENCE_TIMEOUT' });
      }
    }, 1000);
    overlay().focus();
  }

  function finish(c) {
    if (call !== c) return;
    clearInterval(c.silenceTimer);
    cancelAnimationFrame(c.raf);
    stopCapture(c);
    c.player.close();
    call = null;
    state.voiceCall = null;
    document.body.classList.remove('voice-active');
    const o = overlay();
    o.hidden = true;
    o.className = 'voice-overlay';
    const minutes = Math.max(1, Math.round((Date.now() - c.startedAt) / 60000));
    if (c.sttMs > 0) {
      const cost = (c.sttMs / 3600000) * 0.04 + (c.spokenTotal / 1e6) * 22;
      el.hint.textContent = `Voice chat: ${minutes} min, about $${cost < 0.01 ? '0.01' : cost.toFixed(2)} of Groq speech`;
    }
    updateComposerState();
    el.prompt.focus();
  }

  function end() {
    if (call) dispatch(call, { type: 'END' });
  }

  // Push to talk: hold Space (or the orb) to speak; letting go sends it. Starting to talk cuts the model off.
  function pttStart() {
    const c = call;
    if (!c || c.ptt?.on || c.muted) return;
    if (c.S.phase === 'THINKING' || c.S.phase === 'SPEAKING') dispatch(c, { type: 'TAP_INTERRUPT' });
    c.ptt = { on: true, frames: [] };
    dispatch(c, { type: 'SPEECH_START' });
  }

  function pttEnd() {
    const c = call;
    if (!c || !c.ptt?.on) return;
    const frames = c.ptt.frames;
    c.ptt = null;
    const total = frames.reduce((n, f) => n + f.length, 0);
    const audio = new Int16Array(total);
    let at = 0;
    for (const f of frames) {
      audio.set(f, at);
      at += f.length;
    }
    const ms = (total / (c.ctx?.sampleRate || 16000)) * 1000;
    const tooShort = ms < 250;
    if (!tooShort) c.utterances.push({ audio, ms });
    dispatch(c, { type: 'SPEECH_END', tooShort });
  }

  function interrupt() {
    if (call) dispatch(call, { type: 'TAP_INTERRUPT' });
  }

  function toggleMute() {
    if (call) dispatch(call, { type: call.muted ? 'UNMUTE' : 'MUTE' });
  }

  function setTool(name) {
    if (!call) return;
    call.tool = call.tool === name ? null : name;
    render(call);
  }

  // The model that answers a voice turn: your pick, else the fastest one that doesn't reason
  function modelFor(tool) {
    const ids = (state.models || []).map(m => m.id);
    const chosen = settings().llmModel;
    let id = ids.includes(chosen) ? chosen : VOICE_MODEL_PREFERENCE.find(m => ids.includes(m)) || state.settings.model;
    if (tool && !supportsTools(id)) id = TOOL_MODEL;
    return id;
  }

  // ---------- Wiring ----------

  window.VoiceUI = { start, end, interrupt, toggle: () => (call ? end() : start()), isActive: () => !!call, modelFor, systemNote: () => VOICE_NOTE, onDelta, onTool, onDone, onError };

  $('voice-chat-btn')?.addEventListener('click', () => window.VoiceUI.toggle());
  $('voice-orb').addEventListener('click', () => { if (settings().mode !== 'push') interrupt(); });
  $('voice-orb').addEventListener('pointerdown', () => { if (settings().mode === 'push') pttStart(); });
  addEventListener('pointerup', () => { if (settings().mode === 'push') pttEnd(); });
  $('voice-interrupt').addEventListener('click', interrupt);
  $('voice-mute').addEventListener('click', toggleMute);
  $('voice-end').addEventListener('click', end);
  $('voice-web').addEventListener('click', () => setTool('web'));
  $('voice-code').addEventListener('click', () => setTool('code'));

  // Capture phase, so Esc and Space belong to the call while it is open
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      window.VoiceUI.toggle();
      return;
    }
    if (!call) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (call.S.phase === 'THINKING' || call.S.phase === 'SPEAKING') interrupt();
      else end();
    } else if ((e.key === ' ' || e.code === 'Space') && !typing) {
      e.preventDefault();
      e.stopPropagation();
      if (settings().mode === 'push') {
        if (!e.repeat) pttStart();
      } else interrupt();
    } else if (e.key.toLowerCase() === 'm' && !typing && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      toggleMute();
    }
  }, true);

  document.addEventListener('keyup', e => {
    if (call && (e.key === ' ' || e.code === 'Space') && settings().mode === 'push') {
      e.preventDefault();
      pttEnd();
    }
  }, true);

  addEventListener('beforeunload', () => { if (call) finish(call); });

  // ---------- Settings page ----------

  const pickers = {};
  const saveVoice = patch => saveSetting({ voiceChat: { ...settings(), ...patch } });

  function dropdown(slotId, key, options, parse = v => v) {
    const picker = createDropdown({ options, onChange: v => saveVoice({ [key]: parse(v) }) });
    $(slotId).appendChild(picker.el);
    pickers[key] = picker;
  }

  function toggle(id, key) {
    $(id).addEventListener('click', () => saveVoice({ [key]: !settings()[key] }).then(syncSettings));
  }

  function buildSettings() {
    if (pickers.voice) return;
    const voices = [['autumn', 'Autumn', 'Warm, female'], ['diana', 'Diana', 'Clear, female'], ['hannah', 'Hannah', 'Bright, female'], ['austin', 'Austin', 'Relaxed, male'], ['daniel', 'Daniel', 'Steady, male'], ['troy', 'Troy', 'Deep, male']];
    dropdown('vc-voice-dropdown', 'voice', voices.map(([value, label, description]) => ({ value, label, description })));
    dropdown('vc-llm-dropdown', 'llmModel', [{ value: '', label: 'Automatic', description: 'The fastest model that answers without a reasoning phase' }]);
    dropdown('vc-mode-dropdown', 'mode', [
      { value: 'handsfree', label: 'Hands-free', description: 'Boltchat listens for you to speak and pause' },
      { value: 'push', label: 'Push to talk', description: 'Hold Space or the orb while you speak' }
    ]);
    dropdown('vc-headphones-dropdown', 'headphones', [
      { value: 'auto', label: 'Automatic' }, { value: 'on', label: 'I am wearing headphones' }, { value: 'off', label: 'I am using speakers' }
    ]);
    dropdown('vc-pause-dropdown', 'endOfSpeechMs', [
      { value: '500', label: 'Quick', hint: '0.5 s' }, { value: '700', label: 'Normal', hint: '0.7 s' }, { value: '1000', label: 'Patient', hint: '1 s' }
    ], Number);
    dropdown('vc-cap-dropdown', 'speakCapChars', [
      { value: '500', label: 'Short', hint: 'about half a minute' }, { value: '900', label: 'Normal', hint: 'about a minute' }, { value: '2000', label: 'Long', hint: 'about two minutes' }, { value: '5000', label: 'No limit' }
    ], Number);
    dropdown('vc-autoend-dropdown', 'autoEndSec', [
      { value: '60', label: '1 minute' }, { value: '120', label: '2 minutes' }, { value: '300', label: '5 minutes' }, { value: '0', label: 'Never' }
    ], Number);
    toggle('vc-interrupt-switch', 'interruptByVoice');
    toggle('vc-captions-switch', 'captions');
    toggle('vc-filler-switch', 'filler');
    toggle('vc-fallback-switch', 'fallbackTts');
  }

  function syncSettings() {
    const v = settings();
    pickers.voice.setValue(v.voice);
    pickers.mode.setValue(v.mode);
    pickers.headphones.setValue(v.headphones || 'auto');
    pickers.endOfSpeechMs.setValue(String(v.endOfSpeechMs));
    pickers.speakCapChars.setValue(String(v.speakCapChars));
    pickers.autoEndSec.setValue(String(v.autoEndSec));
    for (const [id, key] of [['vc-interrupt-switch', 'interruptByVoice'], ['vc-captions-switch', 'captions'], ['vc-filler-switch', 'filler'], ['vc-fallback-switch', 'fallbackTts']]) {
      $(id).setAttribute('aria-checked', String(!!v[key]));
    }
    // The model list follows what the account offers
    const options = [{ value: '', label: 'Automatic', description: 'The fastest model that answers without a reasoning phase' }]
      .concat((state.models || []).map(m => ({ value: m.id, label: m.name || m.id })));
    if (pickers.llmModel.setOptions) pickers.llmModel.setOptions(options);
    pickers.llmModel.setValue(v.llmModel || '');
  }

  window.renderVoiceChatSettings = () => {
    buildSettings();
    syncSettings();
  };
})();
