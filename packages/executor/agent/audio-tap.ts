// The page audio tap of a recording with `audio: true`. Both functions run in the page's main world,
// injected as their own source, so they use nothing from this module. Everything the page plays
// is mixed into one recorder AudioContext and sent to the executor as s16le stereo 48 kHz PCM,
// base64 in a CDP binding; silent chunks are skipped, the executor fills gaps with silence.
//
//   <audio>/<video> -- captureStream() -- gain(volume, muted) --+
//       DRM (EME): captureStream throws -- createMediaElementSource
//   page AudioContext -- node.connect(destination) also feeds --+
//       a MediaStreamAudioDestination of that context              v
//                       recorder context: mix -- ScriptProcessor -- binding
//
// The binding payload is shaped like a Playwright binding call ({ name, seq, serializedArgs }),
// because every Playwright client on the tab parses Runtime.bindingCalled payloads; an unknown
// name leaves them alone. Audio of out-of-process frames, and a graph wired before the tap
// started, are not captured.
//
// Adapted from MIT-licensed code by Tommy D. Rossi (THIRD_PARTY_NOTICES.md).

export function startAudioTap(bindingName: string): void {
  type Tap = { subscribers: Set<string>; teardown: () => void };
  const global = globalThis as typeof globalThis & { __ndsAudioTap?: Tap; [key: string]: unknown };
  if (window !== window.top) return;
  if (global.__ndsAudioTap) {
    global.__ndsAudioTap.subscribers.add(bindingName);
    return;
  }
  const Native = window.AudioContext;
  if (!Native) return;
  const subscribers = new Set([bindingName]);
  type Connect = (this: AudioNode, destination: AudioNode, output?: number) => AudioNode;
  type Disconnect = (this: AudioNode, destination?: AudioNode) => void;
  const nativeConnect = AudioNode.prototype.connect;
  const nativeDisconnect = AudioNode.prototype.disconnect;
  const connectOriginal = nativeConnect as Connect;
  const disconnectOriginal = nativeDisconnect as Disconnect;
  const playOriginal = HTMLMediaElement.prototype.play;
  const join = (from: AudioNode, to: AudioNode) => {
    connectOriginal.call(from, to);
  };
  const recorder = new Native({ sampleRate: 48000 });
  const mix = recorder.createGain();
  const processor = recorder.createScriptProcessor(4096, 2, 2);
  const mute = recorder.createGain();
  mute.gain.value = 0;
  join(mix, processor);
  join(processor, mute);
  join(mute, recorder.destination);
  processor.onaudioprocess = (event) => {
    const left = event.inputBuffer.getChannelData(0);
    const right = event.inputBuffer.getChannelData(1);
    const pcm = new Int16Array(left.length * 2);
    let silent = true;
    for (let index = 0; index < left.length; index++) {
      const l = Math.max(-1, Math.min(1, left[index] ?? 0));
      const r = Math.max(-1, Math.min(1, right[index] ?? 0));
      if (l !== 0 || r !== 0) silent = false;
      pcm[index * 2] = l * 0x7fff;
      pcm[index * 2 + 1] = r * 0x7fff;
    }
    if (silent) return;
    const bytes = new Uint8Array(pcm.buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    const encoded = btoa(binary);
    for (const name of subscribers) {
      const send = global[name];
      if (typeof send === "function") {
        send(JSON.stringify({ name, seq: 0, serializedArgs: [], pcm: encoded }));
      }
    }
  };
  // The recorder context starts suspended without user activation; media that plays audibly
  // implies activation, so it resumes on play and on input.
  const resume = () => {
    if (recorder.state === "suspended") void recorder.resume().catch(() => {});
  };
  const tapped = new WeakSet<HTMLMediaElement>();
  const tapElement = (element: HTMLMediaElement) => {
    if (tapped.has(element)) return;
    const media = element as HTMLMediaElement & { captureStream?: () => MediaStream };
    let stream: MediaStream | null = null;
    try {
      stream = media.captureStream?.() ?? null;
    } catch {
      stream = null;
    }
    if (!stream) {
      // DRM media refuses capture; routing the element through the recorder is the only tap,
      // and it binds the element to it for good, so only while the recorder runs.
      if (recorder.state !== "running") return;
      try {
        const source = recorder.createMediaElementSource(element);
        join(source, recorder.destination);
        join(source, mix);
        tapped.add(element);
      } catch {}
      return;
    }
    tapped.add(element);
    // captureStream ignores muted and volume; they are mirrored, so the video has what plays.
    const volume = recorder.createGain();
    const syncVolume = () => {
      volume.gain.value = element.muted ? 0 : element.volume;
    };
    syncVolume();
    element.addEventListener("volumechange", syncVolume);
    join(volume, mix);
    const sources = new Map<string, MediaStreamAudioSourceNode>();
    const captured = stream;
    const syncTracks = () => {
      for (const track of captured.getAudioTracks()) {
        if (sources.has(track.id)) continue;
        const source = recorder.createMediaStreamSource(new MediaStream([track]));
        join(source, volume);
        sources.set(track.id, source);
      }
      for (const [id, source] of [...sources]) {
        if (!captured.getTrackById(id)) {
          disconnectOriginal.call(source);
          sources.delete(id);
        }
      }
    };
    captured.addEventListener("addtrack", syncTracks);
    captured.addEventListener("removetrack", syncTracks);
    syncTracks();
  };
  const contextTaps = new WeakMap<BaseAudioContext, MediaStreamAudioDestinationNode>();
  const contextTap = (context: BaseAudioContext) => {
    const existing = contextTaps.get(context);
    if (existing || !(context instanceof Native)) return existing;
    const tap = context.createMediaStreamDestination();
    join(recorder.createMediaStreamSource(tap.stream), mix);
    contextTaps.set(context, tap);
    return tap;
  };
  const connectPatched = function (this: AudioNode, ...args: unknown[]) {
    const result = (nativeConnect as (...values: unknown[]) => unknown).apply(this, args);
    const [destination, output] = args;
    if (destination instanceof AudioDestinationNode && this.context !== recorder) {
      try {
        const tap = contextTap(this.context);
        if (tap) connectOriginal.call(this, tap, typeof output === "number" ? output : 0);
      } catch {}
    }
    return result;
  };
  const disconnectPatched = function (this: AudioNode, ...args: unknown[]) {
    const result = (nativeDisconnect as (...values: unknown[]) => unknown).apply(this, args);
    const tap = args[0] instanceof AudioDestinationNode ? contextTaps.get(this.context) : undefined;
    if (tap) {
      try {
        disconnectOriginal.call(this, tap);
      } catch {}
    }
    return result;
  };
  const playPatched = function (this: HTMLMediaElement) {
    resume();
    tapElement(this);
    return playOriginal.call(this);
  };
  AudioNode.prototype.connect = connectPatched as typeof AudioNode.prototype.connect;
  AudioNode.prototype.disconnect = disconnectPatched as typeof AudioNode.prototype.disconnect;
  HTMLMediaElement.prototype.play = playPatched;
  const onPlay = (event: Event) => {
    resume();
    if (event.target instanceof HTMLMediaElement) tapElement(event.target);
  };
  const tapExisting = () => {
    for (const element of document.querySelectorAll("audio, video")) {
      tapElement(element as HTMLMediaElement);
    }
  };
  document.addEventListener("play", onPlay, true);
  window.addEventListener("pointerdown", resume, true);
  window.addEventListener("keydown", resume, true);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tapExisting, { once: true });
  } else {
    tapExisting();
  }
  resume();
  global.__ndsAudioTap = {
    subscribers,
    teardown: () => {
      if ((AudioNode.prototype.connect as unknown) === connectPatched) {
        AudioNode.prototype.connect = nativeConnect;
      }
      if ((AudioNode.prototype.disconnect as unknown) === disconnectPatched) {
        AudioNode.prototype.disconnect = nativeDisconnect;
      }
      if (HTMLMediaElement.prototype.play === playPatched) {
        HTMLMediaElement.prototype.play = playOriginal;
      }
      document.removeEventListener("play", onPlay, true);
      window.removeEventListener("pointerdown", resume, true);
      window.removeEventListener("keydown", resume, true);
      processor.onaudioprocess = null;
      disconnectOriginal.call(processor);
      void recorder.close().catch(() => {});
    },
  };
}

export function stopAudioTap(bindingName: string): void {
  type Tap = { subscribers: Set<string>; teardown: () => void };
  const global = globalThis as typeof globalThis & { __ndsAudioTap?: Tap };
  const tap = global.__ndsAudioTap;
  if (!tap?.subscribers.delete(bindingName) || tap.subscribers.size > 0) return;
  delete global.__ndsAudioTap;
  tap.teardown();
}
