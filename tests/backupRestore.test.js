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
});
