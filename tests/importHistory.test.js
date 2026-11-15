/**
 * Import history: the last payrolls the user imported (from SA, JSON or Excel),
 * kept in localStorage so an old or a newer payroll can be loaded again in one click.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../js/SplitXImportHistory.js');

const ctx = {
    schema: 'sa-splitx-payroll/v1',
    period: { start: '2026-11-01', end: '2026-11-15' },
    companyName: 'Constructora Ejemplo',
    payrollName: 'Nómina período 01/11/2026 - 15/11/2026',
    projectName: 'Torre A',
    currency: 'DOP'
};
const emps = (n = 2, base = 100) => Array.from({ length: n }, (_, i) => ({
    id: i + 1, name: 'Empleado ' + (i + 1), amount: base * (i + 1), paid: false, exportContext: ctx
}));
const NOW = new Date('2026-11-15T14:30:00');

describe('createEntry', () => {
    test('summarises an SA import with title, period, count and total', () => {
        const e = H.createEntry({ employees: emps(3), source: 'sa', context: ctx, now: NOW });
        assert.equal(e.source, 'sa');
        assert.equal(e.count, 3);
        assert.equal(e.total, 600);
        assert.equal(e.title, 'Nómina período 01/11/2026 - 15/11/2026');
        assert.equal(e.subtitle, 'Constructora Ejemplo · Torre A');
        assert.deepEqual(e.period, { start: '2026-11-01', end: '2026-11-15' });
        assert.equal(e.currency, 'DOP');
        assert.equal(e.importedAt, NOW.toISOString());
        assert.ok(e.id && e.signature);
    });

    test('falls back to a readable title when there is no context', () => {
        const e = H.createEntry({ employees: emps(2), source: 'excel', now: NOW });
        assert.equal(e.title, 'Importación Excel');
        assert.equal(e.subtitle, '');
        assert.equal(e.period, null);
    });

    test('stores the shared context once instead of on every employee', () => {
        const e = H.createEntry({ employees: emps(5), source: 'sa', context: ctx, now: NOW });
        assert.equal(e.employees.every(x => !('exportContext' in x)), true);
        assert.equal(e.context.companyName, 'Constructora Ejemplo');
        const back = H.restoreEmployees(e);
        assert.equal(back.length, 5);
        assert.equal(back[0].exportContext.companyName, 'Constructora Ejemplo');
    });

    test('keeps an employee-specific context that differs from the shared one', () => {
        const list = emps(2);
        list[1] = { ...list[1], exportContext: { ...ctx, companyName: 'Otra' } };
        const e = H.createEntry({ employees: list, source: 'sa', context: ctx, now: NOW });
        const back = H.restoreEmployees(e);
        assert.equal(back[0].exportContext.companyName, 'Constructora Ejemplo');
        assert.equal(back[1].exportContext.companyName, 'Otra');
    });

    test('restored employees are copies: editing them does not change the history', () => {
        const e = H.createEntry({ employees: emps(1), source: 'json', now: NOW });
        const back = H.restoreEmployees(e);
        back[0].amount = 999;
        assert.equal(H.restoreEmployees(e)[0].amount, 100);
    });

    test('paid flags are cleared so a reloaded payroll starts pending', () => {
        const list = emps(2).map(x => ({ ...x, paid: true }));
        const back = H.restoreEmployees(H.createEntry({ employees: list, source: 'sa', now: NOW }));
        assert.equal(back.every(x => x.paid === false), true);
    });
});

describe('signature', () => {
    test('same names and amounts give the same signature; a change gives another', () => {
        const a = H.entrySignature(emps(3));
        assert.equal(a, H.entrySignature(emps(3)));
        assert.notEqual(a, H.entrySignature(emps(3, 101)));
        assert.notEqual(a, H.entrySignature(emps(2)));
    });

    test('ignores ids and paid status', () => {
        const other = emps(3).map((x, i) => ({ ...x, id: 1000 + i, paid: true }));
        assert.equal(H.entrySignature(emps(3)), H.entrySignature(other));
    });

    test('isCurrent tells whether the loaded list is that payroll', () => {
        const e = H.createEntry({ employees: emps(2), source: 'sa', now: NOW });
        assert.equal(H.isCurrent(e, emps(2)), true);
        assert.equal(H.isCurrent(e, emps(3)), false);
        assert.equal(H.isCurrent(e, []), false);
    });
});

describe('addEntry / removeEntry', () => {
    test('newest first, capped at max', () => {
        let list = [];
        for (let i = 1; i <= 12; i++) {
            list = H.addEntry(list, H.createEntry({ employees: emps(1, i), source: 'sa', now: new Date(NOW.getTime() + i * 1000) }));
        }
        assert.equal(list.length, H.MAX_ENTRIES);
        assert.equal(list[0].total, 12);
        assert.equal(list[list.length - 1].total, 12 - H.MAX_ENTRIES + 1);
    });

    test('re-importing the same payroll moves it to the top instead of duplicating', () => {
        let list = [];
        list = H.addEntry(list, H.createEntry({ employees: emps(2), source: 'sa', now: NOW }));
        list = H.addEntry(list, H.createEntry({ employees: emps(3), source: 'sa', now: new Date(NOW.getTime() + 1000) }));
        list = H.addEntry(list, H.createEntry({ employees: emps(2), source: 'sa', now: new Date(NOW.getTime() + 2000) }));
        assert.equal(list.length, 2);
        assert.equal(list[0].count, 2);
        assert.equal(list[0].importedAt, new Date(NOW.getTime() + 2000).toISOString());
    });

    test('does not mutate the input list', () => {
        const list = [H.createEntry({ employees: emps(1), source: 'sa', now: NOW })];
        H.addEntry(list, H.createEntry({ employees: emps(2), source: 'sa', now: NOW }));
        assert.equal(list.length, 1);
    });

    test('removeEntry drops by id', () => {
        const a = H.createEntry({ employees: emps(1), source: 'sa', now: NOW });
        const b = H.createEntry({ employees: emps(2), source: 'sa', now: NOW });
        const list = H.addEntry(H.addEntry([], a), b);
        assert.deepEqual(H.removeEntry(list, a.id).map(e => e.id), [b.id]);
    });
});

describe('storage', () => {
    test('trimToChars drops the oldest entries until the JSON fits', () => {
        let list = [];
        for (let i = 1; i <= 5; i++) list = H.addEntry(list, H.createEntry({ employees: emps(50, i), source: 'sa', now: new Date(NOW.getTime() + i) }));
        const one = JSON.stringify(list.slice(0, 2)).length;
        const trimmed = H.trimToChars(list, one + 10);
        assert.equal(trimmed.length, 2);
        assert.equal(trimmed[0].id, list[0].id);
    });

    test('parseHistory survives bad data', () => {
        assert.deepEqual(H.parseHistory(null), []);
        assert.deepEqual(H.parseHistory('not json'), []);
        assert.deepEqual(H.parseHistory('{"a":1}'), []);
        const good = H.createEntry({ employees: emps(1), source: 'sa', now: NOW });
        const parsed = H.parseHistory(JSON.stringify([good, { junk: true }, null]));
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].id, good.id);
    });

    test('save keeps what fits when storage throws a quota error', () => {
        const store = {};
        let calls = 0;
        const storage = {
            setItem: (k, v) => { calls++; if (v.length > 2500) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } store[k] = v; },
            getItem: (k) => store[k] ?? null
        };
        let list = [];
        for (let i = 1; i <= 4; i++) list = H.addEntry(list, H.createEntry({ employees: emps(6, i), source: 'sa', now: new Date(NOW.getTime() + i) }));
        const saved = H.save(storage, list);
        assert.ok(saved.length >= 1 && saved.length < 4);
        assert.equal(saved[0].id, list[0].id);
        assert.equal(H.load(storage).length, saved.length);
        assert.ok(calls > 1);
    });

    test('save returns the list unchanged and does not throw when storage is unavailable', () => {
        const storage = { setItem: () => { throw new Error('SecurityError'); }, getItem: () => { throw new Error('SecurityError'); } };
        const list = [H.createEntry({ employees: emps(1), source: 'sa', now: NOW })];
        assert.doesNotThrow(() => H.save(storage, list));
        assert.deepEqual(H.load(storage), []);
    });
});

describe('describeEntry', () => {
    test('formats period, date and source for the list', () => {
        const e = H.createEntry({ employees: emps(2), source: 'sa', context: ctx, now: new Date('2026-11-15T09:05:00') });
        const d = H.describeEntry(e, NOW);
        assert.equal(d.periodLabel, '01 nov – 15 nov 2026');
        assert.equal(d.whenLabel, 'Hoy 09:05');
        assert.equal(d.sourceLabel, 'Sistema de Asistencia');
        assert.equal(d.countLabel, '2 empleados');
    });

    test('says Ayer for the previous day and a date for older ones', () => {
        const y = H.createEntry({ employees: emps(1), source: 'json', now: new Date('2026-11-14T18:00:00') });
        assert.equal(H.describeEntry(y, NOW).whenLabel, 'Ayer 18:00');
        assert.equal(H.describeEntry(y, NOW).countLabel, '1 empleado');
        const old = H.createEntry({ employees: emps(1), source: 'excel', now: new Date('2026-10-03T08:00:00') });
        assert.equal(H.describeEntry(old, NOW).whenLabel, '03 oct 2026 08:00');
        assert.equal(H.describeEntry(old, NOW).sourceLabel, 'Excel');
    });

    test('periods across years show both years', () => {
        const e = H.createEntry({ employees: emps(1), source: 'sa', context: { period: { start: '2026-12-16', end: '2027-01-15' } }, now: NOW });
        assert.equal(H.describeEntry(e, NOW).periodLabel, '16 dic 2026 – 15 ene 2027');
    });
});
