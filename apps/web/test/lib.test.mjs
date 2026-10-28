import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice, dishImages, groupCategories, trayTotal, trayCount, trayToItems, secondsLeft, progressPercent } from '../src/lib.js';

test('formatPrice', () => {
  assert.equal(formatPrice(650), '650 MT');
  assert.equal(formatPrice(1470), '1 470 MT');
  assert.equal(formatPrice('12.5'), '12,50 MT');
  assert.equal(formatPrice('abc'), '');
});
test('dishImages junta image_url e image_urls sem repetir', () => {
  assert.deepEqual(dishImages({ image_url: '/a.webp', image_urls: '["/a.webp","/b.webp"]' }), ['/a.webp', '/b.webp']);
  assert.deepEqual(dishImages({ image_urls: 'lixo' }), []);
  assert.deepEqual(dishImages({}), []);
});
test('categorias', () => {
  assert.deepEqual(groupCategories([{ category_name: 'A' }, { category_name: 'A' }, {}]), [{ name: 'A', count: 2 }, { name: 'Outros', count: 1 }]);
});
test('bandeja', () => {
  const map = new Map([[1, { price: '650' }], [2, { price: 120 }]]);
  assert.equal(trayTotal({ 1: 1, 2: 2, 9: 5 }, map), 890);
  assert.equal(trayCount({ 1: 1, 2: 2 }), 3);
  assert.deepEqual(trayToItems({ 1: 1, 2: 0 }), [{ dish_id: 1, quantity: 1 }]);
});
test('secondsLeft aceita ISO e formato SQLite (UTC)', () => {
  const now = Date.parse('2026-10-27T10:00:00Z');
  assert.equal(secondsLeft('2026-10-27T10:02:00Z', now), 120);
  assert.equal(secondsLeft('2026-10-27 10:02:00', now), 120);
  assert.equal(secondsLeft('2026-10-27 09:00:00', now), 0);
  assert.equal(secondsLeft(null, now), 0);
});
test('progresso', () => {
  assert.equal(progressPercent('pending'), 33);
  assert.equal(progressPercent('completed'), 100);
  assert.equal(progressPercent('cancelled'), 0);
});
