const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SplitXSync = require('../js/SplitXSync.js');
const SplitXCuadre = require('../js/SplitXCuadre.js');
const SplitXState = require('../js/SplitXState.js');

describe('SplitXSync: multi-tab CAS (_rev / _epoch) state machine', () => {
    const makeHarness = (initialState = { employees: [], inventory: {} }) => {
        let rawStorage = null;
        let state = JSON.parse(JSON.stringify(initialState));
        const writes = [];
        let reloads = 0;
        let beforeCommits = 0;
        let afterCommits = 0;
        let modalCalls = 0;
        let resolveModal = null;

        const sync = SplitXSync.createSyncController({
            getState: () => state,
            readRaw: () => rawStorage,
            writeRaw: (val) => {
                rawStorage = val;
                writes.push(JSON.parse(val));
            },
            parseSavedState: SplitXState.parseSavedState,
            schemaVersion: SplitXState.SCHEMA_VERSION,
            showCustomChoice: () => {
                modalCalls += 1;
                return new Promise((res) => { resolveModal = res; });
            },
            onReload: () => { reloads += 1; },
            onBeforeCommit: () => { beforeCommits += 1; },
            onAfterCommit: () => { afterCommits += 1; },
            onConflictBlocked: () => {}
        });

        return {
            sync,
            getState: () => state,
            setRaw: (obj) => { rawStorage = JSON.stringify(obj); },
            getRawObj: () => (rawStorage ? JSON.parse(rawStorage) : null),
            getWrites: () => writes,
            getModalCalls: () => modalCalls,
            getReloads: () => reloads,
            getBeforeCommits: () => beforeCommits,
            getAfterCommits: () => afterCommits,
            answerModal: async (choice) => {
                const fn = resolveModal;
                resolveModal = null;
                fn(choice);
                await Promise.resolve();
                await Promise.resolve();
            }
        };
    };

    test('monotonic single-tab writes advance _rev and preserve _epoch', () => {
        const h = makeHarness({ employees: [{ id: 1, name: 'Ana', amount: 1000 }] });
        assert.equal(h.sync.save(), true);
        assert.equal(h.sync.save(), true);
        assert.equal(h.getWrites().length, 2);
        assert.equal(h.getWrites()[0]._rev, 1);
        assert.equal(h.getWrites()[1]._rev, 2);
        assert.equal(h.getWrites()[0]._epoch, h.getWrites()[1]._epoch);
        assert.equal(h.getModalCalls(), 0);
    });

    test('re-entrant save() while CAS modal is open NEVER overwrites storage and opens only 1 modal', async () => {
        const h = makeHarness({ employees: [{ id: 1, name: 'TabA', amount: 1000 }] });
        assert.equal(h.sync.save(), true); // _rev = 1
        const tabAEpoch = h.getRawObj()._epoch;

        // Tab B advances storage to _rev = 5
        h.setRaw({ _rev: 5, _epoch: tabAEpoch, employees: [{ id: 99, name: 'TabB', amount: 5000 }] });

        // First conflicting write -> blocked, modal opens
        assert.equal(h.sync.save(), false);
        assert.equal(h.getModalCalls(), 1);

        // Second & third re-entrant writes while modal is open -> MUST still be blocked!
        assert.equal(h.sync.save(), false);
        assert.equal(h.sync.save(), false);
        assert.equal(h.getModalCalls(), 1, 'must not stack duplicate CAS modals');
        assert.equal(h.getRawObj()._rev, 5, 'storage must remain untouched at Tab B rev');
        assert.equal(h.getRawObj().employees[0].name, 'TabB');

        // Pressing Escape (resolves false) -> safe no-op
        await h.answerModal(false);
        assert.equal(h.getRawObj()._rev, 5);
        assert.equal(h.getRawObj().employees[0].name, 'TabB');
        assert.equal(h.getReloads(), 0);
    });

    test('explicit overwrite re-reads latest _rev (eliminating TOCTOU) and mints a fresh _epoch', async () => {
        const h = makeHarness({ employees: [{ id: 1, name: 'TabA', amount: 1000 }] });
        assert.equal(h.sync.save(), true);
        const origEpoch = h.getRawObj()._epoch;

        // Tab B writes _rev 4
        h.setRaw({ _rev: 4, _epoch: origEpoch, employees: [{ id: 2, name: 'TabB1', amount: 2000 }] });
        assert.equal(h.sync.save(), false);

        // While modal is open, Tab B writes again to _rev 9!
        h.setRaw({ _rev: 9, _epoch: origEpoch, employees: [{ id: 3, name: 'TabB2', amount: 3000 }] });

        await h.answerModal('overwrite');
        const finalStored = h.getRawObj();
        assert.equal(finalStored._rev, 10, 'must advance past latest stored rev (9 -> 10)');
        assert.notEqual(finalStored._epoch, origEpoch, 'must mint a fresh epoch so Tab B detects divergence');
        assert.equal(finalStored.employees[0].name, 'TabA');
    });

    test('epoch divergence (backup restored in another tab) triggers conflict even if _rev is lower', async () => {
        const h = makeHarness({ employees: [] });
        assert.equal(h.sync.save(), true);
        assert.equal(h.sync.save(), true); // _rev = 2

        // Another tab restored a backup with _rev = 1 but different _epoch
        h.setRaw({ _rev: 1, _epoch: 'restored-epoch-xyz', employees: [{ id: 7, name: 'Restored', amount: 700 }] });
        assert.equal(h.sync.save(), false);
        assert.equal(h.getModalCalls(), 1);
        await h.answerModal('reload');
        assert.equal(h.getReloads(), 1);
        assert.equal(h.getRawObj().employees[0].name, 'Restored');
    });

    test('handleExternalStorage detects newer rev or distinct epoch from storage event', () => {
        const h = makeHarness();
        h.sync.syncFromLoaded({ _rev: 3, _epoch: 'ep-1' });
        assert.equal(h.sync.handleExternalStorage(JSON.stringify({ _rev: 3, _epoch: 'ep-1' })), false);
        assert.equal(h.sync.handleExternalStorage(JSON.stringify({ _rev: 4, _epoch: 'ep-1' })), true);
        assert.equal(h.sync.handleExternalStorage(JSON.stringify({ _rev: 2, _epoch: 'ep-2' })), true);
    });
});

describe('SplitXCuadre: physical count variance, clamping & zero-variance bill swap', () => {
    const denoms = [2000, 1000, 500];

    test('sanitizeActualCountInput handles empty, negative, fractional, and valid integer counts', () => {
        assert.deepEqual(SplitXCuadre.sanitizeActualCountInput(''), { empty: true, qty: null, normalizedText: '' });
        assert.deepEqual(SplitXCuadre.sanitizeActualCountInput('  '), { empty: true, qty: null, normalizedText: '' });
        assert.deepEqual(SplitXCuadre.sanitizeActualCountInput('-3'), { empty: false, qty: 0, normalizedText: '0' });
        assert.deepEqual(SplitXCuadre.sanitizeActualCountInput('2.9'), { empty: false, qty: 2, normalizedText: '2' });
        assert.deepEqual(SplitXCuadre.sanitizeActualCountInput('4'), { empty: false, qty: 4, normalizedText: '4' });
    });

    test('computeVariance evaluates strictly over entered denominations without fabricating uncounted cash', () => {
        const ledger = {
            physicalLooseOnTable: { 2000: 2, 1000: 1, 500: 3 },
            committedBills: { 2000: 1, 1000: 0, 500: 0 },
            overcommitTotal: 0
        };
        const partial = SplitXCuadre.computeVariance({
            denominations: denoms,
            ledger,
            actualCounts: new Map([[2000, 2]])
        });
        assert.equal(partial.status, 'exact_partial');
        assert.equal(partial.enteredCount, 1);
        assert.equal(partial.totalDenoms, 3);
        assert.equal(partial.expectedCents, 400000);
        assert.equal(partial.actualCents, 400000);
        assert.equal(partial.deltaCents, 0);
    });

    test('computeVariance blocks green reconciliation when overcommitTotal > 0', () => {
        const ledger = {
            physicalLooseOnTable: { 2000: 0, 1000: 0, 500: 0 },
            committedBills: { 2000: 1, 1000: 0, 500: 0 },
            overcommitTotal: 2000
        };
        const res = SplitXCuadre.computeVariance({
            denominations: denoms,
            ledger,
            actualCounts: new Map([[2000, 0], [1000, 0], [500, 0]])
        });
        assert.equal(res.status, 'overcommit');
    });

    test('buildSwappedInventory applies zero-variance bill swap preserving committedBills and totalBox', () => {
        const ledger = {
            physicalLooseOnTable: { 2000: 1, 1000: 0, 500: 2 },
            committedBills: { 2000: 1, 1000: 1, 500: 0 },
            overcommitTotal: 0
        };
        const inventory = { 2000: 2, 1000: 1, 500: 2 }; // total = 6000
        const actualCounts = new Map([[2000, 0], [1000, 2]]); // swapped 1x2000 -> 2x1000

        const swapped = SplitXCuadre.buildSwappedInventory({
            inventory,
            denominations: denoms,
            ledger,
            actualCounts
        });
        assert.equal(swapped.ok, true);
        // committed(1) + loose(0) = 1 for 2000; committed(1) + loose(2) = 3 for 1000; 500 untouched = 2
        assert.deepEqual(swapped.nextInventory, { 2000: 1, 1000: 3, 500: 2 });
        const totalBefore = 2 * 2000 + 1 * 1000 + 2 * 500;
        const totalAfter = swapped.nextInventory[2000] * 2000 + swapped.nextInventory[1000] * 1000 + swapped.nextInventory[500] * 500;
        assert.equal(totalAfter, totalBefore, 'swap must conserve totalBox to the exact cent');
        assert.match(swapped.summaryText, /−1×2000/);
        assert.match(swapped.summaryText, /\+2×1000/);

        // Reject non-zero variance swap
        const badSwap = SplitXCuadre.buildSwappedInventory({
            inventory,
            denominations: denoms,
            ledger,
            actualCounts: new Map([[2000, 0], [1000, 1]]) // missing 1000!
        });
        assert.equal(badSwap.ok, false);
    });
});
