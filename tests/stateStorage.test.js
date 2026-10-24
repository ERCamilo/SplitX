/**
 * Resilient loading of persisted state (Split_data) tests.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseSavedState } = require('../js/SplitXState.js');

describe('parseSavedState', () => {
    test('returns the parsed object for valid JSON', () => {
        const res = parseSavedState('{"currency":"USD","employees":[]}');
        assert.equal(res.ok, true);
        assert.deepEqual(res.data, { currency: 'USD', employees: [] });
    });

    test('returns empty result when nothing is stored', () => {
        const res = parseSavedState(null);
        assert.equal(res.ok, true);
        assert.equal(res.data, null);
    });

    test('does not throw on corrupted JSON and keeps the raw value as backup', () => {
        const raw = '{"currency":"USD","employees":[{"id":1';
        const res = parseSavedState(raw);
        assert.equal(res.ok, false);
        assert.equal(res.data, null);
        assert.equal(res.backup, raw);
    });

    test('rejects valid JSON that is not a plain object', () => {
        for (const raw of ['[]', '"text"', '42', 'null']) {
            const res = parseSavedState(raw);
            assert.equal(res.ok, false, raw);
            assert.equal(res.backup, raw);
        }
    });
});
