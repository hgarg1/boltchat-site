// Runs inside the audio thread for voice chat: regroups the microphone's 128-sample blocks into
// 20 ms frames (320 samples at the 16 kHz context rate) and hands them to the page as Int16.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(320);
    this.fill = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const v = Math.max(-1, Math.min(1, channel[i]));
      this.frame[this.fill++] = v < 0 ? v * 32768 : v * 32767;
      if (this.fill === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Int16Array(320);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
