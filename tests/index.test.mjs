import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createBitmapIndex, BitmapIndexError } from '../dist/esm/index.js';

const require = createRequire(import.meta.url);

test('CommonJS build performs bitmap queries', () => {
  const { createBitmapIndex: createCjsIndex } = require('../dist/cjs/index.js');
  const index = createCjsIndex();
  index.set('cjs', { flag: true });
  assert.deepEqual(index.query({ field: 'flag', op: 'eq', value: true }), ['cjs']);
});

test('exact-value query returns matching rows in stable order', () => {
  const index = createBitmapIndex({ maxRows: 10 });
  index.set('z', { state: 'ok' });
  index.set('a', { state: 'ok' });
  index.set('other', { state: 'no' });
  assert.deepEqual(index.query({ field: 'state', op: 'eq', value: 'ok' }), ['a', 'z']);
});

test('in query unions distinct value bitmaps', () => {
  const index = createBitmapIndex({ maxRows: 10 });
  index.set('a', { kind: 'x' });
  index.set('b', { kind: 'y' });
  index.set('c', { kind: 'z' });
  assert.deepEqual(index.query({ field: 'kind', op: 'in', values: ['x', 'z', 'x'] }), ['a', 'c']);
});

test('not query complements only rows with the requested field', () => {
  const index = createBitmapIndex({ maxRows: 10 });
  index.set('a', { kind: 'x' });
  index.set('b', { kind: 'y' });
  index.set('missing', { other: 'x' });
  assert.deepEqual(index.query({ field: 'kind', op: 'not', value: 'x' }), ['b']);
});

test('value types remain distinct and finite numeric values are accepted', () => {
  const index = createBitmapIndex({ maxRows: 8 });
  index.set('string', { value: '1' });
  index.set('number', { value: 1 });
  index.set('bool', { value: true });
  assert.deepEqual(index.query({ field: 'value', op: 'eq', value: 1 }), ['number']);
  assert.deepEqual(index.query({ field: 'value', op: 'eq', value: '1' }), ['string']);
});

test('updates move rows between bitmaps and free obsolete categories', () => {
  const index = createBitmapIndex({ maxRows: 2, maxValuesPerField: 1 });
  index.set('a', { value: 'old' });
  index.set('a', { value: 'new' });
  assert.deepEqual(index.query({ field: 'value', op: 'eq', value: 'old' }), []);
  assert.deepEqual(index.query({ field: 'value', op: 'eq', value: 'new' }), ['a']);
});

test('failed update is atomic at row and value capacity', () => {
  const index = createBitmapIndex({ maxRows: 2, maxFields: 1, maxValuesPerField: 1 });
  index.set('a', { value: 'old' });
  assert.throws(() => index.set('a', { value: 'new', second: true }), BitmapIndexError);
  assert.deepEqual(index.query({ field: 'value', op: 'eq', value: 'old' }), ['a']);
});

test('row and bitmap memory limits are explicit', () => {
  const tooSmall = createBitmapIndex({ maxRows: 32, maxBitmapBytes: 1 });
  assert.throws(() => tooSmall.set('a', { value: 'x' }), BitmapIndexError);
  const index = createBitmapIndex({ maxRows: 2, maxBitmapBytes: 4 });
  index.set('a', { value: 'x' });
  assert.throws(() => index.set('b', { value: 'y' }), BitmapIndexError);
});

test('remove and slot reuse do not leave stale bits', () => {
  const index = createBitmapIndex({ maxRows: 1 });
  index.set('first', { value: 'x' });
  assert.equal(index.remove('first'), true);
  index.set('second', { value: 'y' });
  assert.deepEqual(index.query({ field: 'value', op: 'eq', value: 'x' }), []);
  assert.deepEqual(index.query({ field: 'value', op: 'eq', value: 'y' }), ['second']);
});

test('clear releases rows and permits reinsertion', () => {
  const index = createBitmapIndex({ maxRows: 1 });
  index.set('a', { x: 1 });
  index.clear();
  assert.equal(index.size, 0);
  index.set('b', { y: 2 });
  assert.equal(index.size, 1);
});

test('validates ids, record data, query values, and unknown fields', () => {
  const index = createBitmapIndex({ maxRows: 10 });
  assert.throws(() => index.set('', { x: 1 }), TypeError);
  assert.throws(() => index.set('bad', { x: Infinity }), TypeError);
  index.set('ok', { x: 1 });
  assert.throws(() => index.query({ field: 'missing', op: 'eq', value: 1 }), BitmapIndexError);
  assert.throws(() => index.query({ field: 'x', op: 'in', values: [] }), RangeError);
});

test('field count and category count have configured ceilings', () => {
  const index = createBitmapIndex({ maxRows: 5, maxFields: 1, maxValuesPerField: 1 });
  index.set('a', { x: 'v' });
  assert.throws(() => index.set('b', { x: 'other' }), BitmapIndexError);
  assert.throws(() => index.set('a', { x: 'v', y: 'v' }), BitmapIndexError);
});

test('replacement can exchange a field at the field limit', () => {
  const index = createBitmapIndex({ maxRows: 1, maxFields: 1 });
  index.set('a', { old: 'value' });
  index.set('a', { next: 'value' });
  assert.throws(() => index.query({ field: 'old', op: 'eq', value: 'value' }), BitmapIndexError);
  assert.deepEqual(index.query({ field: 'next', op: 'eq', value: 'value' }), ['a']);
});

test('generated queries match a direct row-scan oracle', () => {
  const index = createBitmapIndex({ maxRows: 300, maxValuesPerField: 30 });
  const rows = new Map();
  for (let i = 0; i < 250; i++) {
    const record = {};
    if (i % 5 !== 0) record.group = `g${(i * 17) % 11}`;
    if (i % 3 !== 0) record.active = i % 2 === 0;
    rows.set(`r${i}`, record);
    index.set(`r${i}`, record);
  }
  for (const value of ['g0', 'g1', 'g5', 'absent']) {
    const expected = [...rows]
      .filter(([, row]) => row.group === value)
      .map(([id]) => id)
      .sort();
    assert.deepEqual(index.query({ field: 'group', op: 'eq', value }), expected);
    const notExpected = [...rows]
      .filter(([, row]) => row.group !== undefined && row.group !== value)
      .map(([id]) => id)
      .sort();
    assert.deepEqual(index.query({ field: 'group', op: 'not', value }), notExpected);
  }
});
