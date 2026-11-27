const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SplitXStorage = require('../js/SplitXStorage.js');
const SplitXBackup = require('../js/SplitXBackup.js');

const makeMemoryStorage = () => {
    const map = new Map();
    return SplitXStorage.createStorage({
        backend: {
            getItem: (k) => (map.has(k) ? map.get(k) : null),
            setItem: (k, v) => map.set(k, String(v)),
            removeItem: (k) => map.delete(k)
        }
    });
};

describe('SplitXBackup: full versioned backup & validated restore (Issue #11)', () => {
    test('round-trip preserves employees, inventory, currency, history, sheets and documents without data loss', () => {
        const storage = makeMemoryStorage();
        const data = {
            currency: 'EUR',
            currencySymbol: '€',
            denominations: [100, 50, 20, 10],
            inventory: { 100: 5, 50: 2 },
            employees: [{ id: 1, name: 'Ana', amount: 150, paid: false }],
            bankLimits: { 100: 10 },
            theme: 'dark'
        };
        const history = [{ id: 'h1', importedAt: '2026-11-25T00:00:00Z', source: 'sa', title: 'Quincena 1', subtitle: '', period: null, currency: 'EUR', count: 1, total: 150, signature: '1:abc', context: null, employees: data.employees }];
        const sheets = { version: 2, templates: [], active: { A: null, B: null }, colors: true, logo: 'data:image/png;base64,AAAA', recent: [] };
        const documents = { version: 1, activeId: 'carta-ingreso', templates: [{ id: 'carta-ingreso', name: 'Carta', html: '<p>{{name}}</p>' }], people: { 'id:1': { idNumber: '001-1234567-8', address: 'Calle 1' } } };

        storage.set(SplitXStorage.KEYS.DATA, JSON.stringify(data));
        storage.set(SplitXStorage.KEYS.HISTORY, JSON.stringify(history));
        storage.set(SplitXStorage.KEYS.SHEETS, JSON.stringify(sheets));
        storage.set(SplitXStorage.KEYS.DOCUMENTS, JSON.stringify(documents));

        const json = SplitXBackup.serializeBackup(storage, new Date('2026-11-25T10:00:00Z'));
        const parsed = JSON.parse(json);
        assert.equal(parsed.schema, 'splitx-backup/v1');
        assert.equal(parsed.version, 1);
        assert.equal(parsed.summary.employees, 1);
        assert.equal(parsed.summary.currency, 'EUR');
        assert.equal(parsed.summary.historyCount, 1);
        assert.equal(parsed.summary.docPeopleCount, 1);

        // Wipe everything and restore from backup
        storage.clearAll();
        assert.equal(storage.get(SplitXStorage.KEYS.DATA), null);

        const restored = SplitXBackup.restoreBackup(storage, json);
        assert.equal(restored.ok, true);
        assert.deepEqual(JSON.parse(storage.get(SplitXStorage.KEYS.DATA)), data);
        assert.deepEqual(JSON.parse(storage.get(SplitXStorage.KEYS.HISTORY)), history);
        assert.deepEqual(JSON.parse(storage.get(SplitXStorage.KEYS.SHEETS)), sheets);
        assert.deepEqual(JSON.parse(storage.get(SplitXStorage.KEYS.DOCUMENTS)), documents);
    });

    test('invalid backup is rejected atomically without touching existing stored data', () => {
        const storage = makeMemoryStorage();
        const original = JSON.stringify({ currency: 'DOP', employees: [{ id: 1, name: 'KeepMe', amount: 500 }] });
        storage.set(SplitXStorage.KEYS.DATA, original);

        for (const bad of [
            'not-json',
            '[]',
            JSON.stringify({ schema: 'wrong', version: 1, payload: {} }),
            JSON.stringify({ schema: 'splitx-backup/v1', version: 99, payload: {} }),
            JSON.stringify({ schema: 'splitx-backup/v1', version: 1, payload: { data: { employees: 'not-array' } } })
        ]) {
            assert.throws(() => SplitXBackup.restoreBackup(storage, bad));
            assert.equal(storage.get(SplitXStorage.KEYS.DATA), original, 'existing data must remain untouched');
        }
    });

    test('validateBackup sanitizes unsafe currencySymbol, billColors and SVG logo before restoring', () => {
        const dirty = {
            schema: 'splitx-backup/v1',
            version: 1,
            exportedAt: '2026-11-25T00:00:00Z',
            payload: {
                data: {
                    currency: 'DOP',
                    currencySymbol: '<img src=x onerror=1>',
                    employees: [],
                    billColors: { 1000: '#ff0000', 500: 'red;background:url(evil)' },
                    billImages: { 1000: 'data:image/svg+xml;base64,PHN2Zz4=' }
                },
                history: null,
                sheets: { version: 2, logo: 'data:image/svg+xml;base64,PHN2Zz4=' },
                documents: null
            }
        };
        const clean = SplitXBackup.validateBackup(dirty);
        assert.equal(clean.payload.data.currencySymbol.includes('<'), false);
        assert.equal(clean.payload.data.billColors[1000], '#ff0000');
        assert.equal(clean.payload.data.billColors[500], undefined);
        assert.equal(clean.payload.data.billImages[1000], undefined);
        assert.equal(clean.payload.sheets.logo, null);
    });

    test('validateBackup sanitizes malicious denominations, coinDenoms and history IDs (DOM XSS defense)', () => {
        const dirty = {
            schema: 'splitx-backup/v1',
            version: 1,
            exportedAt: '2026-11-25T00:00:00Z',
            payload: {
                data: {
                    currency: 'DOP',
                    denominations: [1000, "1);alert(1);//", 500, -10, 0, 'NaN', 500],
                    coinDenoms: [25, "5);alert(2);//", -1],
                    employees: []
                },
                history: [
                    { id: '1:abc123-m5x9a', importedAt: '2026-11-25T00:00:00Z', source: 'excel', title: 'Ok', subtitle: '', period: null, currency: 'DOP', count: 0, total: 0, signature: '0:0', context: null, employees: [] },
                    { id: "x');alert(1);//", importedAt: '2026-11-25T00:00:00Z', source: 'excel', title: 'Crafted', subtitle: '', period: null, currency: 'DOP', count: 0, total: 0, signature: '0:0', context: null, employees: [] }
                ],
                sheets: null,
                documents: null
            }
        };
        const clean = SplitXBackup.validateBackup(dirty);
        assert.deepEqual(clean.payload.data.denominations, [1000, 500]);
        assert.deepEqual(clean.payload.data.coinDenoms, [25]);
        assert.equal(clean.payload.history[0].id, '1:abc123-m5x9a');
        assert.match(clean.payload.history[1].id, /^[A-Za-z0-9:_-]{1,120}$/);
        assert.equal(clean.payload.history[1].id.includes("'"), false);
        assert.equal(clean.payload.history[1].id.includes('('), false);

        const allBadDenoms = {
            schema: 'splitx-backup/v1',
            version: 1,
            payload: { data: { denominations: ["1);alert(1);//", 0, -5], employees: [] }, history: null, sheets: null, documents: null }
        };
        const cleanAllBad = SplitXBackup.validateBackup(allBadDenoms);
        assert.equal(cleanAllBad.payload.data.denominations, undefined);
    });

    test('purgeDocumentPii removes employee cédulas/addresses while keeping document templates', () => {
        const storage = makeMemoryStorage();
        const docs = {
            version: 1,
            activeId: 'carta-ingreso',
            templates: [{ id: 'carta-ingreso', name: 'Carta', html: '<p>{{name}}</p>' }],
            people: {
                'id:1': { idNumber: '001-1111111-1', address: 'Av. 1', monthlySalary: '25000' },
                'id:2': { idNumber: '001-2222222-2', address: 'Av. 2' }
            }
        };
        storage.set(SplitXStorage.KEYS.DOCUMENTS, JSON.stringify(docs));

        const res = SplitXBackup.purgeDocumentPii(storage);
        assert.equal(res.purged, 2);
        const after = JSON.parse(storage.get(SplitXStorage.KEYS.DOCUMENTS));
        assert.equal(after.templates.length, 1);
        assert.deepEqual(after.people, {});
    });

    test('validateBackup preserves and sanitizes 3-state payoutStatus, lockedDistribution, statusColorScheme and cardNumberMode', () => {
        const input = {
            schema: 'splitx-backup/v1',
            version: 1,
            exportedAt: '2026-11-26T00:00:00Z',
            payload: {
                data: {
                    currency: 'DOP',
                    statusColorScheme: 'classic',
                    cardNumberMode: 'order',
                    employees: [
                        { id: 1, name: 'Ana', amount: 2500, paid: false, payoutStatus: 'packed', lockedDistribution: { 2000: 1, 500: 1, '-5': 2, bad: 'x' } },
                        { id: 2, name: 'Luis', amount: 1000, paid: false, payoutStatus: 'invalid_state', lockedDistribution: 'nope' }
                    ]
                },
                history: null,
                sheets: null,
                documents: null
            }
        };
        const clean = SplitXBackup.validateBackup(input);
        assert.equal(clean.payload.data.statusColorScheme, 'classic');
        assert.equal(clean.payload.data.cardNumberMode, 'order');
        assert.equal(clean.payload.data.employees[0].payoutStatus, 'packed');
        assert.equal(clean.payload.data.employees[0].paid, false);
        assert.deepEqual(clean.payload.data.employees[0].lockedDistribution, { 2000: 1, 500: 1 });
        assert.equal(clean.payload.data.employees[1].payoutStatus, 'pending');
        assert.equal(clean.payload.data.employees[1].lockedDistribution, null);

        // Sprint E cross-invariants: packed without lockedDistribution downgrades to pending; pending clears lockedDistribution; inventory negatives clamp to 0
        const crossDirty = {
            schema: 'splitx-backup/v1',
            version: 1,
            payload: {
                data: {
                    denominations: [1000, 500],
                    inventory: { 1000: -5, 500: 3, bad: 'x' },
                    employees: [
                        { id: 1, name: 'BadPacked', amount: 1000, paid: false, payoutStatus: 'packed', lockedDistribution: {} },
                        { id: 2, name: 'BadPending', amount: 1000, paid: false, payoutStatus: 'pending', lockedDistribution: { 1000: 1 } }
                    ]
                },
                history: null, sheets: null, documents: null
            }
        };
        const cleanCross = SplitXBackup.validateBackup(crossDirty);
        assert.equal(cleanCross.payload.data.inventory[1000], 0);
        assert.equal(cleanCross.payload.data.inventory[500], 3);
        assert.equal(cleanCross.payload.data.employees[0].payoutStatus, 'pending');
        assert.equal(cleanCross.payload.data.employees[0].lockedDistribution, null);
        assert.equal(cleanCross.payload.data.employees[1].lockedDistribution, null);
    });

    test('restoreBackup rolls back all keys atomically if a write fails mid-restore and clears legacy/corrupt keys on success (Sprint B)', () => {
        const map = new Map();
        let failKey = null;
        const storage = SplitXStorage.createStorage({
            backend: {
                getItem: (k) => (map.has(k) ? map.get(k) : null),
                setItem: (k, v) => {
                    if (k === failKey) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
                    map.set(k, String(v));
                },
                removeItem: (k) => map.delete(k)
            }
        });

        const origData = JSON.stringify({ currency: 'DOP', employees: [{ id: 1, name: 'Original', amount: 500 }] });
        const origSheets = JSON.stringify({ version: 2, templates: [] });
        storage.set(SplitXStorage.KEYS.DATA, origData);
        storage.set(SplitXStorage.KEYS.SHEETS, origSheets);
        storage.set(SplitXStorage.KEYS.SHEETS_LEGACY, '{"A":{"old":true}}');
        storage.set(SplitXStorage.KEYS.CORRUPT_BACKUP, '{"corrupt":');

        const backup = JSON.stringify({
            schema: 'splitx-backup/v1',
            version: 1,
            exportedAt: '2026-11-26T00:00:00Z',
            payload: {
                data: { currency: 'USD', employees: [{ id: 2, name: 'New', amount: 100 }] },
                history: [],
                sheets: { version: 2, templates: [] },
                documents: { version: 1, activeId: 'a', templates: [], people: {} }
            }
        });

        // Fail on DOCUMENTS write -> DATA and SHEETS must roll back to original!
        failKey = SplitXStorage.KEYS.DOCUMENTS;
        assert.throws(() => SplitXBackup.restoreBackup(storage, backup), /lleno|bloqueado|restaurar/i);
        assert.equal(storage.get(SplitXStorage.KEYS.DATA), origData, 'DATA must roll back on partial restore failure');
        assert.equal(storage.get(SplitXStorage.KEYS.SHEETS), origSheets, 'SHEETS must roll back on partial restore failure');

        // Succeed -> SHEETS_LEGACY and CORRUPT_BACKUP must be cleared
        failKey = null;
        const okRes = SplitXBackup.restoreBackup(storage, backup);
        assert.equal(okRes.ok, true);
        assert.equal(storage.get(SplitXStorage.KEYS.SHEETS_LEGACY), null);
        assert.equal(storage.get(SplitXStorage.KEYS.CORRUPT_BACKUP), null);
    });
});
