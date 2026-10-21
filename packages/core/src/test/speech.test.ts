import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpeech, stripSpeechFromContent } from '@mimi/shared';

test('speech: reads a voice direction line and removes it', () => {
  assert.deepEqual(parseSpeech('[emotion: เศร้า][tone: กระซิบ][speed: 0.9]\nฉันขอโทษ'), {
    text: 'ฉันขอโทษ',
    speech: { emotion: 'เศร้า', tone: 'กระซิบ', speed: 0.9 },
  });
});

test('speech: clamps speed and ignores empty values', () => {
  assert.deepEqual(parseSpeech('[speed: 9][voice:]\nพูดเร็ว'), {
    text: 'พูดเร็ว',
    speech: { speed: 2 },
  });
});

test('speech: leaves ordinary brackets and inline tags alone', () => {
  assert.deepEqual(parseSpeech('ดู [1] และ [ลิงก์]'), { text: 'ดู [1] และ [ลิงก์]' });
  assert.deepEqual(parseSpeech('[whispers] สวัสดี'), { text: '[whispers] สวัสดี' });
  assert.deepEqual(parseSpeech('[emotion: เศร้า] ยังมีข้อความบรรทัดเดียวกัน'), {
    text: '[emotion: เศร้า] ยังมีข้อความบรรทัดเดียวกัน',
  });
  assert.deepEqual(parseSpeech('[unknown: x]\nข้อความ'), { text: '[unknown: x]\nข้อความ' });
});

test('speech: strips the direction from content parts', () => {
  assert.deepEqual(
    stripSpeechFromContent([
      { type: 'text', text: '[tone: นุ่มนวล]\nสวัสดีค่ะ' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: {} },
    ]),
    {
      content: [
        { type: 'text', text: 'สวัสดีค่ะ' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: {} },
      ],
      speech: { tone: 'นุ่มนวล' },
    },
  );
  const later = [
    { type: 'text', text: 'สวัสดี' },
    { type: 'text', text: '[tone: นุ่มนวล]\nข้อความถัดไป' },
  ];
  assert.deepEqual(stripSpeechFromContent(later), { content: later });
});
