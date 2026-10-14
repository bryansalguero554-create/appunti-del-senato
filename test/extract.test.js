import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/extract.js';

test('htmlToText rimuove script e tag mantenendo il testo', () => {
  const text = htmlToText('<h1>Rivoluzione &amp; Impero</h1><script>evil()</script><p>Napoleone<br>1804</p>');
  assert.equal(text, 'Rivoluzione & Impero\nNapoleone\n1804');
});
