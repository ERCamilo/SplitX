/**
 * Strict monetary amounts and tab-separated Excel payroll rows.
 * No partial parseFloat: an invalid or ambiguous amount is never guessed.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SplitXExcelImport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const parseMoney = (input, { format = 'auto' } = {}) => {
        if (!['auto', 'en', 'es'].includes(format)) throw new Error('Formato monetario desconocido.');
        if (typeof input === 'number') {
            if (!Number.isFinite(input) || !Number.isSafeInteger(Math.round(input * 100)) ||
                Math.abs(input * 100 - Math.round(input * 100)) > 1e-6)
                throw new Error('Monto numérico inválido o con más de dos decimales.');
            return Math.round(input * 100) / 100;
        }
        if (typeof input !== 'string') throw new Error('El monto debe ser texto o número.');
        let value = input.trim().replace(/\u00a0|\u202f/g, ' ');
        // Only known currency prefixes are accepted; do not strip arbitrary letters.
        value = value.replace(/^(?:(?:RD\s*\$|DOP|USD|EUR|\$)\s*)/i, '').trim();
        let negative = false;
        if (value.startsWith('-')) { negative = true; value = value.slice(1); }
        if (!value || /[^0-9., ]/.test(value)) throw new Error('Monto inválido: contiene caracteres no admitidos.');
        if (value.includes(' ')) {
            if (!/^\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?$/.test(value))
                throw new Error('Agrupación de miles inválida.');
            value = value.replace(/ /g, '');
        }
        const comma = value.lastIndexOf(','), dot = value.lastIndexOf('.');
        const hasBoth = comma >= 0 && dot >= 0;
        let style = format;
        if (style === 'auto') {
            if (hasBoth) style = dot > comma ? 'en' : 'es';
            else if (/^\d{1,3}([,.])\d{3}$/.test(value)) {
                throw new Error('Monto ambiguo: selecciona formato 1,234.56 o 1.234,56.');
            } else if (comma >= 0) {
                style = /^\d+(?:,\d{1,2})$/.test(value) ? 'es' : 'en';
            } else if (dot >= 0) {
                style = /^\d+(?:\.\d{1,2})$/.test(value) ? 'en' : 'es';
            } else style = 'en';
        }
        const thousand = style === 'en' ? ',' : '.';
        const decimal = style === 'en' ? '.' : ',';
        const ts = thousand === '.' ? '\\.' : ',';
        const ds = decimal === '.' ? '\\.' : ',';
        const pattern = new RegExp('^(?:\\d+|\\d{1,3}(?:' + ts + '\\d{3})+)(?:' + ds + '\\d{1,2})?$');
        if (!pattern.test(value)) throw new Error('Monto inválido para el formato seleccionado.');
        const canon = value.split(thousand).join('').replace(decimal, '.');
        const n = Number((negative ? '-' : '') + canon);
        if (!Number.isFinite(n) || !Number.isSafeInteger(Math.round(n * 100)))
            throw new Error('Monto fuera del rango permitido.');
        return Math.round(n * 100) / 100;
    };

    const parseExcelText = (raw, { format = 'auto' } = {}) => {
        const employees = [], errors = [];
        const lines = String(raw || '').split(/\r?\n/);
        let rows = 0;
        lines.forEach((rawLine, index) => {
            if (!rawLine.trim()) return;
            rows++;
            const cols = rawLine.split('\t').map(x => x.trim());
            if (cols.length < 3) {
                errors.push('Línea ' + (index + 1) + ': Se requieren al menos 3 columnas.');
                return;
            }
            const name = cols[1];
            if (!name) {
                errors.push('Línea ' + (index + 1) + ': Nombre vacío.');
                return;
            }
            const amountText = cols.slice(2).reverse().find(x => x !== '');
            if (!amountText) {
                errors.push('Línea ' + (index + 1) + ': No se encontró monto.');
                return;
            }
            try {
                const amount = parseMoney(amountText, { format });
                if (amount < 0) throw new Error('No se permiten montos negativos.');
                employees.push({
                    name: name.replace(/^[\d.\-)\s]+/, '').trim() || name,
                    amount, paid: false
                });
            } catch (e) {
                errors.push('Línea ' + (index + 1) + ': ' + e.message + ' (' + amountText + ').');
            }
        });
        return { employees, errors, rows, valid: employees.length, rejected: errors.length };
    };
    return { parseMoney, parseExcelText };
});
