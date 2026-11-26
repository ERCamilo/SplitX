// @ts-check
/**
 * SheetStudioModel.js
 * Modelo puro de SheetStudio (sin DOM): plantillas por defecto y de inicio,
 * validación de hojas de firmas, geometría/paginación, totales, firmas de
 * impresión, historial undo/redo, migración de almacenamiento y paleta de colores.
 */
(function (/** @type {any} */ root, /** @type {any} */ factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory(
            require('./SheetBuilder.js'),
            require('./SplitXSheetFields.js'),
            require('./SplitXVariables.js')
        );
    } else {
        root.SheetStudioModel = factory(root.SheetBuilder, root.SplitXSheetFields, root.SplitXVariables);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, /** @param {any} SB @param {any} SF @param {any} CV */ function (SB, SF, CV) {
    'use strict';

    const PT_MM = 0.3528;          // 1 pt en mm
    const PRINT_K = 96 / 25.4;     // px CSS por mm (impresión a escala real)
    const STORE_KEY = 'Split_sheets_v2';
    const LEGACY_STORE_KEY = 'Split_sheets_v1';

    // ─── Plantillas de ejemplo ─────────────────────────────────────────────
    /** @param {string} key @param {string} [as] */
    const F = (key, as) => (as ? { kind: 'field', key, as } : { kind: 'field', key });
    /** @param {string} value */
    const T = (value) => ({ kind: 'text', value });
    /** @param {string} op */
    const O = (op) => ({ kind: 'op', op });
    const RUN = () => ({ kind: 'running' });
    /** @param {any[]} chips @param {Record<string, any>} [extra] */
    const cT = (chips, extra) => Object.assign({ mode: 'text', chips }, extra || {});
    /** @param {any[]} chips @param {Record<string, any>} [extra] */
    const cN = (chips, extra) => Object.assign({ mode: 'number', chips, align: 'right' }, extra || {});

    const defaultCardTemplate = () => ({
        version: 1, type: 'cards', name: 'Sobre de pago', columns: [2, 1],
        rows: [
            { cells: [cT([F('no'), T('-'), F('firstName')], { bold: true, size: 10 }), cT([F('days'), T('días')], { align: 'right' })] },
            { cells: [cT([F('gross', 'label')]), cN([F('gross')])] },
            { whenEmpty: 'hide', cells: [cT([F('bonuses', 'label')]), cN([O('+'), F('bonuses')])] },
            { whenEmpty: 'hide', cells: [cT([F('discounts', 'label')]), cN([O('-'), F('discounts')])] },
            { whenEmpty: 'hide', cells: [cT([F('loans', 'label')]), cN([O('-'), F('loans')])] },
            { lineAbove: true, cells: [cT([T('Total a recibir')], { bold: true }), cN([RUN()], { bold: true })] },
            { whenEmpty: 'hide', cells: [cT([F('loanBalanceAfter', 'label')], { size: 7.5 }), cN([F('loanBalanceAfter')], { size: 7.5 })] },
            { cells: [cT([T('Folio'), F('folio')], { size: 6.5 }), cT([])] }
        ],
        layout: { paper: 'letter', orientation: 'portrait', margin: 10, gap: 4, mode: 'grid', cols: 2, rows: 4, cutMarks: true },
        sortBy: { field: 'no', dir: 'asc' }
    });

    const defaultTableTemplate = () => ({
        version: 1, type: 'table', name: 'Hoja de firmas',
        title: [
            cT([F('company')], { size: 16, bold: true }),
            cT([T('Constancia de pago ·'), F('project')], { size: 10 }),
            cT([T('Período:'), F('period')], { size: 10 })
        ],
        columns: [
            { header: 'Folio', width: 1, border: 'all', sum: false, cell: cT([F('folio')]) },
            { header: 'No.', width: 0.6, border: 'all', sum: false, cell: cT([F('no')]) },
            { header: 'Nombre', width: 2.2, border: 'all', sum: false, cell: cT([F('name')]) },
            { header: 'Días', width: 0.7, border: 'all', sum: true, cell: cN([F('days')]) },
            { header: 'Sueldo/día', width: 1, border: 'all', sum: false, cell: cN([F('dailyRate')]) },
            { header: 'Bruto + bonos', width: 1.2, border: 'all', sum: true, cell: cN([F('gross'), O('+'), F('bonuses')]) },
            { header: 'Monto entregado', width: 1.3, border: 'all', sum: true, cell: cN([F('afterDiscounts')], { bold: true }) },
            { header: 'Firma', width: 2.4, border: 'sign', sum: false, cell: cT([]) }
        ],
        options: { totals: true, signatures: 'all', signLabels: ['Entregado por', 'Revisado por'], signLine: 'low', rowHeight: 11 },
        layout: { paper: 'letter', orientation: 'landscape', margin: 12 },
        sortBy: { field: 'no', dir: 'asc' }
    });

    const FOOTER_PAGES = ['all', 'first', 'last', 'none'];
    const SIGN_LINES = ['low', 'middle', 'divider'];
    /** @type {Record<string, string>} */
    const LOGO_STYLES = { color: 'none', bw: 'grayscale(1) contrast(1.2)', invert: 'grayscale(1) contrast(1.2) invert(1)' };

    /**
     * Valida una plantilla Tipo B; reutiliza la validación de chips/celdas del motor.
     * @param {any} t
     * @returns {string[]}
     */
    const validateTableTemplate = (t) => {
        /** @type {string[]} */
        const errors = [];
        if (!t || typeof t !== 'object') return ['La plantilla debe ser un objeto'];
        if (t.type !== 'table') errors.push('Tipo de plantilla inválido (se esperaba "table")');
        if (!Array.isArray(t.columns) || !t.columns.length) errors.push('Faltan columnas');
        if (!Array.isArray(t.title)) errors.push('Falta el encabezado (title)');
        if (!t.layout || !SB.PAPER_SIZES[t.layout.paper]) errors.push('Papel inválido');
        if (!t.options || !(typeof t.options.rowHeight === 'number' && t.options.rowHeight > 0)) errors.push('Alto de fila inválido');
        else if (![true, false, undefined, ...FOOTER_PAGES].includes(t.options.signatures)) errors.push('Pie de firmas inválido');
        if (errors.length) return errors;
        t.columns.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
            if (!c || typeof c.header !== 'string') errors.push(`Columna ${i + 1}: encabezado inválido`);
            if (!['all', 'sign', 'none'].includes(c && c.border)) errors.push(`Columna ${i + 1}: bordes inválidos`);
        });
        const asCards = {
            version: 1, type: 'cards', name: 'x', columns: [1],
            layout: { paper: 'letter', orientation: 'portrait', margin: 10, gap: 4, mode: 'grid', cols: 1, rows: 1 },
            rows: [
                ...t.title.map((/** @type {any} */ c) => ({ cells: [c] })),
                ...t.columns.map((/** @type {any} */ c) => ({ cells: [c && c.cell] }))
            ]
        };
        return errors.concat(SB.validateTemplate(asCards).errors);
    };

    /**
     * Filtro CSS del logo: a color, blanco y negro o blanco y negro invertido.
     * @param {string | undefined} style
     */
    const logoFilter = (style) => (style && LOGO_STYLES[style]) || 'none';
    const TOTALS_MM = 8;
    const FOOTER_MM = 18;

    /**
     * Opciones de la hoja de firmas con valores por defecto (acepta el formato anterior con booleanos).
     * @param {any} o
     */
    const tableOptions = (o) => {
        const src = o || {};
        const sig = src.signatures === true ? 'all' : src.signatures === false ? 'none' : src.signatures;
        const labels = Array.isArray(src.signLabels) ? src.signLabels.map((/** @type {any} */ x) => String(x || '').trim()).filter(Boolean) : null;
        return {
            totals: !!src.totals,
            signatures: FOOTER_PAGES.includes(sig) ? sig : 'all',
            signLabels: labels || ['Entregado por', 'Revisado por'],
            signLine: SIGN_LINES.includes(src.signLine) ? src.signLine : 'low',
            logoStyle: Object.prototype.hasOwnProperty.call(LOGO_STYLES, src.logoStyle) ? src.logoStyle : 'color',
            rowHeight: typeof src.rowHeight === 'number' && src.rowHeight > 0 ? src.rowHeight : 11
        };
    };

    /**
     * ¿Lleva esta página el pie "Entregado por / Revisado por"?
     * @param {string} mode @param {number} page @param {number} pageCount
     */
    const footerOnPage = (mode, page, pageCount) =>
        mode === 'all' || (mode === 'first' && page === 0) || (mode === 'last' && page === pageCount - 1);

    /**
     * Medidas de la hoja de firmas y cuántas filas caben por página sin pie ni totales (mm).
     * @param {any} t @param {boolean} hasLogo
     */
    const tablePageGeometry = (t, hasLogo) => {
        const [w, h] = SB.PAPER_SIZES[t.layout.paper] || SB.PAPER_SIZES.letter;
        const landscape = t.layout.orientation === 'landscape';
        const pageWidth = landscape ? h : w;
        const pageHeight = landscape ? w : h;
        const margin = t.layout.margin || 0;
        const titleH = t.title.reduce((/** @type {number} */ s, /** @type {any} */ c) => s + (c.size || 10) * PT_MM * 1.45, 0);
        const headerH = Math.max(titleH, hasLogo ? 18 : 0) + 6;
        const bodyH = pageHeight - 2 * margin - headerH - 8;
        const rowsPerPage = Math.max(1, Math.floor(bodyH / tableOptions(t.options).rowHeight));
        return { pageWidth, pageHeight, margin, bodyH, rowsPerPage };
    };

    /**
     * Filas por página. Los totales van solo en la última; el pie de firmas en las páginas elegidas,
     * así las demás aprovechan todo el alto.
     * @param {any} t @param {boolean} hasLogo @param {number} count
     * @returns {number[]}
     */
    const tablePageSizes = (t, hasLogo, count) => {
        const o = tableOptions(t.options);
        const { bodyH } = tablePageGeometry(t, hasLogo);
        /** @param {number} page @param {boolean} isLast */
        const cap = (page, isLast) => {
            let h = bodyH;
            if (isLast && o.totals) h -= TOTALS_MM;
            if (o.signatures === 'all' || (o.signatures === 'first' && page === 0) || (o.signatures === 'last' && isLast)) h -= FOOTER_MM;
            return Math.max(1, Math.floor(h / o.rowHeight));
        };
        /** @type {number[]} */
        const sizes = [];
        let left = count;
        while (left > 0) {
            const page = sizes.length;
            if (left <= cap(page, true)) { sizes.push(left); break; }
            const take = Math.max(1, Math.min(cap(page, false), left - 1));
            sizes.push(take);
            left -= take;
        }
        return sizes.length ? sizes : [0];
    };

    /**
     * Pasa ancho de la columna i a la i+1 (o al revés) sin bajar de 0.2.
     * @param {number[]} widths @param {number} i @param {number} delta
     */
    const resizeColumns = (widths, i, delta) => {
        const out = widths.slice();
        const pairW = out[i] + out[i + 1];
        const a = Math.min(pairW - 0.2, Math.max(0.2, out[i] + delta));
        out[i] = Math.round(a * 100) / 100;
        out[i + 1] = Math.round((pairW - a) * 100) / 100;
        return out;
    };

    /**
     * Suma por columna (null en las que no suman). items = engine.sortRecords(...).
     * @param {any} engine @param {any} t @param {any[]} items
     * @returns {(number | null)[]}
     */
    const columnTotals = (engine, t, items) => {
        /** @type {(number | null)[]} */
        const sums = t.columns.map((/** @type {any} */ c) => (c.sum ? 0 : null));
        const cells = t.columns.map((/** @type {any} */ c) => c.cell);
        for (const { record, ctx } of items) {
            const res = engine.evaluateRows([{ cells }], record, ctx)[0].cells;
            res.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
                if (sums[i] !== null && typeof r.value === 'number') sums[i] = /** @type {number} */ (sums[i]) + r.value;
            });
        }
        return sums.map((s) => (s === null ? null : Math.round(s * 100) / 100));
    };

    /** @param {string} paper @param {string} orientation */
    const printPageRule = (paper, orientation) => {
        const [w, h] = SB.PAPER_SIZES[paper] || SB.PAPER_SIZES.letter;
        const [pw, ph] = orientation === 'landscape' ? [h, w] : [w, h];
        return `@page { size: ${pw}mm ${ph}mm; margin: 0; }`;
    };

    /** @type {Record<string, string>} */
    const CAT = { bonuses: 'bonus', discounts: 'deduction', loans: 'loan', loanPrincipal: 'loan', loanInterest: 'loan', loanBalance: 'loan', loanBalanceBefore: 'loan', loanBalanceAfter: 'loan' };
    /** @param {string} key */
    const catOf = (key) => CAT[key] || (key.startsWith('bonus:') ? 'bonus' : key.startsWith('deduction:') ? 'deduction' : key.startsWith('loan:') ? 'loan' : 'field');

    /** @type {Record<string, string>} */
    const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    /** @param {any} s */
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
    /** @template T @param {T} o @returns {T} */
    const clone = (o) => JSON.parse(JSON.stringify(o));

    // ─── Ayudantes del editor (puros, probados) ────────────────────────────
    /** @type {Record<string, string>} */
    const SIGN_BY_CAT = { bonus: '+', deduction: '-', loan: '-' };
    const NO_SUM_KEYS = ['dailyRate', 'loanBalance', 'loanBalanceBefore', 'loanBalanceAfter'];

    /**
     * Fila "Concepto | Monto" lista para usar al soltar un campo sobre la tarjeta.
     * @param {string} key @param {any} fd @param {number} colCount
     */
    const smartRowFor = (key, fd, colCount) => {
        const cat = catOf(key);
        const sign = SIGN_BY_CAT[cat];
        const isNumber = fd && fd.type === 'number';
        const label = F(key, 'label');
        const valueChips = sign ? [O(sign), F(key)] : [F(key)];
        /** @type {any} */
        const row = {};
        if (sign || (fd && fd.noTotal && isNumber && key.startsWith('loan'))) row.whenEmpty = 'hide';
        if (colCount <= 1) {
            row.cells = [isNumber ? { mode: 'number', chips: [label, ...valueChips] } : { mode: 'text', chips: [label, F(key)] }];
            return row;
        }
        /** @type {any[]} */
        const cells = [{ mode: 'text', chips: [label] }];
        for (let i = 1; i < colCount - 1; i++) cells.push({ mode: 'text', chips: [] });
        cells.push(isNumber ? { mode: 'number', align: 'right', chips: valueChips } : { mode: 'text', chips: [F(key)] });
        row.cells = cells;
        return row;
    };

    /**
     * Columna nueva para la hoja de firmas al soltar un campo sobre la tabla.
     * @param {string} key @param {any} fd
     */
    const smartColumnFor = (key, fd) => {
        const isNumber = fd && fd.type === 'number';
        return {
            header: fd ? fd.label : key,
            width: isNumber ? 1.2 : 2,
            border: 'all',
            sum: !!isNumber && !NO_SUM_KEYS.includes(key),
            cell: isNumber ? { mode: 'number', align: 'right', chips: [F(key)] } : { mode: 'text', chips: [F(key)] }
        };
    };

    // ─── Plantillas de inicio ──────────────────────────────────────────────
    const nameRow = () => ({ cells: [cT([F('no'), T('-'), F('firstName')], { bold: true, size: 10 }), cT([F('days'), T('días')], { align: 'right' })] });
    const folioRow = () => ({ cells: [cT([T('Folio'), F('folio')], { size: 6.5 }), cT([])] });
    const totalRow = () => ({ lineAbove: true, cells: [cT([T('Total a recibir')], { bold: true }), cN([RUN()], { bold: true })] });
    /** @param {string} name @param {any[]} rows */
    const cardBase = (name, rows) => ({
        version: 1, type: 'cards', name, columns: [2, 1], rows,
        layout: { paper: 'letter', orientation: 'portrait', margin: 10, gap: 4, mode: 'grid', cols: 2, rows: 4, cutMarks: true },
        sortBy: { field: 'no', dir: 'asc' }
    });
    /** @param {string} name @param {any[]} columns @param {string} orientation */
    const tableBase = (name, columns, orientation) => Object.assign(defaultTableTemplate(), { name, columns, layout: { paper: 'letter', orientation, margin: 12 } });
    /** @param {string} header @param {number} width @param {any} cell @param {boolean} [sum] */
    const col = (header, width, cell, sum) => ({ header, width, border: 'all', sum: !!sum, cell });
    const signCol = () => ({ header: 'Firma', width: 2.4, border: 'sign', sum: false, cell: cT([]) });

    /** Plantillas listas para empezar. build(conceptKeys) recibe los conceptos importados (para el desglose). */
    const starterTemplates = () => [
        { id: 'card-standard', type: 'cards', name: 'Sobre estándar', hint: 'Bruto, bonos, descuentos, préstamo y total', build: () => defaultCardTemplate() },
        {
            id: 'card-min', type: 'cards', name: 'Sobre mínimo', hint: 'Nombre y monto a recibir',
            build: () => cardBase('Sobre mínimo', [nameRow(), { lineAbove: true, cells: [cT([T('Total a recibir')], { bold: true, size: 11 }), cN([F('net')], { bold: true, size: 11 })] }, folioRow()])
        },
        {
            id: 'card-detail', type: 'cards', name: 'Sobre detallado', hint: 'Una fila por cada bono, descuento y préstamo importado',
            /** @param {string[]} [concepts] */
            build: (concepts) => {
                const keys = (concepts || []).filter((k) => /^(bonus|deduction|loan):/.test(k));
                const detail = keys.length
                    ? keys.map((k) => smartRowFor(k, { type: 'number' }, 2))
                    : ['bonuses', 'discounts', 'loans'].map((k) => smartRowFor(k, { type: 'number' }, 2));
                return cardBase('Sobre detallado', [nameRow(), { cells: [cT([F('gross', 'label')]), cN([F('gross')])] }, ...detail, totalRow(),
                { whenEmpty: 'hide', cells: [cT([F('loanBalanceAfter', 'label')], { size: 7.5 }), cN([F('loanBalanceAfter')], { size: 7.5 })] }, folioRow()]);
            }
        },
        { id: 'table-standard', type: 'table', name: 'Firma estándar', hint: 'Días, sueldo por día, bruto y monto entregado', build: () => defaultTableTemplate() },
        {
            id: 'table-simple', type: 'table', name: 'Firma simple', hint: 'No., nombre, monto y firma (vertical)',
            build: () => tableBase('Firma simple', [
                col('No.', 0.6, cT([F('no')])), col('Nombre', 2.6, cT([F('name')])),
                col('Monto entregado', 1.4, cN([F('afterDiscounts')], { bold: true }), true), signCol()
            ], 'portrait')
        },
        {
            id: 'table-detail', type: 'table', name: 'Firma con desglose', hint: 'Bruto, bonos, descuentos y préstamo por empleado',
            build: () => tableBase('Firma con desglose', [
                col('Folio', 1, cT([F('folio')])), col('Nombre', 2, cT([F('name')])), col('Días', 0.6, cN([F('days')]), true),
                col('Bruto', 1.1, cN([F('gross')]), true), col('Bonos', 1, cN([F('bonuses')]), true), col('Descuentos', 1, cN([F('discounts')]), true),
                col('Préstamo/Adelanto', 1.1, cN([F('loans')]), true), col('Monto entregado', 1.2, cN([F('afterDiscounts')], { bold: true }), true), signCol()
            ], 'landscape')
        }
    ];

    // ─── Tamaño de letra de la tarjeta ─────────────────────────────────────
    const BASE_PT = 8.5;
    /** @param {any} t */
    const cardFontPt = (t) => (t.layout && typeof t.layout.fontSize === 'number' && t.layout.fontSize > 0 ? t.layout.fontSize : BASE_PT);
    /**
     * Las celdas con letra propia crecen o se achican junto con la letra base.
     * @param {any} cell @param {number} base
     */
    const cellFontPt = (cell, base) => (cell.size ? Math.round(cell.size * (base / BASE_PT) * 100) / 100 : null);
    /**
     * Mayor tamaño (de max hacia min, en pasos de step) para el que fits(pt) es verdadero.
     * @param {(pt: number) => boolean} fits @param {{ max: number, min: number, step: number }} bounds
     */
    const fitFontSize = (fits, { max, min, step }) => {
        for (let n = Math.round(max / step); n >= Math.round(min / step); n--) {
            const pt = Math.round(n * step * 100) / 100;
            if (fits(pt)) return pt;
        }
        return min;
    };

    // ─── Verificaciones de dinero (puras, probadas) ────────────────────────
    /** @param {any} n */
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    /** @param {any[]} cells @returns {string[]} */
    const valueKeys = (cells) => cells.filter((c) => c && c.mode === 'number')
        .flatMap((c) => c.chips.filter((/** @type {any} */ ch) => ch.kind === 'field' && ch.as !== 'label').map((/** @type {any} */ ch) => ch.key));
    /** @param {any} t @returns {any[]} */
    const templateCells = (t) => (t.type === 'table' ? t.columns.map((/** @type {any} */ c) => c.cell) : t.rows.flatMap((/** @type {any} */ r) => r.cells));

    /**
     * Total de cada tarjeta (la última celda con "total hasta ahora") frente al neto de SplitX.
     * null si la tarjeta no tiene total que comparar.
     * @param {any} engine @param {any} t @param {any[]} items @param {(record: any) => number} getNet
     */
    const cardTotals = (engine, t, items, getNet) => {
        /** @type {[number, number] | null} */
        let at = null;
        t.rows.forEach((/** @type {any} */ row, /** @type {number} */ r) => row.cells.forEach((/** @type {any} */ cell, /** @type {number} */ c) => {
            if (cell.chips.some((/** @type {any} */ ch) => ch.kind === 'running')) at = [r, c];
        }));
        if (!at) {
            // Sin "total hasta ahora", vale la última celda que muestra el monto neto.
            t.rows.forEach((/** @type {any} */ row, /** @type {number} */ r) => row.cells.forEach((/** @type {any} */ cell, /** @type {number} */ c) => {
                if (cell.mode === 'number' && valueKeys([cell]).includes('net')) at = [r, c];
            }));
        }
        if (!at) return null;
        const pos = at;
        return items.map(({ record, ctx }) => {
            const res = engine.evaluateRows(t.rows, record, ctx);
            const card = round2(res[pos[0]].cells[pos[1]].value);
            const net = round2(getNet(record));
            const diff = round2(card - net);
            return { record, card, net, diff, ok: Math.abs(diff) < 0.005 };
        });
    };

    /** @type {Record<string, string>} */
    const TOTAL_PREFIX = { bonuses: 'bonus', discounts: 'deduction', loans: 'loan' };
    /**
     * Un total (Descuentos) junto a uno de sus conceptos (Descuento de ley) cuenta el mismo dinero dos veces.
     * @param {any} t
     */
    const doubleCounted = (t) => {
        const keys = valueKeys(templateCells(t));
        return Object.entries(TOTAL_PREFIX)
            .filter(([total]) => keys.includes(total))
            .map(([total, prefix]) => ({ total, concepts: [...new Set(keys.filter((k) => k.startsWith(prefix + ':')))] }))
            .filter((x) => x.concepts.length);
    };

    /**
     * Cambia la fila del total por una fila por concepto (sin repetir los que ya están).
     * @param {any} t @param {string} total @param {string[]} conceptKeys @param {(k: string) => any} fieldDef
     */
    const breakDownRow = (t, total, conceptKeys, fieldDef) => {
        const out = clone(t);
        const at = out.rows.findIndex((/** @type {any} */ r) => valueKeys(r.cells).includes(total));
        if (at < 0) return out;
        const present = new Set(valueKeys(templateCells(out)));
        const rows = conceptKeys.filter((k) => !present.has(k)).map((k) => smartRowFor(k, fieldDef(k), out.columns.length));
        out.rows.splice(at, 1, ...rows);
        return out;
    };

    /**
     * Huella de lo impreso por empleado: el texto de cada celda visible.
     * @param {any} engine @param {any} t @param {any[]} items @param {(record: any) => string | number} idOf
     */
    const printSignatures = (engine, t, items, idOf) => {
        const rows = t.type === 'table' ? [{ cells: t.columns.map((/** @type {any} */ c) => c.cell) }] : t.rows;
        /** @type {Record<string, { name: string, sig: string }>} */
        const out = {};
        for (const { record, ctx } of items) {
            const sig = engine.evaluateRows(rows, record, ctx)
                .filter((/** @type {any} */ r) => !r.hidden)
                .map((/** @type {any} */ r) => r.cells.map((/** @type {any} */ c) => c.text).join('\u241F'))
                .join('\u241E');
            out[String(idOf(record))] = { name: record.employeeName || record.name || '', sig };
        }
        return out;
    };

    /**
     * @param {Record<string, { name: string, sig: string }>} before
     * @param {Record<string, { name: string, sig: string }>} now
     */
    const snapshotDiff = (before, now) => {
        /** @type {string[]} */
        const changed = [];
        /** @type {string[]} */
        const missing = [];
        for (const [id, b] of Object.entries(before)) {
            if (!now[id]) missing.push(b.name);
            else if (now[id].sig !== b.sig) changed.push(b.name);
        }
        return { changed, missing };
    };

    /** @type {Record<string, string>} */
    const PAPER_NAMES = { letter: 'Carta', a4: 'A4', legal: 'Legal', 'half-letter': 'Media carta' };
    /**
     * Resumen corto de la hoja para la barra de página.
     * @param {any} t
     */
    const pageSummary = (t) => {
        const L = t.layout;
        const head = `${PAPER_NAMES[L.paper] || L.paper} · ${L.orientation === 'landscape' ? 'Horizontal' : 'Vertical'}`;
        if (t.type === 'table') return `${head} · filas de ${t.options.rowHeight} mm`;
        const lay = SB.computeLayout(L);
        return `${head} · ${lay.cols}×${lay.rows} · ${Math.round(lay.cardWidth)}×${Math.round(lay.cardHeight)} mm`;
    };

    /**
     * Empleados a imprimir según el modo, con copias repetidas en su lugar.
     * @param {any[]} list @param {any} [opts]
     */
    const selectEmployees = (list, opts) => {
        const o = opts || { mode: 'all' };
        /** @type {any[]} */
        let out;
        if (o.mode === 'unpaid') out = list.filter((e) => !e.paid);
        else if (o.mode === 'loan') out = list.filter((e) => e.payroll && Number(e.payroll.loans) > 0);
        else if (o.mode === 'custom') { const ids = new Set(o.ids || []); out = list.filter((e) => ids.has(e.id)); }
        else out = list.slice();
        const copies = Math.max(1, Math.min(5, Math.floor(o.copies || 1)));
        return copies === 1 ? out : out.flatMap((e) => Array(copies).fill(e));
    };

    /**
     * Historial para deshacer/rehacer: guarda instantáneas (texto) de la plantilla.
     * @param {number} limit
     */
    const createHistory = (limit) => {
        /** @type {string[]} */
        const undo = [];
        /** @type {string[]} */
        let redo = [];
        return {
            /** @param {string} snap */
            push: (snap) => { undo.push(snap); if (undo.length > limit) undo.shift(); redo = []; },
            /** @param {string} current */
            undo: (current) => { if (!undo.length) return null; redo.push(current); return undo.pop() ?? null; },
            /** @param {string} current */
            redo: (current) => { if (!redo.length) return null; undo.push(current); return redo.pop() ?? null; },
            canUndo: () => undo.length > 0,
            canRedo: () => redo.length > 0
        };
    };

    /** @param {any} s */
    const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    /** @param {string} label @param {string} query */
    const paletteMatches = (label, query) => !query || fold(label).includes(fold(query).trim());

    let idSeq = 0;
    const newId = () => `t${Date.now().toString(36)}${(idSeq++).toString(36)}`;
    /** @param {any} t */
    const isValidCard = (t) => !!t && t.type === 'cards' && !SB.validateTemplate(t).errors.length;
    /** @param {any} t */
    const isValidTable = (t) => !!t && t.type === 'table' && !validateTableTemplate(t).length;

    /**
     * Normaliza lo guardado (versión 1 o 2) a { version: 2, templates, active, colors, logo, recent, ... }.
     * @param {any} raw
     */
    const migrateStore = (raw) => {
        /** @type {any} */
        const out = { version: 2, templates: [], active: { A: null, B: null }, colors: true, logo: null, recent: [] };
        const d = raw && typeof raw === 'object' ? raw : {};
        if (Array.isArray(d.templates)) {
            for (const item of d.templates) {
                if (!item || typeof item.id !== 'string') continue;
                if (isValidCard(item.template) || isValidTable(item.template)) {
                    out.templates.push({ id: item.id, name: String(item.name || item.template.name || 'Plantilla').slice(0, 80), template: item.template });
                }
            }
        } else {
            if (isValidCard(d.A)) out.templates.push({ id: newId(), name: d.A.name || 'Sobre de pago', template: d.A });
            if (isValidTable(d.B)) out.templates.push({ id: newId(), name: d.B.name || 'Hoja de firmas', template: d.B });
        }
        if (!out.templates.some((/** @type {any} */ t) => t.template.type === 'cards')) out.templates.push({ id: newId(), name: 'Sobre de pago', template: defaultCardTemplate() });
        if (!out.templates.some((/** @type {any} */ t) => t.template.type === 'table')) out.templates.push({ id: newId(), name: 'Hoja de firmas', template: defaultTableTemplate() });
        /** @param {string} type @param {string | undefined} wanted */
        const pick = (type, wanted) => {
            const ofType = out.templates.filter((/** @type {any} */ t) => t.template.type === type);
            return (ofType.find((/** @type {any} */ t) => t.id === wanted) || ofType[0]).id;
        };
        const act = d.active || {};
        out.active.A = pick('cards', act.A);
        out.active.B = pick('table', act.B);
        if (typeof d.colors === 'boolean') out.colors = d.colors;
        if (typeof d.logo === 'string' && /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(d.logo) && d.logo.length <= 500000) out.logo = d.logo;
        if (Array.isArray(d.recent)) out.recent = d.recent.filter((/** @type {any} */ r) => typeof r === 'string').slice(0, 8);
        const po = d.printOpts || {};
        out.printOpts = {
            mode: ['all', 'unpaid', 'loan', 'custom'].includes(po.mode) ? po.mode : 'all',
            copies: [1, 2, 3].includes(po.copies) ? po.copies : 1,
            ids: Array.isArray(po.ids) ? po.ids.slice(0, 2000) : []
        };
        out.printed = {};
        for (const k of ['A', 'B']) {
            const p = d.printed && d.printed[k];
            if (p && typeof p === 'object' && typeof p.at === 'string' && p.template && p.sigs && typeof p.sigs === 'object') out.printed[k] = p;
        }
        out.tourDone = d.tourDone === true;
        out.ready = { A: !!(d.ready && d.ready.A === true), B: !!(d.ready && d.ready.B === true) };
        out.sheet = d.sheet === 'B' ? 'B' : 'A';
        // Keep valid print-only variables across upgrades. Damaged definitions
        // must never stop the entire sheet editor from opening.
        out.variables = Array.isArray(d.variables) ? d.variables.slice(0, 50) : [];
        try { CV.validateDefinitions(out.variables, SF.createFieldSet()); }
        catch (_) { out.variables = []; }
        return out;
    };

    /**
     * Colores de dinero: los mismos tonos de SplitX (verde, rojo, ámbar) un poco más oscuros
     * para que el texto blanco de los chips y los montos sobre papel blanco se lean bien (≥ 4.5:1).
     */
    const MONEY_COLORS = { bonus: '#047857', deduction: '#e11d48', loan: '#b45309' };

    return {
        PT_MM,
        PRINT_K,
        STORE_KEY,
        LEGACY_STORE_KEY,
        TOTAL_PREFIX,
        MONEY_COLORS,
        F,
        T,
        O,
        RUN,
        cT,
        cN,
        esc,
        clone,
        fold,
        newId,
        defaultCardTemplate,
        defaultTableTemplate,
        validateTableTemplate,
        tablePageGeometry,
        tablePageSizes,
        tableOptions,
        logoFilter,
        footerOnPage,
        resizeColumns,
        columnTotals,
        cardTotals,
        starterTemplates,
        cardFontPt,
        cellFontPt,
        fitFontSize,
        doubleCounted,
        breakDownRow,
        printSignatures,
        snapshotDiff,
        printPageRule,
        catOf,
        smartRowFor,
        smartColumnFor,
        pageSummary,
        selectEmployees,
        createHistory,
        paletteMatches,
        migrateStore
    };
});
