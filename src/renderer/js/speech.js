// Her voice out loud: she reads her answers with one of the system's own voices (Web Speech,
// on Windows its built-in voices: nothing to install, nothing leaves the PC). Her head nods with
// the words, like when the panel types them. Her menu › Her voice picks the voice.

import { reducedMotion } from './util.js';

const LOCALE = { fr: 'fr', en: 'en', es: 'es', pt: 'pt', ru: 'ru' };

export class Speech {
  constructor({ capri }) {
    this.capri = capri;
    this.synth = window.speechSynthesis || null;
    this.voiceName = null; // her menu's pick (null: the first one in her language)
    this.lang = 'en';
    this.current = null;
    this.onVoices = null; // (names) => void, the voices in her language, for her menu
    this.synth?.addEventListener('voiceschanged', () => this.announce());
  }

  get available() {
    return Boolean(this.synth);
  }

  get speaking() {
    return Boolean(this.current);
  }

  // The system's voices that speak `lang`, best first: the local ones, then the others.
  voices(lang = this.lang) {
    if (!this.synth) return [];
    const base = LOCALE[lang] || 'en';
    return this.synth.getVoices()
      .filter((v) => v.lang.toLowerCase().startsWith(base))
      .sort((a, b) => Number(b.localService) - Number(a.localService));
  }

  setLang(lang) {
    this.lang = lang;
    this.announce();
  }

  announce() {
    this.onVoices?.(this.voices().map((v) => v.name));
  }

  // Says `text`; resolves once she's done (or cut off). Her head nods along on the words.
  say(text, { lang = this.lang } = {}) {
    this.stop();
    const line = speakable(text);
    if (!this.synth || !line) return Promise.resolve();
    const all = this.voices(lang);
    const voice = all.find((v) => v.name === this.voiceName) || all[0];
    return new Promise((done) => {
      const u = new SpeechSynthesisUtterance(line);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || lang;
      u.rate = 1.04;
      u.pitch = 1.12; // a little higher: she's small, and many
      let nodded = 0;
      u.onboundary = (e) => {
        if (e.name !== 'word' || reducedMotion.matches) return;
        const now = performance.now();
        if (now - nodded > 260) {
          nodded = now;
          this.capri.perform('talk');
        }
      };
      const end = () => {
        if (this.current === u) this.current = null;
        done();
      };
      u.onend = end;
      u.onerror = end;
      this.current = u;
      this.synth.speak(u);
      // Chromium can stall a long utterance: nudge it along
      const keep = setInterval(() => {
        if (this.current !== u) clearInterval(keep);
        else if (this.synth.speaking && !this.synth.paused) {
          this.synth.pause();
          this.synth.resume();
        }
      }, 10000);
    });
  }

  stop() {
    if (!this.synth) return;
    const was = this.current;
    this.current = null;
    if (was || this.synth.speaking) this.synth.cancel();
    was?.onend?.();
  }
}

// What a voice should read: no tags, no markdown, no emoji, the dashes as pauses.
function speakable(text) {
  return String(text || '')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+[—–]\s+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}
