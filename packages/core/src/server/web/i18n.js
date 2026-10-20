// Text of the app in more than one language. `t('key', { name: 'value' })` returns the text in
// the chosen language (Thai or English; the choice is remembered, the browser's language is the
// first guess), with {name} filled in. A key missing from a language falls back to Thai, then
// shows the key itself, so a half-translated screen still works.
//
// Screens are moved over one at a time: the chat screen, the voice button, Chat setting and the
// character placement use t() already; the older screens still hold their Thai text inline.
// To add a language: add a table below and its name to LANGUAGES.
(() => {
  'use strict';

  const TH = {
    you: 'คุณ',
    'msg.empty': '(ข้อความ)',
    'msg.file': '(ไฟล์)',
    'chat.default': 'แชต',
    'chat.group': 'กลุ่ม · {members}',
    'chat.direct': 'ตัวต่อตัว',
    'day.today': 'วันนี้',
    'day.yesterday': 'เมื่อวาน',
    'session.auto': 'เริ่ม session ใหม่อัตโนมัติ',
    'speech.title': 'การอ่านออกเสียง',
    'speech.emotion': 'อารมณ์',
    'speech.tone': 'น้ำเสียง',
    'speech.voice': 'เสียง',
    'speech.speed': 'ความเร็ว',
    'reply.to': 'ตอบกลับ {who}',
    'reply.action': 'ตอบกลับ',
    'forward.action': 'ส่งต่อ',
    'forward.title': 'ส่งต่อข้อความ',
    'forward.done': 'ส่งต่อแล้ว',
    'forward.to': 'ไปที่ {chat}',
    'forward.none': 'ไม่มีแชตอื่นให้ส่งต่อ',
    'copy.action': 'คัดลอก',
    'copy.text': 'คัดลอกข้อความ',
    'copy.done': 'คัดลอกแล้ว',
    'copy.fail': 'คัดลอกไม่ได้',
    'copy.failHint': 'เลือกข้อความแล้วคัดลอกเอง',
    like: 'ถูกใจ',
    unlike: 'เลิกถูกใจ',
    react: 'แสดงความรู้สึก',
    'react.remove': 'เอาปฏิกิริยานี้ออก',
    pin: 'ปักหมุด',
    unpin: 'เลิกปักหมุด',
    'pins.title': 'ข้อความที่ปักหมุด',
    'pins.none': 'ไม่มีข้อความที่ปักหมุด',
    'pins.unpin': 'เลิกปัก',
    'pins.all': 'ทั้งหมด',
    'pins.viewAll': 'ดูทั้งหมด',
    emoji: 'อิโมจิ',

    'voice.slide': '‹ เลื่อนซ้ายเพื่อยกเลิก',
    'voice.armed': '🗑 ปล่อยเพื่อยกเลิก',
    'voice.tapStop': 'แตะไมค์เพื่อหยุด',
    'voice.cancel': '✕ ยกเลิก',
    'voice.unsupported': 'อัดเสียงไม่ได้',
    'voice.unsupportedHint': 'เบราว์เซอร์นี้ไม่รองรับ แนบไฟล์เสียงแทนได้',
    'voice.micFail': 'ใช้ไมโครโฟนไม่ได้',
    'voice.short': 'เสียงสั้นเกินไป',
    'voice.shortHint': 'กดค้างไว้แล้วพูด ปล่อยเพื่อส่ง',
    'voice.holdHint': 'ปล่อยเพื่อส่ง · เลื่อนออกเพื่อยกเลิก',
    'voice.tapHint': 'กดไมค์อีกครั้งเพื่อหยุด · Esc ยกเลิก',
    'voice.recording': '● กำลังอัดเสียง {time} — {how}',

    'top.info': 'ข้อมูล',
    'top.character': 'ตัวละคร',
    'top.search': 'ค้นหา',
    'top.settingClose': 'กลับ (ปิด Chat setting)',
    'setting.title': 'Chat setting',
    'setting.fold': 'ย่อ ▴',
    'setting.foldHint': 'ย่อกลับ',
    'setting.characterOn': '🧍 ตัวละคร: เปิด',
    'setting.characterOff': '🧍 ตัวละคร: ปิด',
    'setting.characterHint': 'เปิด/ปิดตัวละครบนหน้าแชต',
    'setting.characterHide': 'ซ่อนตัวละคร (ดูข้อความได้เต็มที่)',
    'setting.characterShow': 'แสดงตัวละคร',
    'setting.search': '⌕ ค้นหา',
    'setting.newSession': '+ session ใหม่',
    'setting.showPrompt': 'แสดง prompt',
    'setting.language': 'ภาษา',
    'bubbles.title': 'การแสดงข้อความ',
    'bubbles.0': '0 · ซ่อน',
    'bubbles.0.hint': 'ไม่แสดง chat bubble',
    'bubbles.1': '1 · ล่าสุด',
    'bubbles.1.hint': 'แสดงแค่ข้อความล่าสุด',
    'bubbles.2': '2 · ปกติ',
    'bubbles.2.hint': 'แสดงข้อความทั้งหมด',
    'composer.placeholder': 'พิมพ์ข้อความ…',
    'composer.placeholderTo': 'ทัก {name}…',
    'composer.attachTouch': 'แตะ = ถ่ายรูป · กดค้าง = เลือกไฟล์',

    'view.title3d': 'ตำแหน่งตัวละคร (3D)',
    'view.title2d': 'ตำแหน่งตัวละคร (2D)',
    'view.yaw': 'หมุน',
    'view.pitch': 'ก้ม / เงย',
    'view.zoom': 'ซูม',
    'view.size': 'ขยาย',
    'view.x': 'ซ้าย - ขวา',
    'view.y': 'ลง - ขึ้น',
    'view.reset': 'รีเซ็ตตำแหน่ง',
  };

  const EN = {
    you: 'You',
    'msg.empty': '(message)',
    'msg.file': '(file)',
    'chat.default': 'Chat',
    'chat.group': 'Group · {members}',
    'chat.direct': 'One-to-one',
    'day.today': 'Today',
    'day.yesterday': 'Yesterday',
    'session.auto': 'New session started automatically',
    'speech.title': 'Read aloud',
    'speech.emotion': 'Emotion',
    'speech.tone': 'Tone',
    'speech.voice': 'Voice',
    'speech.speed': 'Speed',
    'reply.to': 'Replying to {who}',
    'reply.action': 'Reply',
    'forward.action': 'Forward',
    'forward.title': 'Forward message',
    'forward.done': 'Forwarded',
    'forward.to': 'To {chat}',
    'forward.none': 'No other chat to forward to',
    'copy.action': 'Copy',
    'copy.text': 'Copy text',
    'copy.done': 'Copied',
    'copy.fail': 'Could not copy',
    'copy.failHint': 'Select the text and copy it yourself',
    like: 'Like',
    unlike: 'Unlike',
    react: 'React',
    'react.remove': 'Remove this reaction',
    pin: 'Pin',
    unpin: 'Unpin',
    'pins.title': 'Pinned messages',
    'pins.none': 'No pinned messages',
    'pins.unpin': 'Unpin',
    'pins.all': 'All',
    'pins.viewAll': 'View all',
    emoji: 'Emoji',

    'voice.slide': '‹ Slide left to cancel',
    'voice.armed': '🗑 Release to cancel',
    'voice.tapStop': 'Tap the mic to stop',
    'voice.cancel': '✕ Cancel',
    'voice.unsupported': 'Cannot record',
    'voice.unsupportedHint': 'This browser does not support it; attach an audio file instead',
    'voice.micFail': 'Cannot use the microphone',
    'voice.short': 'Too short',
    'voice.shortHint': 'Hold the button and talk, release to send',
    'voice.holdHint': 'Release to send · slide away to cancel',
    'voice.tapHint': 'Tap the mic again to stop · Esc cancels',
    'voice.recording': '● Recording {time} — {how}',

    'top.info': 'Info',
    'top.character': 'Character',
    'top.search': 'Search',
    'top.settingClose': 'Back (close Chat setting)',
    'setting.title': 'Chat setting',
    'setting.fold': 'Fold ▴',
    'setting.foldHint': 'Fold back',
    'setting.characterOn': '🧍 Character: on',
    'setting.characterOff': '🧍 Character: off',
    'setting.characterHint': 'Show or hide the character on the chat screen',
    'setting.characterHide': 'Hide the character (see more of the chat)',
    'setting.characterShow': 'Show the character',
    'setting.search': '⌕ Search',
    'setting.newSession': '+ New session',
    'setting.showPrompt': 'Show prompt',
    'setting.language': 'Language',
    'bubbles.title': 'Messages',
    'bubbles.0': '0 · Hidden',
    'bubbles.0.hint': 'No chat bubbles',
    'bubbles.1': '1 · Latest',
    'bubbles.1.hint': 'Only the newest message',
    'bubbles.2': '2 · All',
    'bubbles.2.hint': 'All messages',
    'composer.placeholder': 'Type a message…',
    'composer.placeholderTo': 'Say hi to {name}…',
    'composer.attachTouch': 'Tap = camera · hold = choose a file',

    'view.title3d': 'Character position (3D)',
    'view.title2d': 'Character position (2D)',
    'view.yaw': 'Turn',
    'view.pitch': 'Tilt',
    'view.zoom': 'Zoom',
    'view.size': 'Size',
    'view.x': 'Left - right',
    'view.y': 'Down - up',
    'view.reset': 'Reset position',
  };

  const LANGUAGES = { th: { name: 'ไทย', table: TH }, en: { name: 'English', table: EN } };
  const KEY = 'mimi.lang';

  const read = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const guess = () => ((navigator.language || 'th').toLowerCase().startsWith('th') ? 'th' : 'en');
  let language = LANGUAGES[read()] ? read() : guess();
  document.documentElement.lang = language;

  window.t = (key, vars) => {
    const text = LANGUAGES[language].table[key] ?? TH[key] ?? key;
    return vars ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole)) : text;
  };
  window.MimiI18n = {
    languages: () => Object.entries(LANGUAGES).map(([code, entry]) => ({ code, name: entry.name })),
    current: () => language,
    /** Switches the language; the screens draw their text again on the next load. */
    set(code) {
      if (!LANGUAGES[code]) return;
      try {
        localStorage.setItem(KEY, code);
      } catch {
        // not remembered
      }
      location.reload();
    },
  };
})();
