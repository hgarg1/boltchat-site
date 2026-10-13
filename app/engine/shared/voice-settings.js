// Defaults and validation for the voice-chat block of settings.json. Shared by main.js (which loads and
// saves it) and the tests; the Android app keeps the same keys in VoiceChatSettings (SettingsStore.kt).
// Shared with the Windows app, where this file is src/voice-settings.js.
Boltchat.define('voice-settings', function (require, module, exports) {
  const TTS_MODELS = ['canopylabs/orpheus-v1-english', 'canopylabs/orpheus-arabic-saudi'];
  const TTS_VOICES = ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'];

  // Interrupting by voice is opt-in: on speakers the mic can hear the model, so by default you
  // interrupt with a tap, Space or Esc
  const DEFAULTS = {
    ttsModel: TTS_MODELS[0],
    voice: 'autumn',
    llmModel: '',
    mode: 'handsfree',
    interruptByVoice: false,
    headphones: 'auto',
    endOfSpeechMs: 700,
    autoEndSec: 120,
    fallbackTts: true,
    captions: true,
    filler: true,
    speakCapChars: 900
  };

  const clampNumber = (value, min, max, fallback) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Math.min(max, Math.max(min, Number(value))) : fallback);

  // Validates the block whenever it is loaded or saved: anything unknown or out of range falls back
  function clean(v) {
    v = v && typeof v === 'object' ? v : {};
    const d = DEFAULTS;
    return {
      ttsModel: TTS_MODELS.includes(v.ttsModel) ? v.ttsModel : d.ttsModel,
      voice: TTS_VOICES.includes(v.voice) ? v.voice : d.voice,
      llmModel: typeof v.llmModel === 'string' ? v.llmModel : d.llmModel,
      mode: v.mode === 'push' ? 'push' : 'handsfree',
      interruptByVoice: !!v.interruptByVoice,
      headphones: ['auto', 'on', 'off'].includes(v.headphones) ? v.headphones : d.headphones,
      endOfSpeechMs: clampNumber(v.endOfSpeechMs, 500, 1200, d.endOfSpeechMs),
      autoEndSec: clampNumber(v.autoEndSec, 0, 3600, d.autoEndSec),
      fallbackTts: v.fallbackTts !== false,
      captions: v.captions !== false,
      filler: v.filler !== false,
      speakCapChars: clampNumber(v.speakCapChars, 200, 5000, d.speakCapChars)
    };
  }

  module.exports = { TTS_MODELS, TTS_VOICES, DEFAULTS, clean };
});
