// The mic button: press and hold = talk while held (release sends, slide left or up and
// release cancels); a quick tap = start talking hands-free (tap the mic again to stop, ✕ or
// Esc cancels). While it records: pulsing rings on the button, a bar with the time and a
// waveform that follows the voice (mobile mode's clean screen), a hint line elsewhere.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);
  const toast = (...args) => M().toast(...args);
  const stageFile = (file) => M().stageFile(file);
  const sendMessage = () => M().sendMessage();
  const renderHints = () => M().renderHints();

  let recorder = null;
  let recordStarted = 0;
  let recordTimer = null;
  let rec = null; // { mode: 'hold' | 'tap', armed, cancelled, send, abort }
  const fmtClock = (ms) => {
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };

  /** Feeds the box with --lvl (0..1), how loud the voice is, for the animation; returns the function that stops it. */
  function watchLevel(stream) {
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      const context = new Context();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let frame = 0;
      let smooth = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
        smooth = smooth * 0.7 + (peak / 128) * 0.3;
        $('box').style.setProperty('--lvl', Math.min(1, smooth * 2.4).toFixed(3));
        frame = requestAnimationFrame(tick);
      };
      tick();
      return () => {
        cancelAnimationFrame(frame);
        context.close().catch(() => {});
        $('box').style.removeProperty('--lvl');
      };
    } catch {
      return () => {};
    }
  }

  function renderRecBar() {
    const bar = $('rec-bar');
    if (!rec || !recorder) return;
    bar.querySelector('.t').textContent = fmtClock(Date.now() - recordStarted);
    const message = rec.mode === 'tap' ? t('voice.tapStop') : rec.armed ? t('voice.armed') : t('voice.slide');
    bar.querySelector('.msg').textContent = message;
    bar.querySelector('.cancel').hidden = rec.mode !== 'tap';
  }

  /** Decodes a recording with the Web Audio API and re-encodes it as 16-bit mono WAV (the models take mp3/wav, not webm). */
  async function toWav(blob) {
    const Context = window.AudioContext || window.webkitAudioContext;
    const context = new Context();
    try {
      const audio = await context.decodeAudioData(await blob.arrayBuffer());
      const sampleRate = audio.sampleRate;
      const dataSize = audio.length * 2;
      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);
      const writeString = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
      };
      writeString(0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); // PCM
      view.setUint16(22, 1, true); // mono
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(36, 'data');
      view.setUint32(40, dataSize, true);
      let offset = 44;
      for (let i = 0; i < audio.length; i++) {
        let sample = 0;
        for (let channel = 0; channel < audio.numberOfChannels; channel++) sample += audio.getChannelData(channel)[i];
        sample = Math.max(-1, Math.min(1, sample / audio.numberOfChannels));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
      return new Blob([buffer], { type: 'audio/wav' });
    } finally {
      context.close().catch(() => {});
    }
  }

  async function startRecord(mode) {
    if (recorder || rec) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) return toast(t('voice.unsupported'), t('voice.unsupportedHint'), true);
    const mine = { mode, armed: false, cancelled: false, send: false, abort: false };
    rec = mine;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (mine.abort) {
        // Let go before the permission came back.
        stream.getTracks().forEach((track) => track.stop());
        rec = null;
        return;
      }
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
      const chunks = [];
      const stopLevel = watchLevel(stream);
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const type = (recorder.mimeType || 'audio/webm').split(';')[0];
        stream.getTracks().forEach((track) => track.stop());
        stopLevel();
        recorder = null;
        rec = null;
        clearInterval(recordTimer);
        $('mic').classList.remove('rec');
        $('box').classList.remove('recording', 'rec-armed');
        delete $('box').dataset.recMode;
        renderHints();
        if (mine.cancelled) return;
        const blob = new Blob(chunks, { type });
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        if (blob.size === 0) return;
        // Held and released: it goes straight away. After a tap it waits in the box (add text, then send).
        const stage = (file) => stageFile(file).then(() => mine.send && sendMessage());
        if (type === 'audio/wav') {
          stage(new File([blob], `voice-${stamp}.wav`, { type }));
          return;
        }
        // The recorder makes webm/opus (or m4a); the transcription models only take mp3/wav, so re-encode as WAV first.
        toWav(blob)
          .then((wav) => stage(new File([wav], `voice-${stamp}.wav`, { type: 'audio/wav' })))
          .catch(() => {
            // If decoding failed (rare), send the original so the message is not lost.
            stage(new File([blob], `voice-${stamp}.${type.includes('mp4') ? 'm4a' : 'webm'}`, { type }));
          });
      };
      recorder.start();
      recordStarted = Date.now();
      $('mic').classList.add('rec');
      $('box').classList.add('recording');
      $('box').dataset.recMode = mode;
      recordTimer = setInterval(() => {
        renderHints();
        renderRecBar();
      }, 250);
      renderHints();
      renderRecBar();
      if (navigator.vibrate) navigator.vibrate(12);
    } catch (error) {
      recorder = null;
      rec = null;
      toast(t('voice.micFail'), error.message, true);
    }
  }

  /** Stops the recording: `cancel` throws it away, `send` posts it at once. */
  function endRecord({ cancel = false, send: sendNow = false } = {}) {
    if (!rec) return;
    if (!recorder) {
      rec.abort = true; // still waiting for the microphone
      return;
    }
    rec.cancelled = cancel;
    rec.send = sendNow;
    if (cancel && navigator.vibrate) navigator.vibrate(25);
    if (recorder.state !== 'inactive') recorder.stop();
  }

  (() => {
    const mic = $('mic');
    const HOLD_MS = 260; // longer than a tap
    const TOO_SHORT_MS = 700; // a held press shorter than this was a slip
    const SLIDE_PX = 70;
    let press = null;

    const bar = el('div');
    bar.id = 'rec-bar';
    const wave = el('span', 'wave');
    for (let index = 0; index < 9; index++) {
      const tick = el('i');
      tick.style.setProperty('--i', index);
      wave.append(tick);
    }
    bar.append(el('span', 'dot'), el('span', 't', '0:00'), wave, el('span', 'msg'), button('cancel', t('voice.cancel'), () => endRecord({ cancel: true })));
    $('box').append(bar);

    mic.addEventListener('contextmenu', (event) => event.preventDefault());
    mic.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (rec && rec.mode === 'tap') {
        // Hands-free is running: this press stops it (the clip waits in the box).
        press = { handled: true };
        endRecord();
        return;
      }
      try {
        mic.setPointerCapture(event.pointerId); // keep the slide even when the finger leaves the button
      } catch {
        // no such pointer (synthetic event)
      }
      press = {
        x: event.clientX,
        y: event.clientY,
        held: false,
        timer: setTimeout(() => {
          press.held = true;
          startRecord('hold');
        }, HOLD_MS),
      };
    });
    mic.addEventListener('pointermove', (event) => {
      if (!press || !press.held || !rec || rec.mode !== 'hold') return;
      const armed = event.clientX - press.x < -SLIDE_PX || event.clientY - press.y < -SLIDE_PX;
      if (armed === rec.armed) return;
      rec.armed = armed;
      $('box').classList.toggle('rec-armed', armed);
      if (navigator.vibrate) navigator.vibrate(armed ? 20 : 8);
      renderRecBar();
    });
    const release = (cancelled) => {
      if (!press) return;
      const current = press;
      press = null;
      clearTimeout(current.timer);
      if (current.handled) return;
      if (!current.held) {
        if (!cancelled) startRecord('tap');
        return;
      }
      if (!rec) return;
      if (cancelled || rec.armed) return endRecord({ cancel: true });
      if (recorder && Date.now() - recordStarted < TOO_SHORT_MS) {
        toast(t('voice.short'), t('voice.shortHint'));
        return endRecord({ cancel: true });
      }
      endRecord({ send: true });
    };
    mic.addEventListener('pointerup', () => release(false));
    mic.addEventListener('pointercancel', () => release(true));
    // Keyboard: Enter / Space start hands-free, again to stop.
    mic.addEventListener('click', (event) => {
      if (event.detail !== 0) return;
      if (rec) endRecord();
      else startRecord('tap');
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && rec) endRecord({ cancel: true });
    });
  })();

  /** The line under the box while recording (elsewhere than the clean screen), or null. */
  function hint() {
    if (!recorder) return null;
    const how = rec && rec.mode === 'hold' ? t('voice.holdHint') : t('voice.tapHint');
    return t('voice.recording', { time: fmtClock(Date.now() - recordStarted), how });
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.voice = { hint };
})();
