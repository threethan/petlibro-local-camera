class PetlibroTalkPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new ArrayBuffer(2048 * 2);
    this.view = new DataView(this.buffer);
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.view.setInt16(this.offset * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
      if (++this.offset === 2048) {
        this.port.postMessage(this.buffer, [this.buffer]);
        this.buffer = new ArrayBuffer(2048 * 2);
        this.view = new DataView(this.buffer);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("petlibro-talk-pcm", PetlibroTalkPCM);
