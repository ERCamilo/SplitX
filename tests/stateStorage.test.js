/**
 * Resilient loading of persisted state (Split_data) tests.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SplitXState = require('../js/SplitXState.js');
const SplitXStorage = require('../js/SplitXStorage.js');
const { parseSavedState } = SplitXState;

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

describe('loadOrRecoverState & corrupt backup persistence (Issue #9)', () => {
    const makeStore = ({ failSetReason = null } = {}) => {
        const map = new Map();
        const backend = {
            getItem: (k) => (map.has(k) ? map.get(k) : null),
            setItem: (k, v) => {
                if (failSetReason === 'quota') {
                    const e = new Error('QuotaExceeded');
                    e.name = 'QuotaExceededError';
                    throw e;
                }
                if (failSetReason === 'blocked') {
                    throw new Error('SecurityError');
                }
                map.set(k, String(v));
            },
            removeItem: (k) => map.delete(k)
        };
        return { map, storage: SplitXStorage.createStorage({ backend }) };
    };

    test('saves corrupt backup on first failure and preserves it without overwriting on subsequent reload', () => {
        const { map, storage } = makeStore();
        map.set(SplitXStorage.KEYS.DATA, '{"broken":');

        const first = SplitXState.loadOrRecoverState(storage, SplitXStorage.KEYS);
        assert.equal(first.ok, false);
        assert.equal(first.backupSaved, true);
        assert.equal(first.backupError, null);
        assert.equal(map.get(SplitXStorage.KEYS.CORRUPT_BACKUP), '{"broken":');

        // A second corrupt value must NOT overwrite the unrecovered backup
        map.set(SplitXStorage.KEYS.DATA, '{"newer_broken":');
        const second = SplitXState.loadOrRecoverState(storage, SplitXStorage.KEYS);
        assert.equal(second.ok, false);
        assert.equal(second.backupSaved, true);
        assert.equal(second.preservedExisting, true);
        assert.equal(map.get(SplitXStorage.KEYS.CORRUPT_BACKUP), '{"broken":');
    });

    test('reports backupSaved=false and reason when persisting backup fails (quota/blocked), keeping rawBackup for download', () => {
        for (const reason of ['quota', 'blocked']) {
            const { map, storage } = makeStore({ failSetReason: reason });
            map.set(SplitXStorage.KEYS.DATA, '{"employees":[{"name":"Ana"');

            const res = SplitXState.loadOrRecoverState(storage, SplitXStorage.KEYS);
            assert.equal(res.ok, false);
            assert.equal(res.backupSaved, false);
            assert.equal(res.backupError, reason);
            assert.equal(res.rawBackup, '{"employees":[{"name":"Ana"');
        }
    });

    test('clearCorruptBackup deletes persisted backup cleanly', () => {
        const { map, storage } = makeStore();
        map.set(SplitXStorage.KEYS.CORRUPT_BACKUP, '{"broken":');
        assert.equal(SplitXState.getCorruptBackup(storage, SplitXStorage.KEYS), '{"broken":');
        SplitXState.clearCorruptBackup(storage, SplitXStorage.KEYS);
        assert.equal(SplitXState.getCorruptBackup(storage, SplitXStorage.KEYS), null);
    });
});
