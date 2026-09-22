'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../dist/seller-home-model.js');

const now = new Date('2026-09-22T12:00:00Z');
function report(daily, more = {}) {
  return {
    current: { from: '2026-09-18', to: '2026-09-20' },
    days: 3,
    coverage: { orders: true, finance: true },
    metrics: {}, sources: [], stores: [], products: [], daily,
    ...more
  };
}
function point(date, orderedRevenue, orderedUnits, realized) {
  return { date, orderedRevenue, orderedUnits, realized };
}

test('build exposes independent cumulative sums while preserving zero and negative realization', () => {
  const source = report([
    point('2026-09-18', 100, 2, 80),
    point('2026-09-19', 0, 0, -30),
    point('2026-09-20', 25, 1, 10)
  ]);
  const before = structuredClone(source);
  const model = build({ state: 'ready', report: source }, now);
  assert.deepEqual(model.cumulativeDaily, [
    point('2026-09-18', 100, 2, 80),
    point('2026-09-19', 100, 2, 50),
    point('2026-09-20', 125, 3, 60)
  ]);
  assert.deepEqual(model.daily, source.daily);
  assert.deepEqual(source, before);
});

test('an unknown value invalidates only its series from that day onward', () => {
  const values = [
    point('2026-09-18', 10, 1, 7),
    point('2026-09-19', null, 2, Infinity),
    point('2026-09-20', 30, 3, -2)
  ];
  const cumulative = build({ state: 'ready', report: report(values) }, now).cumulativeDaily;
  assert.deepEqual(cumulative, [
    point('2026-09-18', 10, 1, 7),
    point('2026-09-19', null, 3, null),
    point('2026-09-20', null, 6, null)
  ]);
  for (const unknown of [null, undefined, 'not-a-number', Infinity]) {
    const rows = [point('2026-09-18', unknown, 1, 2), point('2026-09-19', 5, 1, 2)];
    const result = build({ state: 'ready', report: report(rows) }, now).cumulativeDaily;
    assert.deepEqual(result.map(day => day.orderedRevenue), [null, null]);
    assert.deepEqual(result.map(day => day.orderedUnits), [1, 2]);
    assert.deepEqual(result.map(day => day.realized), [2, 4]);
  }
});

test('a missing or unordered date invalidates every later cumulative series', () => {
  for (const dates of [
    ['2026-09-18', '2026-09-20'],
    ['2026-09-18', '2026-09-17', '2026-09-19']
  ]) {
    const cumulative = build({ state: 'ready', report: report(dates.map(date => point(date, 5, 1, -1))) }, now).cumulativeDaily;
    assert.deepEqual(cumulative[0], point('2026-09-18', 5, 1, -1));
    assert.ok(cumulative.slice(1).every(day => day.orderedRevenue === null && day.orderedUnits === null && day.realized === null));
  }
});

test('the first occurrence of a duplicate date is already ambiguous', () => {
  const cumulative = build({ state: 'ready', report: report([
    point('2026-09-18', 5, 1, 2),
    point('2026-09-19', 7, 2, 3),
    point('2026-09-19', 11, 4, 5)
  ]) }, now).cumulativeDaily;
  assert.deepEqual(cumulative[0], point('2026-09-18', 5, 1, 2));
  assert.deepEqual(cumulative.slice(1), [
    point('2026-09-19', null, null, null),
    point('2026-09-19', null, null, null)
  ]);
});

test('numeric overflow invalidates only the overflowing series and never exposes Infinity', () => {
  const cumulative = build({ state: 'ready', report: report([
    point('2026-09-18', 1e308, 1, -4),
    point('2026-09-19', 1e308, 2, 1),
    point('2026-09-20', -1e308, 3, 1)
  ]) }, now).cumulativeDaily;
  assert.deepEqual(cumulative.map(day => day.orderedRevenue), [1e308, null, null]);
  assert.deepEqual(cumulative.map(day => day.orderedUnits), [1, 3, 6]);
  assert.deepEqual(cumulative.map(day => day.realized), [-4, -3, -2]);
  assert.doesNotMatch(JSON.stringify(cumulative), /Infinity/);
});

test('a series that does not begin at period.from has no trustworthy cumulative total', () => {
  const cumulative = build({ state: 'ready', report: report([
    point('2026-09-19', 10, 1, 8), point('2026-09-20', 20, 2, 9)
  ]) }, now).cumulativeDaily;
  assert.ok(cumulative.every(day => day.orderedRevenue === null && day.orderedUnits === null && day.realized === null));
});

test('coverage masking is retained and each scope is rebuilt only from its own report', () => {
  const first = report([point('2026-09-18', 100, 4, 80)]);
  first.current.to = '2026-09-18'; first.days = 1;
  const second = report([point('2026-09-18', 3, 1, 2)]);
  second.current.to = '2026-09-18'; second.days = 1;
  second.coverage.orders = false;
  const firstModel = build({ state: 'ready', report: first, store: 'first' }, now);
  const secondModel = build({ state: 'ready', report: second, store: 'second' }, now);
  assert.deepEqual(firstModel.cumulativeDaily, [point('2026-09-18', 100, 4, 80)]);
  assert.deepEqual(secondModel.daily, [point('2026-09-18', null, null, 2)]);
  assert.deepEqual(secondModel.cumulativeDaily, [point('2026-09-18', null, null, 2)]);
});
