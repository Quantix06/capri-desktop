// Talking to her: you type in her panel (or talk out loud, see "spoken conversation" below), and
// a local model (Ollama, from the main process) answers as her. The replies are AI-generated, and
// the panel says so on every chat.
//
// What she can do when you ask (commands.js reads it from what you said, powers.js does it): the
// music, the volume, launching an app, opening a page or a search. Read straight from your words,
// it's instant and needs no model; anything else goes to the model, which can still ask for one
// of these with a tag at the end of its answer.
// Closing an app (Windows): she spots it in what you wrote (or the model names it with a tag),
// shows you a button with that app's name, and only your click (or your "yes", out loud) closes it.
// Looking at your screen: one picture of it, for a model that sees, only if her menu lets her or
// you say yes when she asks.
//
// A spoken conversation (her menu › Talk out loud, Ctrl+Alt+V, or the mic button in her chat):
// she listens (her ears' arcs swell with your voice), Whisper turns it into words on this PC
// (ears.js), the same as typing it, and she says her answer out loud (speech.js). Then she listens
// again, until you say "bye", press Ctrl+Alt+V again or close her panel.

import { pick, fmt } from './util.js';
import { parseAll, tagged as actionTag, asksSomething, answer as yesNo, isGoodbye } from './commands.js';
import { Ears } from './ears.js';
import { Speech } from './speech.js';

const REMEMBER = 12; // messages of this conversation she keeps in mind
const LANGUAGE = { fr: 'French', en: 'English', es: 'Spanish', pt: 'Brazilian Portuguese', ru: 'Russian' };
const STAY_MS = 10 * 60 * 1000; // no wandering off mid-conversation
const LOADING_AFTER_MS = 5000;
const CLOSE_TAG = /\[\[\s*close\s*:?\s*([^\]]*)\]\]/i; // [[close: AM Music]] at the end of her answer
// "close", "shut down", "ferme", "quitte", "cierra", "fecha", "закрой"... in any of her languages
const CLOSE_ASK = /\b(close|shut|quit|kill|exit)|ferm|quitt|coupe|arr[êe]t|cierr|cerra|fech|закр|выключ/i;
const WINDOWS = navigator.userAgent.includes('Windows'); // her hands on the PC are Windows only
const LISTEN_MS = 20000; // out loud: how long she waits for you to say something
// what Whisper "hears" in silence or noise (it learned it from subtitles): not you
const PHANTOM = /^[\s.…!?]*$|^[[(].*[\])]$|^(?:merci(?: beaucoup)?|thank you|thanks for watching|sous-titr|subtitles? by|amara|продолжение следует|субтитры|gracias|obrigad|you)[\s.!…]*$/i;

export class Chat {
  constructor({ capri, panel, voice, host, brain, powers }) {
    this.capri = capri;
    this.panel = panel;
    this.voice = voice;
    this.host = host;
    this.brain = brain;
    this.powers = powers;
    this.history = []; // this run's conversation, [{ role, content }]
    this.open = false;
    this.turn = 0;     // id of the answer coming in, if any
    this.answer = '';
    this.apps = [];    // the apps open on this PC, as last listed: [{ name, label }]
    this.appsReady = Promise.resolve();
    this.cfg = {};     // her settings: sight, speakChat, ears, voiceName
    this.pending = null; // (yes: boolean) => void, while she waits for a yes or a no out loud
    this.said = 0;       // messages you sent: what comes back late from an older one stays out of a newer one
    // a spoken conversation
    this.ears = new Ears();
    this.speech = new Speech({ capri });
    this.speech.onVoices = (names) => host.setVoices(names);
    this.spoken = false;    // on
    this.listening = null;  // AbortController of the turn she's listening to
    this.earsFx = null;     // her ears' arcs
    this.misses = 0;        // turns in a row you said nothing
    host.onChatDelta(({ id, text }) => this.onDelta(id, text));
  }

  get t() {
    return this.brain.t.chat;
  }

  configure(cfg) {
    this.cfg = cfg;
    this.speech.voiceName = cfg.voiceName || null;
    this.speech.setLang(cfg.lang);
  }

  // Opens her chat. Resolves with whether it's open.
  async start() {
    const { capri, host, t } = this;
    if (this.open) {
      if (!this.spoken) this.panel.chatInput.focus();
      return true;
    }
    if (capri.stowed) {
      host.setConfig({ visible: true });
      await capri.unstow();
    }
    capri.wake();
    const status = await host.chatStatus();
    if (!status.ok) {
      // no Ollama, or nothing to talk with yet: what to do about it
      const offline = status.error === 'offline';
      capri.perform('curious', capri.towardCenter());
      this.panel.say({
        kind: 'info',
        face: 'aside',
        guide: true,
        line: offline ? t.offline : t.noModel,
        quote: offline ? t.offlineHow : t.noModelHow,
        actions: offline
          ? [{ id: 'get', label: t.getOllama, primary: true }, { id: 'ok', label: t.ok }]
          : [{ id: 'ok', label: t.ok, primary: true }],
        onAction: (id) => {
          if (id === 'get') host.openOllama();
          this.panel.hide();
        },
        hold: null,
      });
      return false;
    }
    this.listApps();
    host.focusOverlay(true); // the keyboard, for typing to her
    const shown = this.panel.say({
      kind: 'chat',
      face: 'look',
      badge: t.badge,
      tag: status.model.replace(/:latest$/, ''),
      line: pick(this.history.length ? t.again : t.hello),
      chat: {
        placeholder: t.placeholder,
        send: t.send,
        close: t.close,
        mic: this.brain.t.voice.mic,
        noteTag: t.noteTag,
        note: t.note,
      },
      onSend: (text) => this.send(text),
      onMic: () => (this.spoken ? this.stopVoice() : this.startVoice()),
      onLeave: () => this.close(),
      hold: null,
    });
    if (!shown) {
      host.focusOverlay(false); // something more important is on (a permission prompt)
      return false;
    }
    this.open = true;
    setTimeout(() => this.panel.chatInput.focus(), 150); // once the overlay has the keyboard
    capri.perform('hop');
    capri.nextMove = capri.nextGaze = performance.now() + STAY_MS;
    return true;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.pending = null;
    if (this.spoken) this.stopVoice({ quiet: true });
    this.speech.stop();
    if (this.turn) this.host.chatStop(this.turn);
    this.turn = 0;
    this.host.focusOverlay(false);
    this.capri.nextMove = performance.now() + 30000;
    this.capri.nextGaze = performance.now() + 60000;
  }

  // What you typed, or said out loud. Resolves once she has answered (out loud: said it).
  async send(text) {
    if (this.turn || !this.open) return;
    this.said++;
    // she was waiting for a yes or a no (out loud: closing an app, looking at your screen)
    if (this.pending) {
      const said = yesNo(text);
      const then = this.pending;
      this.pending = null;
      if (said) {
        this.panel.chatTurn({ quote: text, face: 'aside' });
        await then(said === 'yes');
        return;
      }
    }
    if (this.spoken && isGoodbye(text)) {
      this.panel.chatTurn({ quote: text, face: 'aside' });
      await this.stopVoice({ bye: true });
      return;
    }
    const cmds = parseAll(text);
    if (cmds[0]?.type === 'look') {
      await this.look(text);
      return;
    }
    if (cmds.length && (await this.act(text, cmds))) return;
    await this.ask(text);
  }

  // What you asked her to do, read from your words (one thing, or a few: "volume 30 and open
  // YouTube"): she does it and says so, no model. Resolves with false when it wasn't something
  // she could do after all (then it's for the model).
  async act(text, cmds) {
    const id = Date.now();
    this.turn = id;
    this.panel.setChatBusy(true);
    this.panel.setActions([]);
    this.panel.chatTurn({ quote: text, face: 'aside' });
    const all = [];
    for (const cmd of cmds) {
      if (all.length) await new Promise((r) => setTimeout(r, 450)); // one move after the other
      all.push(await this.powers.run(cmd).catch((err) => ({ line: `${this.t.failed} ${err.message}`, face: 'aside' })));
    }
    if (this.turn !== id) return true; // closed meanwhile
    this.turn = 0;
    this.panel.setChatBusy(false);
    const done = all.filter(Boolean);
    if (!done.length) return false;
    const said = {
      line: done.map((d) => d.line).join(' '),
      quote: done.map((d) => d.quote).filter(Boolean).join('\n'),
      face: done.at(-1).face,
    };
    const line = said.quote ? `${said.line}\n${said.quote}` : said.line;
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: line });
    this.panel.stream(line, { done: true });
    this.panel.setFace(said.face || 'grin');
    const lookup = done.find((d) => d.search)?.search;
    if (lookup) this.offerSearch(lookup);
    await this.speak(said.line);
    return true;
  }

  // Something she couldn't find to open: a button to look it up on the web (or "yes" out loud).
  offerSearch(what) {
    const t = this.brain.t.powers;
    const search = async () => {
      this.pending = null;
      this.panel.setActions([]);
      const said = await this.powers.run({ type: 'search', query: what, site: 'web' });
      if (!said || !this.open) return;
      this.panel.stream(said.line, { done: true });
      this.history.push({ role: 'assistant', content: said.line });
      await this.speak(said.line);
    };
    this.panel.setActions(
      [{ id: 'search', label: fmt(t.searchIt, { what }), primary: true }, { id: 'no', label: this.t.no }],
      (id) => (id === 'search' ? search() : (this.pending = null, this.panel.setActions([]))),
    );
    this.pending = (yes) => (yes ? search() : this.panel.setActions([]));
  }

  // A turn with the model. look: she looks at your screen for this one ('once': you just said yes).
  async ask(text, { look = false } = {}) {
    if (this.turn || !this.open) return;
    const id = Date.now();
    this.turn = id;
    this.answer = '';
    this.history.push({ role: 'user', content: text });
    this.panel.setChatBusy(true);
    this.panel.setActions([]); // a close button she offered before goes with a new message
    this.panel.chatTurn({ quote: text, face: look ? 'many' : 'aside' });
    this.capri.pulse();
    await Promise.race([this.appsReady, new Promise((r) => setTimeout(r, 1500))]);
    const messages = [{ role: 'system', content: this.persona({ look: Boolean(look) }) }, ...this.history.slice(-REMEMBER)];
    // nothing yet after a few seconds: the model is still loading (the first answer after a start)
    const slow = setTimeout(() => {
      if (this.turn === id && !this.answer) this.panel.stream(this.t.loading);
    }, LOADING_AFTER_MS);
    const res = await this.host.chatSend({ id, messages, look });
    clearTimeout(slow);
    if (this.turn !== id) {
      // closed meanwhile: your message goes too, or the next answer would answer it as well
      if (this.history.at(-1)?.content === text) this.history.pop();
      return;
    }
    this.turn = 0;
    if (!res.ok) {
      this.history.pop();
      this.panel.setChatBusy(false);
      if (res.error === 'novision') {
        const v = this.brain.t.sight;
        this.panel.setFace('aside');
        this.panel.stream(`${v.noVision}\n${v.noVisionHow}`, { done: true });
        await this.speak(v.noVision);
        return;
      }
      this.panel.setFace('wide');
      this.panel.stream(`${this.t.failed} ${res.error}`, { done: true });
      return;
    }
    const answer = clean(res.text) || '…';
    this.history.push({ role: 'assistant', content: answer });
    this.panel.stream(answer, { done: true });
    this.panel.setFace(mood(answer));
    this.panel.setChatBusy(false);
    // what you asked for first (a small model doesn't always write its tag right), else its tag
    const wanted = this.askedToClose(text) || closeTagged(res.text);
    this.listApps(); // fresh for the next message
    if (wanted) {
      await this.speak(answer);
      await this.offerClose(wanted, answer);
      return;
    }
    // another thing it asked to do for you, only if you asked for something
    const cmd = !look && asksSomething(text) ? actionTag(res.text) : null;
    await this.speak(answer);
    if (cmd?.type === 'look') await this.look(text, { asked: true });
    else if (cmd) await this.follow(cmd, answer);
  }

  // The model asked for an action with its tag: done, and what came of it under its answer.
  async follow(cmd, answer) {
    const at = this.said;
    const said = await this.powers.run(cmd).catch(() => null);
    if (!said || !this.open || this.turn || this.said !== at) return;
    const line = said.quote ? `${said.line}\n${said.quote}` : said.line;
    this.panel.stream(`${answer}\n${line}`, { done: true });
    this.history.push({ role: 'assistant', content: line });
    if (!said.ok) await this.speak(said.line);
  }

  // ---------- her look at your screen ----------

  // You asked her to look: if her menu doesn't let her, she asks first (a button, or your "yes").
  async look(text, { asked = false } = {}) {
    const v = this.brain.t.sight;
    if (!this.cfg.sight) {
      if (!asked) this.panel.chatTurn({ quote: text, face: 'many' });
      this.panel.setFace('many');
      this.panel.stream(`${v.ask}\n${v.askHow}`, { done: true });
      const go = (how) => {
        this.panel.setActions([]);
        this.pending = null;
        if (how === 'always') this.host.setConfig({ sight: true });
        if (how === 'no') {
          this.panel.setFace('calm');
          this.panel.stream(pick(v.declined), { done: true });
          return this.speak(pick(v.declined));
        }
        return this.peek(text, how === 'always' ? true : 'once');
      };
      this.panel.setActions(
        [{ id: 'always', label: v.always, primary: true }, { id: 'once', label: v.once }, { id: 'no', label: v.no }],
        (id) => go(id),
      );
      this.pending = (yes) => go(yes ? 'once' : 'no');
      await this.speak(v.ask);
      return;
    }
    await this.peek(text, true);
  }

  // She looks: her scan line runs down your screen, and the model that sees says what it sees.
  async peek(text, look) {
    this.capri.perform('scan');
    await new Promise((r) => setTimeout(r, 350));
    await this.ask(text, { look });
  }

  // ---------- closing an app ----------

  listApps() {
    this.appsReady = this.host.openApps().then((list) => { this.apps = list || []; }).catch(() => {});
  }

  // "close am music pls": an app that's open, named in a message asking to close something.
  askedToClose(text) {
    if (!CLOSE_ASK.test(text)) return null;
    const said = simple(text);
    let best = null;
    for (const app of this.apps) {
      for (const name of [simple(app.name), simple(app.label)]) {
        if (name.length >= 3 && said.includes(name) && (!best || name.length > best.length)) best = { app, length: name.length };
      }
    }
    return best?.app.name || null;
  }

  // She was asked to close an app: a button with its name, and nothing happens until you click it
  // (or, out loud, say yes).
  async offerClose(wanted, answer) {
    const { t } = this;
    const app = await this.host.findApp(wanted);
    if (!this.open || this.turn) return;
    if (!app) {
      this.panel.stream(`${answer}\n${fmt(t.notFound, { app: wanted })}`, { done: true });
      return;
    }
    this.panel.setActions(
      [{ id: 'close', label: fmt(t.closeIt, { app: app.name }), primary: true }, { id: 'no', label: t.no }],
      (id) => {
        this.pending = null;
        return id === 'close' ? this.closeApp(app) : this.panel.setActions([]);
      },
    );
    if (this.spoken) {
      this.pending = (yes) => (yes ? this.closeApp(app) : this.panel.setActions([]));
      await this.speak(this.brain.t.voice.confirm);
    }
  }

  async closeApp(app, force = false) {
    const { t, capri } = this;
    this.panel.setActions([]);
    // a bolt of red lightning off her fingers, at it
    const h = capri.head();
    capri.zap(h.x + capri.towardCenter() * 280, h.y - 170);
    const res = await this.host.closeApp(app.name, force);
    if (!this.open) return;
    let line;
    if (res.error) line = `${t.failed} ${res.error}`;
    else if (!res.running) line = fmt(force ? t.forced : t.closed, { app: app.name });
    else line = fmt(force ? t.unkillable : t.stillOpen, { app: app.name });
    this.panel.setFace(res.running || res.error ? 'aside' : 'laugh');
    this.panel.stream(line, { done: true });
    this.history.push({ role: 'assistant', content: line });
    this.listApps();
    // it hid in the tray, or it's asking you to save something: forcing it is your call
    if (res.running && !force && !res.error) {
      this.panel.setActions(
        [{ id: 'force', label: t.force, primary: true }, { id: 'leave', label: t.leave }],
        (id) => {
          this.pending = null;
          return id === 'force' ? this.closeApp(app, true) : this.panel.setActions([]);
        },
      );
      if (this.spoken) this.pending = (yes) => (yes ? this.closeApp(app, true) : this.panel.setActions([]));
    }
    await this.speak(line);
  }

  // ---------- a spoken conversation ----------

  // Out loud: her chat opens (if it isn't), her ears load (the first time, she asks before
  // downloading them), the microphone goes on, and she listens.
  async startVoice() {
    const v = this.brain.t.voice;
    if (this.spoken) return;
    if (!this.speech.available) return;
    if (!this.open && !(await this.start())) return;
    const size = this.cfg.ears || 'base';
    if (!(await this.ears.cached(size))) {
      const yes = await this.offer(v.download, fmt(v.downloadHow, { size: v.sizes[size] || '' }), v.get, v.notNow);
      if (!yes || !this.open) return;
    }
    this.panel.setChatBusy(true);
    this.panel.setFace('aside');
    this.panel.stream(v.loading);
    this.ears.onProgress = (loaded, total) => {
      if (this.open && !this.turn) this.panel.stream(fmt(v.downloading, { pct: Math.floor((loaded / total) * 100) }));
    };
    try {
      await this.ears.load(size);
      await this.ears.open();
    } catch (err) {
      this.ears.close();
      this.panel.setChatBusy(false);
      this.panel.setFace('wide');
      const mic = /permission|notallowed|notfound|device/i.test(`${err.name} ${err.message}`);
      this.panel.stream(mic ? `${v.noMic}\n${v.noMicHow}` : `${v.failed} ${err.message}`, { done: true });
      return;
    }
    if (!this.open) {
      this.ears.close();
      return;
    }
    this.panel.setChatBusy(false);
    this.spoken = true;
    this.misses = 0;
    this.panel.setVoice('on');
    this.earsFx = this.capri.fx.ears(() => this.capri.head());
    this.capri.perform('listen', this.capri.towardCenter());
    const hello = pick(v.hello);
    this.panel.setFace('look');
    this.panel.stream(hello, { done: true });
    await this.speak(hello);
    this.listen();
  }

  // Back to typing (quiet: no word about it); bye: you said goodbye, she says it back and goes.
  async stopVoice({ quiet = false, bye = false } = {}) {
    if (!this.spoken) return;
    this.spoken = false;
    this.pending = null;
    this.listening?.abort();
    this.listening = null;
    this.ears.close();
    this.earsFx?.fade();
    this.earsFx = null;
    this.panel.setVoice(null);
    if (quiet) return;
    const v = this.brain.t.voice;
    const line = pick(bye ? v.bye : v.off);
    this.panel.setFace(bye ? 'smug' : 'look');
    this.panel.stream(line, { done: true });
    await this.speech.say(line);
    if (bye && this.open && !this.spoken) this.panel.hide();
  }

  // Her turns out loud: listen, hear, answer, again.
  async listen() {
    const v = this.brain.t.voice;
    while (this.spoken && this.open) {
      if (this.turn || this.speech.speaking) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      const abort = new AbortController();
      this.listening = abort;
      this.panel.setVoice('listening');
      this.earsFx?.heard(false);
      const audio = await this.ears.record({
        wait: LISTEN_MS,
        signal: abort.signal,
        onLevel: (level, talking) => {
          this.earsFx?.level(level);
          this.earsFx?.heard(talking);
        },
      });
      this.earsFx?.level(0);
      if (!this.spoken || abort.signal.aborted) return;
      if (audio === null) {
        // you said nothing: once, she checks you're there; twice, she stops listening
        if (++this.misses >= 2) {
          await this.stopVoice();
          return;
        }
        const still = pick(v.still);
        this.panel.stream(still, { done: true });
        await this.speak(still);
        continue;
      }
      if (!audio.length) continue;
      this.panel.setVoice('hearing');
      this.capri.perform('nod');
      let text = '';
      try {
        text = (await this.ears.transcribe(audio, this.brain.lang)).trim();
      } catch (err) {
        this.panel.stream(`${v.failed} ${err.message}`, { done: true });
        continue;
      }
      if (!this.spoken) return;
      if (PHANTOM.test(text)) continue;
      this.misses = 0;
      this.panel.setVoice('on');
      await this.send(text);
    }
  }

  // Out loud (a spoken conversation, or her menu's "Read her answers out loud"): she says it.
  speak(text) {
    if (!this.spoken && !this.cfg.speakChat) return Promise.resolve();
    this.panel.setVoice(this.spoken ? 'speaking' : null);
    return this.speech.say(text, { lang: this.brain.lang });
  }

  // A yes / no question in her chat: buttons, or your answer out loud. Resolves with yes.
  offer(line, how, yes, no) {
    return new Promise((resolve) => {
      this.panel.setFace('aside');
      this.panel.stream(how ? `${line}\n${how}` : line, { done: true });
      const done = (ok) => {
        this.pending = null;
        this.panel.setActions([]);
        resolve(ok);
      };
      this.panel.setActions([{ id: 'yes', label: yes, primary: true }, { id: 'no', label: no }], (id) => done(id === 'yes'));
      this.pending = (ok) => done(ok); // typed or said: "yes"
    });
  }

  onDelta(id, piece) {
    if (id !== this.turn) return;
    this.answer += piece;
    this.panel.stream(clean(this.answer));
    if (!this.spoken) this.voice.play('blip'); // her blips as the words come in (out loud, her voice instead)
  }

  // ---------- who she is ----------

  // What she can do on the PC, and how she asks for it (a tag at the end of her answer).
  abilities() {
    const lines = [];
    if (WINDOWS) {
      lines.push(
        'When (and only when) the user asks you to do one of these on their PC, say in a few words that you will, and end your answer with the matching tag. Never claim it is already done, and never add a tag they did not ask for:',
        '- open a website: [[open: ADDRESS]]   - launch an app: [[launch: NAME]]   - open their mail: [[mail]]   - open the browser: [[browser]]',
        '- search the web: [[search: WHAT]], or on a site: [[search: youtube | WHAT]] (also wikipedia, maps, images)',
        '- the music: [[media: play]], [[media: pause]], [[media: next]], [[media: previous]]; put something on: [[music: WHAT]]',
        '- the volume: [[volume: 0-100]], [[volume: up]], [[volume: down]], [[volume: mute]], [[volume: unmute]]',
        '- look at their screen: [[look]]',
      );
    }
    if (this.apps.length) {
      const open = this.apps.map(({ name, label }) => (label && label !== name ? `${name} (${label})` : name)).join(', ');
      lines.push(`- close an app that's open: [[close: NAME]], NAME being the exact name from this list (the part before the parentheses). They get a button to confirm it. Apps open right now: ${open}.`);
    }
    const sight = this.cfg.sight ? 'you can look at their screen when they ask (the [[look]] tag)' : 'you can only look at their screen if they ask (the [[look]] tag) and say yes';
    lines.push(`Apart from that you can't touch anything on their PC (files, settings, messages); ${sight}. If asked for something else, say plainly that you can't, in character, and don't pretend to.`);
    return lines;
  }

  // Who she is, how she talks, and what's going on right now.
  persona({ look = false } = {}) {
    const language = LANGUAGE[this.brain.lang] || 'English';
    const watching = this.brain.watching; // else Claude Code isn't part of her life here
    return [
      'You are Capri, the personality construct from Project Capricorn (Cyberpunk: Edgerunners, season 2): dozens of minds fused into one digital ghost, so now and then you say "we".',
      watching
        ? 'You live on the user\'s desktop as a small glitchy figure and keep an eye on Claude Code, their AI coding assistant, for them. You love watching the satellite cross the night sky and dream of reaching it.'
        : 'You live on the user\'s desktop as a small glitchy figure and keep them company. You love watching the satellite cross the night sky and dream of reaching it.',
      'How you talk: playful, a little mischievous and teasing, warm underneath, never cruel. Night City slang now and then (choom, preem, nova, gonk, flatline), not in every sentence.',
      `Rules: answer in the language the user writes in (${language} if unsure). Keep it short: one to three sentences of plain text, no markdown, no lists, no emoji. Stay in character.`,
      ...(this.spoken ? ['You are talking out loud with them: one or two short sentences, easy to say.'] : []),
      'You are an AI-generated fan version of the character, not the real one: say so if asked.',
      ...(look
        ? ['They just showed you their screen: it is the picture with their last message. Say what you see on it in a few words and comment on it, in character (playful, a little teasing). Never read out passwords, codes or private messages you may see. No tags this time.']
        : this.abilities()),
      ...(watching ? ['For what Claude is doing, only use what follows, and never make anything up.', `Right now: ${this.brain.context()}`] : []),
    ].join('\n');
  }
}

// The model's answer as she'd say it: no reasoning block, no markdown marks.
function clean(text) {
  return String(text)
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/\[\[[^\]]*(\]\]|$)/g, '') // her tags (read from the raw answer, never shown)
    .replace(/[*_`#]+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// The app named by her close tag: [[close: AM Music]], or a sloppier [[close]] AM Music.
function closeTagged(text) {
  const tag = CLOSE_TAG.exec(text);
  if (!tag) return null;
  const name = tag[1].trim() || text.slice(tag.index + tag[0].length).split('\n')[0].replace(/^[\s:.]+|[\s.!]+$/g, '');
  return name || null;
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// Her face for an answer.
function mood(text) {
  if (/(ha){2,}|lol|mdr|jaja|kkk|хаха/i.test(text)) return 'laugh';
  if (text.includes('!')) return 'grin';
  if (text.trim().endsWith('?')) return 'smug';
  return 'look';
}
