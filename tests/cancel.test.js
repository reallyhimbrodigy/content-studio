'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isJobCancellable, shouldRefundOnCancel } = require('../lib/cancel');

test('cancellable while queued/processing', () => {
  assert.equal(isJobCancellable({ status: 'queued' }), true);
  assert.equal(isJobCancellable({ status: 'processing' }), true);
  assert.equal(isJobCancellable({ status: 'PROCESSING' }), true); // case-insensitive
});

test('NOT cancellable once terminal', () => {
  assert.equal(isJobCancellable({ status: 'completed' }), false);
  assert.equal(isJobCancellable({ status: 'failed' }), false);
  assert.equal(isJobCancellable({ status: 'cancelled' }), false);
});

test('null / malformed job is not cancellable', () => {
  assert.equal(isJobCancellable(null), false);
  assert.equal(isJobCancellable(undefined), false);
  assert.equal(isJobCancellable({}), false); // no status -> '' -> not terminal... but no job data
  assert.equal(isJobCancellable('nope'), false);
});

test('refund only when actually cancellable (never on a finished render)', () => {
  assert.equal(shouldRefundOnCancel({ status: 'processing' }), true);
  assert.equal(shouldRefundOnCancel({ status: 'completed' }), false);
  assert.equal(shouldRefundOnCancel({ status: 'cancelled' }), false);
});
