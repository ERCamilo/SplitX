// @ts-check
/**
 * Strict monetary amounts and tab-separated Excel payroll rows.
 * No partial parseFloat: an invalid or ambiguous amount is never guessed.
 *
 * Supported Excel/TSV layouts:
 *   1. Header-detected: maps columns by header name (including the exact sheet
 *      exported by SplitX: # | Nombre | Bruto | Bonif. | Desc. | Despues desc. | Prestamos | Neto | ...).
 *   2. Payroll (8 cols, no header): # | Nombre | Bruto | Bonif. | Desc. | Despues desc. | Prestamos | Neto
 *   3. Payroll (7 cols, no header): # | Nombre | Bruto | Bonif. | Desc. | Prestamos | Neto
 *   4. Simple (3+ cols, no header): # | Nombre | ... | Monto Neto
 */
    (function (/** @type {any} */ root, factory) {
        if (typeof module === 'object' && module.exports) module.exports = factory();
        else root.SplitXExcelImport = factory();
    })(typeof globalThis !== 'undefined' ? globalThis : this, function () {
        'use strict';

        /**
         * @typedef {'auto' | 'en' | 'es'} AmountFormat
         * @typedef {{
         *   name: string,
         *   amount: number,
         *   paid: boolean,
         *   employeeNumber?: string,
         *   bruto?: number,
         *   bonificaciones?: number,
         *   descuentos?: number,
         *   prestamos?: number
         * }} ParsedExcelEmployee
         */

        const CURRENCY_PREFIX = /^(?:(?:RD\s*\$|R\s*\$|S\/|DOP|USD|EUR|MXN|COP|ARS|CLP|PEN|BRL|GBP|CHF|JPY|INR|PHP|RUB|[$€£¥₹₱₽])\s*)/i;

        /**
         * @param {unknown} input
         * @param {{ format?: AmountFormat }} [options]
         * @returns {number}
         */
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
            value = value.replace(CURRENCY_PREFIX, '').trim();
            let negative = false;
            if (value.startsWith('-')) { negative = true; value = value.slice(1).trim(); }
            if (!value || /[^0-9., ]/.test(value)) throw new Error('Monto inválido: contiene caracteres no admitidos.');
            if (value.includes(' ')) {
                if (!/^\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?$/.test(value))
                    throw new Error('Agrupación de miles inválida.');
                value = value.replace(/ /g, '');
            }
            const comma = value.lastIndexOf(','), dot = value.lastIndexOf('.');
            const hasBoth = comma >= 0 && dot >= 0;
            /** @type {string} */
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

        /** @param {string} text */
        const normalizeHeader = (text) => String(text || '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\([^)]*\)/g, ' ')
            .replace(/[.:/\\_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        /** @type {Record<string, 'number'|'name'|'gross'|'bonuses'|'discounts'|'afterDiscounts'|'loans'|'net'|'paid'>} */
        const HEADER_ALIASES = {
            '#': 'number', 'no': 'number', 'num': 'number', 'numero': 'number', 'id': 'number', 'cod': 'number', 'codigo': 'number',
            'nombre': 'name', 'nombre del empleado': 'name', 'empleado': 'name', 'colaborador': 'name', 'name': 'name',
            'bruto': 'gross', 'monto bruto': 'gross', 'sueldo bruto': 'gross', 'salario bruto': 'gross', 'gross': 'gross', 'salario': 'gross', 'sueldo': 'gross',
            'bonif': 'bonuses', 'bonificacion': 'bonuses', 'bonificaciones': 'bonuses', 'bono': 'bonuses', 'bonos': 'bonuses', 'bonus': 'bonuses', 'bonuses': 'bonuses',
            'desc': 'discounts', 'descuento': 'discounts', 'descuentos': 'discounts', 'deduccion': 'discounts', 'deducciones': 'discounts', 'discounts': 'discounts', 'deductions': 'discounts',
            'despues desc': 'afterDiscounts', 'despues descuentos': 'afterDiscounts', 'despues de descuentos': 'afterDiscounts', 'despues de desc': 'afterDiscounts', 'subtotal': 'afterDiscounts', 'afterdiscounts': 'afterDiscounts',
            'prestamo': 'loans', 'prestamos': 'loans', 'desc prestamo': 'loans', 'desc prestamos': 'loans', 'descuento prestamo': 'loans', 'descuento prestamos': 'loans', 'descuento por prestamo': 'loans', 'descuentos por prestamo': 'loans', 'descuentos por prestamos': 'loans', 'adelanto': 'loans', 'adelantos': 'loans', 'loan': 'loans', 'loans': 'loans',
            'neto': 'net', 'monto': 'net', 'monto neto': 'net', 'sueldo neto': 'net', 'neto a pagar': 'net', 'total a pagar': 'net', 'a pagar': 'net', 'amount': 'net', 'net': 'net',
            'pagado': 'paid', 'paid': 'paid'
        };

        /**
         * @typedef {{
         *   number?: number, name?: number, gross?: number, bonuses?: number,
         *   discounts?: number, afterDiscounts?: number, loans?: number, net?: number, paid?: number
         * }} ColumnMap
         */

        /** @param {string[]} cols @returns {ColumnMap | null} */
        const detectHeaderMap = (cols) => {
            if (cols.length < 3) return null;
            /** @type {ColumnMap} */
            const map = {};
            cols.forEach((raw, idx) => {
                const norm = normalizeHeader(raw);
                const field = HEADER_ALIASES[norm];
                if (field && map[field] === undefined) map[field] = idx;
            });
            const hasMoney = map.net !== undefined || map.gross !== undefined ||
                map.bonuses !== undefined || map.discounts !== undefined || map.loans !== undefined;
            if (map.name === undefined || !hasMoney) return null;
            return map;
        };

        /** @param {string[]} cols */
        const isBannerLine = (cols) => {
            const nonEmpty = cols.filter(Boolean);
            if (nonEmpty.length !== 1) return false;
            const t = normalizeHeader(nonEmpty[0]);
            return /^distribucion\b|^fecha\b|^nomina\b/.test(t);
        };

        /** @param {string[]} cols @param {number} numIdx @param {number} nameIdx */
        const isSummaryOrReserveRow = (cols, numIdx, nameIdx) => {
            const numCol = (cols[numIdx] || '').trim();
            const nameCol = normalizeHeader(cols[nameIdx] || '');
            if (numCol === '★' || /^fondo (para )?nuevos prestamos/.test(nameCol)) return true;
            if (!numCol && /^total(es| nomina| general)?$/.test(nameCol)) return true;
            return false;
        };

        /** @param {string} raw @param {AmountFormat} format */
        const looksLikeMoneyOrEmpty = (raw, format) => {
            if (!raw) return true;
            try { parseMoney(raw, { format }); return true; } catch (_) { return false; }
        };

        /** @param {string[]} cols */
        const hasExportStatusTail = (cols) => {
            if (cols.length < 10) return false;
            const last = normalizeHeader(cols[cols.length - 1] || '');
            const prev = normalizeHeader(cols[cols.length - 2] || '');
            return (last === 'si' || last === 'no') && (prev === 'ok' || prev === 'incompleto');
        };

        /**
         * Decide positional layout for headerless rows.
         * @param {string[][]} sampleRows
         * @param {AmountFormat} format
         * @returns {{ mode: 'payroll-8' | 'payroll-7' | 'simple', map: ColumnMap | null }}
         */
        const inferPositionalLayout = (sampleRows, format) => {
            const wide = sampleRows.filter(c => c.length >= 7);
            if (!wide.length) return { mode: 'simple', map: null };

            // Exact SplitX Excel export order (8 cols or 8+ cols with denomination/Estado/Pagado tail):
            // # | Nombre | Bruto | Bonif. | Desc. | Despues desc. | Prestamos | Neto
            const allAtLeast8 = wide.length === sampleRows.length && sampleRows.every(c => c.length >= 8);
            if (allAtLeast8) {
                const first = sampleRows[0];
                const isExact8 = sampleRows.every(c => c.length === 8);
                const hasTail = sampleRows.some(hasExportStatusTail);
                const payrollSliceLooksNumeric = first.slice(2, 8).some(Boolean) &&
                    first.slice(2, 8).every(v => looksLikeMoneyOrEmpty(v, format));
                if (isExact8 || hasTail || payrollSliceLooksNumeric) {
                    return {
                        mode: 'payroll-8',
                        map: { number: 0, name: 1, gross: 2, bonuses: 3, discounts: 4, afterDiscounts: 5, loans: 6, net: 7 }
                    };
                }
            }

            // 7-column payroll order without "Despues desc.":
            // # | Nombre | Bruto | Bonif. | Desc. | Prestamos | Neto
            const allExact7 = sampleRows.every(c => c.length === 7);
            if (allExact7) {
                const first = sampleRows[0];
                if (first.slice(2, 7).some(Boolean) && first.slice(2, 7).every(v => looksLikeMoneyOrEmpty(v, format))) {
                    return {
                        mode: 'payroll-7',
                        map: { number: 0, name: 1, gross: 2, bonuses: 3, discounts: 4, loans: 5, net: 6 }
                    };
                }
            }

            return { mode: 'simple', map: null };
        };

        /** @param {string} raw */
        const cleanName = (raw) => raw.replace(/^[\d.\-)\s]+/, '').trim() || raw;

        /** @param {string | undefined} raw */
        const parsePaidFlag = (raw) => {
            const n = normalizeHeader(raw || '');
            return n === 'si' || n === 'yes' || n === 'true' || n === '1';
        };

        /**
         * @param {string} raw
         * @param {{ format?: AmountFormat }} [options]
         */
        const parseExcelText = (raw, { format = 'auto' } = {}) => {
            /** @type {ParsedExcelEmployee[]} */
            const employees = [];
            /** @type {string[]} */
            const errors = [];
            const rawLines = String(raw || '').split(/\r?\n/);

            /** @type {Array<{ index: number, cols: string[] }>} */
            const nonEmptyLines = [];
            rawLines.forEach((rawLine, index) => {
                if (!rawLine.trim()) return;
                nonEmptyLines.push({ index, cols: rawLine.split('\t').map(x => x.trim()) });
            });

            /** @type {ColumnMap | null} */
            let columnMap = null;
            /** @type {'header' | 'payroll-8' | 'payroll-7' | 'simple'} */
            let detectedFormat = 'simple';
            let startIdx = 0;

            // Detect header row (skipping optional exported sheet banner lines like "DISTRIBUCIÓN..." / "Fecha: ...")
            for (let i = 0; i < Math.min(nonEmptyLines.length, 4); i++) {
                const map = detectHeaderMap(nonEmptyLines[i].cols);
                if (map) {
                    columnMap = map;
                    detectedFormat = 'header';
                    startIdx = i + 1;
                    break;
                }
                if (!isBannerLine(nonEmptyLines[i].cols)) break;
            }

            const dataLines = nonEmptyLines.slice(startIdx);
            if (!columnMap && dataLines.length > 0) {
                const inferred = inferPositionalLayout(dataLines.map(l => l.cols), format);
                columnMap = inferred.map;
                detectedFormat = inferred.mode;
            }

            const hasPayrollColumns = !!(columnMap && (
                columnMap.gross !== undefined ||
                columnMap.bonuses !== undefined ||
                columnMap.discounts !== undefined ||
                columnMap.loans !== undefined
            ));

            let rows = 0;
                for (const { index, cols } of dataLines) {
                    const numIdx = columnMap?.number ?? 0;
                    const nameIdx = columnMap?.name ?? 1;

                    // Skip exported totals / loan-fund summary rows when header or payroll export layout is used
                    if ((detectedFormat !== 'simple') && isSummaryOrReserveRow(cols, numIdx, nameIdx)) {
                        continue;
                    }

                    rows++;
                        if (!columnMap && cols.length < 3) {
                            errors.push('Línea ' + (index + 1) + ': Se requieren al menos 3 columnas.');
                            continue;
                        }

                            const rawName = cols[nameIdx] || '';
                            if (!rawName) {
                                errors.push('Línea ' + (index + 1) + ': Nombre vacío.');
                                continue;
                            }

                            /** @param {number | undefined} colIdx @param {string} label @param {boolean} required */
                            const readMoneyCol = (colIdx, label, required) => {
                                if (colIdx === undefined) return null;
                                const cell = (cols[colIdx] || '').trim();
                                if (!cell) {
                                    if (required) throw new Error('Falta ' + label);
                                    return null;
                                }
                                const val = parseMoney(cell, { format });
                                if (val < 0) throw new Error('No se permiten montos negativos en ' + label + ' (' + cell + ')');
                                return val;
                            };

                            try {
                                const empNum = columnMap?.number !== undefined ? (cols[columnMap.number] || '').trim() : (cols[0] || '').trim();
                                const paid = columnMap?.paid !== undefined ? parsePaidFlag(cols[columnMap.paid]) : false;

                                if (hasPayrollColumns && columnMap) {
                                    const gross = readMoneyCol(columnMap.gross, 'Bruto', false);
                                    const bonuses = readMoneyCol(columnMap.bonuses, 'Bonificaciones', false);
                                    const discounts = readMoneyCol(columnMap.discounts, 'Descuentos', false);
                                    const loans = readMoneyCol(columnMap.loans, 'Préstamos', false);
                                    // Validate "Después de desc." if present so malformed numbers are never silently ignored
                                    if (columnMap.afterDiscounts !== undefined) {
                                        readMoneyCol(columnMap.afterDiscounts, 'Después de desc.', false);
                                    }
                                    const explicitNet = readMoneyCol(columnMap.net, 'Neto', false);

                                    const bVal = bonuses ?? 0;
                                    const dVal = discounts ?? 0;
                                    const lVal = loans ?? 0;

                                    let amount = explicitNet;
                                    if (amount === null) {
                                        if (gross === null) throw new Error('No se encontró monto bruto ni neto.');
                                        amount = Math.round((gross + bVal - dVal - lVal) * 100) / 100;
                                        if (amount < 0) throw new Error('El neto calculado resulta negativo.');
                                    }

                                    /** @type {ParsedExcelEmployee} */
                                    const emp = {
                                        name: cleanName(rawName),
                                        amount,
                                        paid
                                    };
                                    if (empNum) emp.employeeNumber = empNum;
                                    if (gross !== null) emp.bruto = gross;
                                    if (bonuses !== null || gross !== null) emp.bonificaciones = bVal;
                                    if (discounts !== null || gross !== null) emp.descuentos = dVal;
                                    if (loans !== null || gross !== null) emp.prestamos = lVal;
                                    employees.push(emp);
                                } else {
                                    const amountText = columnMap && columnMap.net !== undefined
                                        ? (cols[columnMap.net] || '').trim()
                                        : cols.slice(2).reverse().find(x => x !== '');
                                    if (!amountText) {
                                        errors.push('Línea ' + (index + 1) + ': No se encontró monto.');
                                        continue;
                                    }
                                    const amount = parseMoney(amountText, { format });
                                    if (amount < 0) throw new Error('No se permiten montos negativos.');
                                    /** @type {ParsedExcelEmployee} */
                                    const emp = {
                                        name: cleanName(rawName),
                                        amount,
                                        paid
                                    };
                                    if (empNum) emp.employeeNumber = empNum;
                                    employees.push(emp);
                                }
                            } catch (e) {
                                const msg = e instanceof Error ? e.message : String(e);
                                const fallbackCol = (!hasPayrollColumns && (!columnMap || columnMap.net === undefined))
                                    ? cols.slice(2).reverse().find(x => x !== '')
                                    : '';
                                const suffix = fallbackCol && !msg.includes('(' + fallbackCol + ')') ? ' (' + fallbackCol + ').' : (msg.endsWith('.') ? '' : '.');
                                errors.push('Línea ' + (index + 1) + ': ' + msg + suffix);
                            }
        }

        return { employees, errors, rows, valid: employees.length, rejected: errors.length, detectedFormat };
    };

    return { parseMoney, parseExcelText, detectHeaderMap };
});
