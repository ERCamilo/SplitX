/**
 * SheetStudio.js
 * Editor e impresión de hojas imprimibles sobre SheetBuilder:
 *   Tipo A ('cards'): una tarjeta por empleado para recortar y pegar en el sobre.
 *   Tipo B ('table'): hoja de firmas con una fila por empleado.
 * La app anfitriona le da el contenedor, los empleados y dónde guardar las plantillas.
 * Las funciones puras (plantillas, validación, paginación, totales) se exportan para pruebas.
 */
(function (root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory(require('./SheetBuilder.js'), require('./SplitXSheetFields.js'), require('./SplitXVariables.js'), require('./SplitXFormulaBuilder.js'));
    } else {
        root.SheetStudio = factory(root.SheetBuilder, root.SplitXSheetFields, root.SplitXVariables, root.SplitXFormulaBuilder);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SB, SF, CV, FB) {
    'use strict';

    const PT_MM = 0.3528;          // 1 pt en mm
    const PRINT_K = 96 / 25.4;     // px CSS por mm (impresión a escala real)
    const STORE_KEY = 'Split_sheets_v2';
    const LEGACY_STORE_KEY = 'Split_sheets_v1';

    // ─── Plantillas de ejemplo ─────────────────────────────────────────────
    const F = (key, as) => (as ? { kind: 'field', key, as } : { kind: 'field', key });
    const T = (value) => ({ kind: 'text', value });
    const O = (op) => ({ kind: 'op', op });
    const RUN = () => ({ kind: 'running' });
    const cT = (chips, extra) => Object.assign({ mode: 'text', chips }, extra || {});
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

    /** Valida una plantilla Tipo B; reutiliza la validación de chips/celdas del motor. */
    const validateTableTemplate = (t) => {
        const errors = [];
        if (!t || typeof t !== 'object') return ['La plantilla debe ser un objeto'];
        if (t.type !== 'table') errors.push('Tipo de plantilla inválido (se esperaba "table")');
        if (!Array.isArray(t.columns) || !t.columns.length) errors.push('Faltan columnas');
        if (!Array.isArray(t.title)) errors.push('Falta el encabezado (title)');
        if (!t.layout || !SB.PAPER_SIZES[t.layout.paper]) errors.push('Papel inválido');
        if (!t.options || !(typeof t.options.rowHeight === 'number' && t.options.rowHeight > 0)) errors.push('Alto de fila inválido');
        else if (![true, false, undefined, ...FOOTER_PAGES].includes(t.options.signatures)) errors.push('Pie de firmas inválido');
        if (errors.length) return errors;
        t.columns.forEach((c, i) => {
            if (!c || typeof c.header !== 'string') errors.push(`Columna ${i + 1}: encabezado inválido`);
            if (!['all', 'sign', 'none'].includes(c && c.border)) errors.push(`Columna ${i + 1}: bordes inválidos`);
        });
        const asCards = {
            version: 1, type: 'cards', name: 'x', columns: [1],
            layout: { paper: 'letter', orientation: 'portrait', margin: 10, gap: 4, mode: 'grid', cols: 1, rows: 1 },
            rows: [...t.title.map((c) => ({ cells: [c] })), ...t.columns.map((c) => ({ cells: [c && c.cell] }))]
        };
        return errors.concat(SB.validateTemplate(asCards).errors);
    };

    const FOOTER_PAGES = ['all', 'first', 'last', 'none'];
    const SIGN_LINES = ['low', 'middle', 'divider'];
    const LOGO_STYLES = { color: 'none', bw: 'grayscale(1) contrast(1.2)', invert: 'grayscale(1) contrast(1.2) invert(1)' };

    /** Filtro CSS del logo: a color, blanco y negro o blanco y negro invertido. */
    const logoFilter = (style) => LOGO_STYLES[style] || 'none';
    const TOTALS_MM = 8;
    const FOOTER_MM = 18;

    /** Opciones de la hoja de firmas con valores por defecto (acepta el formato anterior con booleanos). */
    const tableOptions = (o) => {
        const src = o || {};
        const sig = src.signatures === true ? 'all' : src.signatures === false ? 'none' : src.signatures;
        const labels = Array.isArray(src.signLabels) ? src.signLabels.map((x) => String(x || '').trim()).filter(Boolean) : null;
        return {
            totals: !!src.totals,
            signatures: FOOTER_PAGES.includes(sig) ? sig : 'all',
            signLabels: labels || ['Entregado por', 'Revisado por'],
            signLine: SIGN_LINES.includes(src.signLine) ? src.signLine : 'low',
            logoStyle: Object.prototype.hasOwnProperty.call(LOGO_STYLES, src.logoStyle) ? src.logoStyle : 'color',
            rowHeight: typeof src.rowHeight === 'number' && src.rowHeight > 0 ? src.rowHeight : 11
        };
    };

    /** ¿Lleva esta página el pie "Entregado por / Revisado por"? */
    const footerOnPage = (mode, page, pageCount) =>
        mode === 'all' || (mode === 'first' && page === 0) || (mode === 'last' && page === pageCount - 1);

    /** Medidas de la hoja de firmas y cuántas filas caben por página sin pie ni totales (mm). */
    const tablePageGeometry = (t, hasLogo) => {
        const [w, h] = SB.PAPER_SIZES[t.layout.paper] || SB.PAPER_SIZES.letter;
        const landscape = t.layout.orientation === 'landscape';
        const pageWidth = landscape ? h : w;
        const pageHeight = landscape ? w : h;
        const margin = t.layout.margin || 0;
        const titleH = t.title.reduce((s, c) => s + (c.size || 10) * PT_MM * 1.45, 0);
        const headerH = Math.max(titleH, hasLogo ? 18 : 0) + 6;
        const bodyH = pageHeight - 2 * margin - headerH - 8;
        const rowsPerPage = Math.max(1, Math.floor(bodyH / tableOptions(t.options).rowHeight));
        return { pageWidth, pageHeight, margin, bodyH, rowsPerPage };
    };

    /**
     * Filas por página. Los totales van solo en la última; el pie de firmas en las páginas elegidas,
     * así las demás aprovechan todo el alto.
     */
    const tablePageSizes = (t, hasLogo, count) => {
        const o = tableOptions(t.options);
        const { bodyH } = tablePageGeometry(t, hasLogo);
        const cap = (page, isLast) => {
            let h = bodyH;
            if (isLast && o.totals) h -= TOTALS_MM;
            if (o.signatures === 'all' || (o.signatures === 'first' && page === 0) || (o.signatures === 'last' && isLast)) h -= FOOTER_MM;
            return Math.max(1, Math.floor(h / o.rowHeight));
        };
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

    /** Pasa ancho de la columna i a la i+1 (o al revés) sin bajar de 0.2. */
    const resizeColumns = (widths, i, delta) => {
        const out = widths.slice();
        const pairW = out[i] + out[i + 1];
        const a = Math.min(pairW - 0.2, Math.max(0.2, out[i] + delta));
        out[i] = Math.round(a * 100) / 100;
        out[i + 1] = Math.round((pairW - a) * 100) / 100;
        return out;
    };

    /** Suma por columna (null en las que no suman). items = engine.sortRecords(...). */
    const columnTotals = (engine, t, items) => {
        const sums = t.columns.map((c) => (c.sum ? 0 : null));
        const cells = t.columns.map((c) => c.cell);
        for (const { record, ctx } of items) {
            const res = engine.evaluateRows([{ cells }], record, ctx)[0].cells;
            res.forEach((r, i) => { if (sums[i] !== null && typeof r.value === 'number') sums[i] += r.value; });
        }
        return sums.map((s) => (s === null ? null : Math.round(s * 100) / 100));
    };

    const printPageRule = (paper, orientation) => {
        const [w, h] = SB.PAPER_SIZES[paper] || SB.PAPER_SIZES.letter;
        const [pw, ph] = orientation === 'landscape' ? [h, w] : [w, h];
        return `@page { size: ${pw}mm ${ph}mm; margin: 0; }`;
    };

    const CAT = { bonuses: 'bonus', discounts: 'deduction', loans: 'loan', loanPrincipal: 'loan', loanInterest: 'loan', loanBalance: 'loan', loanBalanceBefore: 'loan', loanBalanceAfter: 'loan' };
    const catOf = (key) => CAT[key] || (key.startsWith('bonus:') ? 'bonus' : key.startsWith('deduction:') ? 'deduction' : key.startsWith('loan:') ? 'loan' : 'field');

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const clone = (o) => JSON.parse(JSON.stringify(o));

    // ─── Ayudantes del editor (puros, probados) ────────────────────────────
    const SIGN_BY_CAT = { bonus: '+', deduction: '-', loan: '-' };
    const NO_SUM_KEYS = ['dailyRate', 'loanBalance', 'loanBalanceBefore', 'loanBalanceAfter'];

    /** Fila "Concepto | Monto" lista para usar al soltar un campo sobre la tarjeta. */
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
        const cells = [{ mode: 'text', chips: [label] }];
        for (let i = 1; i < colCount - 1; i++) cells.push({ mode: 'text', chips: [] });
        cells.push(isNumber ? { mode: 'number', align: 'right', chips: valueChips } : { mode: 'text', chips: [F(key)] });
        row.cells = cells;
        return row;
    };

    /** Columna nueva para la hoja de firmas al soltar un campo sobre la tabla. */
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
    const cardBase = (name, rows) => ({
        version: 1, type: 'cards', name, columns: [2, 1], rows,
        layout: { paper: 'letter', orientation: 'portrait', margin: 10, gap: 4, mode: 'grid', cols: 2, rows: 4, cutMarks: true },
        sortBy: { field: 'no', dir: 'asc' }
    });
    const tableBase = (name, columns, orientation) => Object.assign(defaultTableTemplate(), { name, columns, layout: { paper: 'letter', orientation, margin: 12 } });
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
    const cardFontPt = (t) => (t.layout && typeof t.layout.fontSize === 'number' && t.layout.fontSize > 0 ? t.layout.fontSize : BASE_PT);
    /** Las celdas con letra propia crecen o se achican junto con la letra base. */
    const cellFontPt = (cell, base) => (cell.size ? Math.round(cell.size * (base / BASE_PT) * 100) / 100 : null);
    /** Mayor tamaño (de max hacia min, en pasos de step) para el que fits(pt) es verdadero. */
    const fitFontSize = (fits, { max, min, step }) => {
        for (let n = Math.round(max / step); n >= Math.round(min / step); n--) {
            const pt = Math.round(n * step * 100) / 100;
            if (fits(pt)) return pt;
        }
        return min;
    };

    // ─── Verificaciones de dinero (puras, probadas) ────────────────────────
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const valueKeys = (cells) => cells.filter((c) => c && c.mode === 'number')
        .flatMap((c) => c.chips.filter((ch) => ch.kind === 'field' && ch.as !== 'label').map((ch) => ch.key));
    const templateCells = (t) => (t.type === 'table' ? t.columns.map((c) => c.cell) : t.rows.flatMap((r) => r.cells));

    /**
     * Total de cada tarjeta (la última celda con "total hasta ahora") frente al neto de SplitX.
     * null si la tarjeta no tiene total que comparar.
     */
    const cardTotals = (engine, t, items, getNet) => {
        let at = null;
        t.rows.forEach((row, r) => row.cells.forEach((cell, c) => { if (cell.chips.some((ch) => ch.kind === 'running')) at = [r, c]; }));
        if (!at) {
            // Sin "total hasta ahora", vale la última celda que muestra el monto neto.
            t.rows.forEach((row, r) => row.cells.forEach((cell, c) => { if (cell.mode === 'number' && valueKeys([cell]).includes('net')) at = [r, c]; }));
        }
        if (!at) return null;
        return items.map(({ record, ctx }) => {
            const res = engine.evaluateRows(t.rows, record, ctx);
            const card = round2(res[at[0]].cells[at[1]].value);
            const net = round2(getNet(record));
            const diff = round2(card - net);
            return { record, card, net, diff, ok: Math.abs(diff) < 0.005 };
        });
    };

    const TOTAL_PREFIX = { bonuses: 'bonus', discounts: 'deduction', loans: 'loan' };
    /** Un total (Descuentos) junto a uno de sus conceptos (Descuento de ley) cuenta el mismo dinero dos veces. */
    const doubleCounted = (t) => {
        const keys = valueKeys(templateCells(t));
        return Object.entries(TOTAL_PREFIX)
            .filter(([total]) => keys.includes(total))
            .map(([total, prefix]) => ({ total, concepts: [...new Set(keys.filter((k) => k.startsWith(prefix + ':')))] }))
            .filter((x) => x.concepts.length);
    };

    /** Cambia la fila del total por una fila por concepto (sin repetir los que ya están). */
    const breakDownRow = (t, total, conceptKeys, fieldDef) => {
        const out = clone(t);
        const at = out.rows.findIndex((r) => valueKeys(r.cells).includes(total));
        if (at < 0) return out;
        const present = new Set(valueKeys(templateCells(out)));
        const rows = conceptKeys.filter((k) => !present.has(k)).map((k) => smartRowFor(k, fieldDef(k), out.columns.length));
        out.rows.splice(at, 1, ...rows);
        return out;
    };

    /** Huella de lo impreso por empleado: el texto de cada celda visible. */
    const printSignatures = (engine, t, items, idOf) => {
        const rows = t.type === 'table' ? [{ cells: t.columns.map((c) => c.cell) }] : t.rows;
        const out = {};
        for (const { record, ctx } of items) {
            const sig = engine.evaluateRows(rows, record, ctx).filter((r) => !r.hidden).map((r) => r.cells.map((c) => c.text).join('\u241F')).join('\u241E');
            out[idOf(record)] = { name: record.employeeName || record.name || '', sig };
        }
        return out;
    };
    const snapshotDiff = (before, now) => {
        const changed = []; const missing = [];
        for (const [id, b] of Object.entries(before)) {
            if (!now[id]) missing.push(b.name);
            else if (now[id].sig !== b.sig) changed.push(b.name);
        }
        return { changed, missing };
    };

    const PAPER_NAMES = { letter: 'Carta', a4: 'A4', legal: 'Legal', 'half-letter': 'Media carta' };
    /** Resumen corto de la hoja para la barra de página. */
    const pageSummary = (t) => {
        const L = t.layout;
        const head = `${PAPER_NAMES[L.paper] || L.paper} · ${L.orientation === 'landscape' ? 'Horizontal' : 'Vertical'}`;
        if (t.type === 'table') return `${head} · filas de ${t.options.rowHeight} mm`;
        const lay = SB.computeLayout(L);
        return `${head} · ${lay.cols}×${lay.rows} · ${Math.round(lay.cardWidth)}×${Math.round(lay.cardHeight)} mm`;
    };

    /** Empleados a imprimir según el modo, con copias repetidas en su lugar. */
    const selectEmployees = (list, opts) => {
        const o = opts || { mode: 'all' };
        let out;
        if (o.mode === 'unpaid') out = list.filter((e) => !e.paid);
        else if (o.mode === 'loan') out = list.filter((e) => e.payroll && Number(e.payroll.loans) > 0);
        else if (o.mode === 'custom') { const ids = new Set(o.ids || []); out = list.filter((e) => ids.has(e.id)); }
        else out = list.slice();
        const copies = Math.max(1, Math.min(5, Math.floor(o.copies || 1)));
        return copies === 1 ? out : out.flatMap((e) => Array(copies).fill(e));
    };

    /** Historial para deshacer/rehacer: guarda instantáneas (texto) de la plantilla. */
    const createHistory = (limit) => {
        const undo = [];
        let redo = [];
        return {
            push: (snap) => { undo.push(snap); if (undo.length > limit) undo.shift(); redo = []; },
            undo: (current) => { if (!undo.length) return null; redo.push(current); return undo.pop(); },
            redo: (current) => { if (!redo.length) return null; undo.push(current); return redo.pop(); },
            canUndo: () => undo.length > 0,
            canRedo: () => redo.length > 0
        };
    };

    const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const paletteMatches = (label, query) => !query || fold(label).includes(fold(query).trim());

    let idSeq = 0;
    const newId = () => `t${Date.now().toString(36)}${(idSeq++).toString(36)}`;
    const isValidCard = (t) => !!t && t.type === 'cards' && !SB.validateTemplate(t).errors.length;
    const isValidTable = (t) => !!t && t.type === 'table' && !validateTableTemplate(t).length;

    /** Normaliza lo guardado (versión 1 o 2) a { version: 2, templates, active, colors, logo, recent }. */
    const migrateStore = (raw) => {
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
        if (!out.templates.some((t) => t.template.type === 'cards')) out.templates.push({ id: newId(), name: 'Sobre de pago', template: defaultCardTemplate() });
        if (!out.templates.some((t) => t.template.type === 'table')) out.templates.push({ id: newId(), name: 'Hoja de firmas', template: defaultTableTemplate() });
        const pick = (type, wanted) => {
            const ofType = out.templates.filter((t) => t.template.type === type);
            return (ofType.find((t) => t.id === wanted) || ofType[0]).id;
        };
        const act = d.active || {};
        out.active.A = pick('cards', act.A);
        out.active.B = pick('table', act.B);
        if (typeof d.colors === 'boolean') out.colors = d.colors;
        if (typeof d.logo === 'string' && d.logo.startsWith('data:image/')) out.logo = d.logo;
        if (Array.isArray(d.recent)) out.recent = d.recent.filter((r) => typeof r === 'string').slice(0, 8);
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

    // ─── Estilos (se inyectan una vez) ─────────────────────────────────────
    const CSS = `
.ss { --bg:#f8fafc; --surface:#fff; --surface-2:#f1f5f9; --fg:#1e293b; --strong:#0f172a; --muted:#475569; --faint:#64748b;
  --border:#e2e8f0; --border-strong:#cbd5e1; --accent:#2563eb; --accent-fg:#fff; --accent-soft:#eff6ff;
  --indigo:#4f46e5; --indigo-soft:#eef2ff; --indigo-fg:#4338ca; --field-bg:#eff6ff; --field-fg:#1d4ed8; --field-bd:#bfdbfe;
  --text-bg:#f1f5f9; --text-fg:#334155; --text-bd:#94a3b8; --numchip-bg:#fffbeb; --numchip-fg:#92400e; --numchip-bd:#fcd34d;
  --run-bg:#f0fdf4; --run-fg:#166534; --run-bd:#bbf7d0; --sel:#2563eb; --warn-bg:#fffbeb; --warn-fg:#92400e; --warn-bd:#fde68a;
  --err:#e11d48; --desk:#e2e8f0; --shadow:0 10px 30px rgba(15,23,42,.18);
  position:fixed; inset:0; z-index:60; display:flex; flex-direction:column; background:var(--bg); color:var(--fg); font-family:Inter,system-ui,sans-serif; font-size:14px; }
html.dark .ss { --bg:#0b1120; --surface:#0f172a; --surface-2:#1e293b; --fg:#e2e8f0; --strong:#f8fafc; --muted:#cbd5e1; --faint:#94a3b8;
  --border:#1e293b; --border-strong:#334155; --accent:#3b82f6; --accent-soft:#172554; --indigo:#818cf8; --indigo-soft:#1e1b4b; --indigo-fg:#c7d2fe;
  --field-bg:#172554; --field-fg:#bfdbfe; --field-bd:#1e40af; --text-bg:#1e293b; --text-fg:#e2e8f0; --text-bd:#64748b;
  --numchip-bg:#451a03; --numchip-fg:#fde68a; --numchip-bd:#92400e; --run-bg:#052e16; --run-fg:#bbf7d0; --run-bd:#166534;
  --sel:#60a5fa; --warn-bg:#451a03; --warn-fg:#fde68a; --warn-bd:#92400e; --err:#fb7185; --desk:#020617; color-scheme:dark; }
.ss, #ss-print { --bonus:${MONEY_COLORS.bonus}; --deduction:${MONEY_COLORS.deduction}; --loan:${MONEY_COLORS.loan}; --solid-fg:#fff; --paper:#fff; --ink:#334155; --ink-strong:#0f172a; --paper-line:#94a3b8; }
.ss[hidden] { display:none !important; }
.ss *, #ss-print * { box-sizing:border-box; }
.ss button, .ss input, .ss select, .ss textarea { font:inherit; color:inherit; }
.ss button { cursor:pointer; }
.ss button:disabled { cursor:default; opacity:.4; }
.ss :focus-visible { outline:2px solid var(--sel); outline-offset:2px; }
/* Barra superior */
.ss-bar { flex:none; background:var(--surface); border-bottom:1px solid var(--border); padding:8px 16px; display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; }
.ss-title { font-weight:800; font-size:16px; color:var(--strong); white-space:nowrap; }
.ss-grow { flex-grow:1; }
.ss-seg { display:inline-flex; gap:3px; background:var(--surface-2); padding:3px; border-radius:9px; flex-wrap:wrap; }
.ss-seg button { border:0; background:transparent; color:var(--muted); font-weight:500; font-size:13px; padding:6px 11px; border-radius:7px; min-height:32px; }
.ss-seg button[aria-pressed="true"] { background:var(--surface); color:var(--strong); font-weight:600; box-shadow:0 1px 2px rgba(15,23,42,.12); }
.ss-seg.sm button { font-size:12px; padding:4px 9px; min-height:28px; }
.ss-btn { border:1px solid var(--border-strong); background:var(--surface); color:var(--fg); font-weight:600; font-size:13px; padding:7px 12px; border-radius:8px; min-height:36px; display:inline-flex; align-items:center; gap:6px; white-space:nowrap; }
.ss-btn:hover:not(:disabled) { border-color:var(--accent); }
.ss-btn.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
.ss-btn.danger { color:var(--err); }
.ss-btn.ghost { border-color:transparent; background:transparent; }
.ss-btn.sm { font-size:12px; padding:4px 9px; min-height:30px; }
.ss-tplbtn { max-width:260px; overflow:hidden; text-overflow:ellipsis; }
.ss-pagebar { flex:none; display:flex; align-items:center; gap:10px; padding:6px 16px; background:var(--surface); border-bottom:1px solid var(--border); font-size:12px; color:var(--muted); }
/* Cuerpo: paleta | lienzo | propiedades */
.ss-body { flex:1; min-height:0; display:grid; grid-template-columns:270px minmax(0,1fr) 320px; }
.ss-col { min-height:0; overflow-y:auto; }
.ss-palette { border-right:1px solid var(--border); background:var(--surface); padding:12px; display:flex; flex-direction:column; gap:10px; }
.ss-inspector { border-left:1px solid var(--border); background:var(--surface); padding:14px; display:flex; flex-direction:column; gap:12px; }
.ss-canvas { padding:16px 24px 40px; display:flex; flex-direction:column; align-items:center; gap:12px; }
.ss-lbl { margin:0; font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.ss-hint { margin:0; font-size:12px; line-height:1.5; color:var(--muted); }
.ss-note { font-size:12px; line-height:1.5; background:var(--warn-bg); color:var(--warn-fg); border:1px solid var(--warn-bd); border-radius:10px; padding:9px 11px; }
.ss-field { display:flex; flex-direction:column; gap:5px; font-size:12px; font-weight:600; color:var(--muted); }
.ss-inp { border:1px solid var(--border-strong); background:var(--surface); border-radius:8px; padding:6px 9px; font-weight:500; font-size:13px; color:var(--fg); min-height:34px; width:100%; }
.ss-num { font-family:'JetBrains Mono',ui-monospace,monospace; font-variant-numeric:tabular-nums; }
.ss-grid2 { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.ss-check { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--fg); }
.ss-check input { width:16px; height:16px; accent-color:var(--accent); }
.ss-sec { display:flex; flex-direction:column; gap:10px; padding-top:12px; border-top:1px solid var(--border); }
.ss-sec:first-child { border-top:0; padding-top:0; }
.ss-sec > h3.ss-lbl[data-fold] { cursor:pointer; display:flex; align-items:center; gap:6px; user-select:none; }
.ss-sec > h3.ss-lbl[data-fold]::before { content:'▾'; font-size:10px; transition:transform .12s; }
.ss-sec.collapsed > h3.ss-lbl[data-fold]::before { transform:rotate(-90deg); }
.ss-sec.collapsed > :not(h3) { display:none !important; }
.ss-row-btns { display:flex; flex-wrap:wrap; gap:6px; }
/* Paleta */
.ss-search { position:sticky; top:-12px; background:var(--surface); padding:0 0 6px; z-index:1; }
.ss-group summary { list-style:none; cursor:pointer; font-size:12px; font-weight:700; color:var(--fg); padding:4px 0; display:flex; align-items:center; gap:6px; }
.ss-group summary::-webkit-details-marker { display:none; }
.ss-group summary::before { content:'▸'; color:var(--faint); font-size:10px; transition:transform .15s; }
.ss-group[open] summary::before { transform:rotate(90deg); }
.ss-group .count { color:var(--faint); font-weight:500; }
.ss-chips { display:flex; flex-wrap:wrap; gap:6px; padding:4px 0 6px; }
.ss-chip { display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:600; line-height:1.2; padding:4px 9px; border-radius:999px; border:1px solid transparent; user-select:none; cursor:grab; white-space:nowrap; font-family:Inter,system-ui,sans-serif; }
.ss-chip.k-field { background:var(--field-bg); color:var(--field-fg); border-color:var(--field-bd); }
.ss-chip.k-bonus { background:var(--bonus); color:var(--solid-fg); border-color:var(--bonus); font-weight:700; }
.ss-chip.k-deduction { background:var(--deduction); color:var(--solid-fg); border-color:var(--deduction); font-weight:700; }
.ss-chip.k-loan { background:var(--loan); color:var(--solid-fg); border-color:var(--loan); font-weight:700; }
.ss-chip.k-op { background:var(--indigo-soft); color:var(--indigo-fg); border-color:var(--indigo); border-radius:6px; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:13px; padding:3px 9px; }
.ss-chip.k-text { background:var(--text-bg); color:var(--text-fg); border:1px dashed var(--text-bd); border-radius:6px; font-weight:500; }
.ss-chip.k-number { background:var(--numchip-bg); color:var(--numchip-fg); border:1px dashed var(--numchip-bd); border-radius:6px; font-family:'JetBrains Mono',ui-monospace,monospace; }
.ss-chip.k-running { background:var(--run-bg); color:var(--run-fg); border-color:var(--run-bd); border-radius:6px; font-weight:700; }
.ss-chip .as { font-size:9px; font-weight:800; letter-spacing:.04em; padding:1px 4px; border-radius:4px; background:rgba(255,255,255,.28); }
.ss-chip.k-field .as { background:var(--field-bd); }
.ss-chip.is-sel { outline:2px solid var(--sel); outline-offset:2px; }
.ss-chip.bad { outline:2px dashed var(--err); }
.ss-chip.dragging { opacity:.35; }
/* Lienzo */
.ss-tools { display:flex; flex-wrap:wrap; align-items:center; gap:10px; width:100%; max-width:900px; }
.ss-emp { display:flex; align-items:center; gap:4px; }
.ss-emp select { max-width:220px; }
.ss-stage { position:relative; padding:26px 44px 8px 40px; }
.ss-paper { position:relative; background:var(--paper); color:var(--ink); box-shadow:var(--shadow); border-radius:2px; }
.ss-cardedit { display:flex; flex-direction:column; }
.ss-limit { position:absolute; left:-12px; right:-12px; border-top:2px dashed var(--err); pointer-events:none; }
.ss-limit span { position:absolute; right:0; top:2px; font-size:10px; font-weight:700; color:var(--err); background:var(--paper); padding:0 4px; }
.ss-erow { position:relative; display:grid; column-gap:.6em; align-items:baseline; border-radius:4px; }
.ss-erow.line { border-top:1px solid var(--paper-line); margin-top:.25em; padding-top:.25em; }
.ss-erow:hover { background:rgba(37,99,235,.06); }
.ss-erow.ghost { opacity:.4; }
.ss-erow.row-sel { background:rgba(37,99,235,.08); }
.ss-handle, .ss-rowmenu { position:absolute; top:50%; transform:translateY(-50%); width:24px; height:24px; display:flex; align-items:center; justify-content:center; border-radius:6px; border:0; background:transparent; color:var(--faint); font-size:13px; opacity:0; }
.ss-handle { left:-34px; cursor:grab; }
.ss-rowmenu { right:-38px; }
.ss-erow:hover .ss-handle, .ss-erow:hover .ss-rowmenu, .ss-erow.row-sel .ss-handle, .ss-erow.row-sel .ss-rowmenu { opacity:1; }
.ss-handle:hover, .ss-rowmenu:hover { background:var(--surface-2); color:var(--strong); }
.ss-ghost-tag { position:absolute; right:4px; top:-.9em; font-size:9px; font-weight:700; color:var(--faint); background:var(--paper); padding:0 4px; border-radius:4px; opacity:1; }
.ss-cell { min-width:0; min-height:1.4em; border-radius:3px; outline:1px dashed transparent; cursor:pointer; display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
.ss-cell:hover { outline-color:var(--paper-line); }
.ss-cell.sel { outline:2px solid var(--sel); outline-offset:1px; }
.ss-cell.over { outline:2px solid var(--sel); background:rgba(37,99,235,.08); }
.ss-cell.chipview { padding:2px; }
.ss-cell .ss-out { flex:1; }
.ss-cell .empty { color:#94a3b8; font-style:italic; font-size:.85em; }
.ss-insert { height:6px; margin:-3px 0; position:relative; z-index:1; }
.ss-insert.over::after { content:''; position:absolute; left:-8px; right:-8px; top:2px; height:3px; border-radius:2px; background:var(--sel); }
.ss-dropzone { margin-top:14px; border:2px dashed var(--border-strong); border-radius:10px; padding:12px; text-align:center; color:var(--muted); font-size:12px; display:flex; flex-direction:column; align-items:center; gap:8px; }
.ss-dropzone.over { border-color:var(--sel); background:var(--accent-soft); color:var(--strong); }
.ss-warn { font-size:12px; color:var(--err); font-weight:600; }
/* Hoja de firmas en el lienzo */
.ss-sheetedit { padding:20px 24px; display:flex; flex-direction:column; gap:10px; }
.ss-titles { display:flex; flex-direction:column; gap:3px; border-bottom:2px solid var(--ink-strong); padding-bottom:8px; }
.ss-tline { position:relative; }
.ss-tline .ss-cell { min-height:1.6em; }
.ss-tline:hover .ss-rowmenu, .ss-tline.row-sel .ss-rowmenu { opacity:1; }
.ss-sigedit { display:flex; align-items:stretch; gap:8px; }
.ss-sigedit table { flex:1; }
.ss-colstrip { width:44px; flex:none; border:2px dashed var(--border-strong); border-radius:8px; display:flex; align-items:center; justify-content:center; writing-mode:vertical-rl; transform:rotate(180deg); font-size:11px; color:var(--muted); padding:6px 0; }
.ss-colstrip.over { border-color:var(--sel); background:var(--accent-soft); }
table.ss-sig th.col-sel, table.ss-sig td.col-sel { box-shadow:inset 0 0 0 2px var(--sel); }
table.ss-sig th.over { box-shadow:inset 3px 0 0 var(--sel); }
table.ss-sig th { cursor:grab; position:relative; }
/* Ventanas emergentes */
.ss-pop { position:fixed; z-index:75; background:var(--surface); color:var(--fg); border:1px solid var(--border-strong); border-radius:12px; box-shadow:0 16px 40px rgba(15,23,42,.25); padding:12px; display:flex; flex-direction:column; gap:10px; min-width:240px; max-width:340px; }
.ss-menu { display:flex; flex-direction:column; gap:2px; min-width:200px; }
.ss-menu button { text-align:left; border:0; background:transparent; padding:7px 10px; border-radius:7px; font-size:13px; color:var(--fg); display:flex; justify-content:space-between; gap:12px; }
.ss-menu button:hover { background:var(--surface-2); }
.ss-menu button.active { font-weight:700; color:var(--accent); }
.ss-menu button.danger { color:var(--err); }
.ss-menu hr { border:0; border-top:1px solid var(--border); margin:4px 0; }
.ss-kbd { font-size:11px; color:var(--faint); }
.ss-scrim { position:fixed; inset:0; background:rgba(15,23,42,.45); z-index:80; display:flex; justify-content:flex-end; }
.ss-drawer { background:var(--surface); width:min(560px,100%); height:100%; overflow-y:auto; display:flex; flex-direction:column; gap:12px; padding:18px; }
.ss-drawer textarea { width:100%; min-height:300px; border:1px solid var(--border-strong); background:var(--bg); border-radius:10px; padding:10px; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:12px; color:var(--fg); }
.ss-toast, .ss-trash { position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:90; padding:10px 14px; border-radius:10px; font-size:13px; font-weight:600; }
.ss-toast { background:var(--strong); color:var(--bg); display:flex; gap:10px; align-items:center; }
.ss-toast button { border:0; background:transparent; color:inherit; text-decoration:underline; font-weight:700; }
.ss-trash { background:var(--deduction); color:var(--solid-fg); font-size:14px; padding:12px 18px; pointer-events:none; display:none; }
.ss.trashing .ss-trash { display:block; }
.ss-msg-err { color:var(--err); font-size:13px; font-weight:600; white-space:pre-line; }
/* Paso de impresión */
.ss-printstep { flex:1; min-height:0; display:grid; grid-template-columns:340px minmax(0,1fr); }
.ss-printside { border-right:1px solid var(--border); background:var(--surface); padding:16px; overflow-y:auto; display:flex; flex-direction:column; gap:14px; }
.ss-printpages { overflow-y:auto; }
.ss-radio { display:flex; align-items:center; gap:8px; font-size:13px; padding:7px 9px; border:1px solid var(--border); border-radius:8px; cursor:pointer; }
.ss-radio.on { border-color:var(--accent); background:var(--accent-soft); }
.ss-radio input { accent-color:var(--accent); }
.ss-radio .n { margin-left:auto; color:var(--faint); font-size:12px; }
.ss-emplist { max-height:280px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; padding:4px; }
.ss-emplist label { display:flex; gap:8px; align-items:center; font-size:13px; padding:4px 6px; border-radius:6px; }
.ss-emplist label:hover { background:var(--surface-2); }
.ss-big { font-size:15px; min-height:44px; justify-content:center; }
.ss-desk { background:var(--desk); padding:20px; display:flex; flex-direction:column; align-items:center; gap:16px; min-height:100%; }
.ss-page-no { font-size:11px; color:var(--faint); }
/* Papel (pantalla e impresión) */
.ss-page { background:var(--paper); color:var(--ink); box-shadow:0 8px 28px rgba(15,23,42,.18); position:relative; flex:none; font-family:Inter,system-ui,sans-serif; overflow:hidden; }
.ss-cards { display:grid; }
.ss-card { overflow:hidden; display:flex; flex-direction:column; color:var(--ink); background:var(--paper); }
.ss-card.cut { outline:1px dashed var(--paper-line); }
.ss-crow { display:grid; column-gap:.6em; align-items:baseline; }
.ss-crow.line { border-top:1px solid var(--paper-line); margin-top:.25em; padding-top:.25em; }
.ss-out { min-width:0; overflow-wrap:anywhere; }
.ss-out.n { font-family:'JetBrains Mono',ui-monospace,monospace; font-variant-numeric:tabular-nums; }
.c-bonus { color:var(--bonus); } .c-deduction { color:var(--deduction); } .c-loan { color:var(--loan); }
.ss-out.err { color:#e11d48; }
.mono-ink .c-bonus, .mono-ink .c-deduction, .mono-ink .c-loan { color:var(--ink-strong); }
table.ss-sig { width:100%; border-collapse:collapse; table-layout:fixed; color:var(--ink); }
table.ss-sig th { background:#f1f5f9; color:var(--ink-strong); font-weight:700; padding:.35em .45em; }
table.ss-sig td { padding:.2em .45em; vertical-align:middle; overflow:hidden; }
.b-all { border:1px solid #334155; } .b-none { border:0; } .b-sign { border:0; vertical-align:bottom !important; }
.b-sign .sline { border-bottom:1px solid #0f172a; height:1px; margin:0 .6em .45em; }
.b-sign.sl-middle { vertical-align:middle !important; } .b-sign.sl-middle .sline { margin:0 .6em; }
.b-sign.sl-divider { border-bottom:1px solid #334155; } .b-sign.sl-divider .sline { display:none; }
/* Asas para cambiar tamaños en la vista previa */
.ss-card { position:relative; }
.ss-grips { position:absolute; inset:0; pointer-events:none; }
.ss-rz { position:absolute; top:0; right:-4px; width:8px; height:100%; cursor:col-resize; z-index:2; pointer-events:auto; border-radius:3px; }
.ss-rz.v { right:auto; transform:translateX(-4px); }
.ss-rz:hover, .ss-rz.on { background:rgba(37,99,235,.35); }
.ss-rz.corner { top:auto; right:0; bottom:0; width:14px; height:14px; cursor:nwse-resize; background:linear-gradient(135deg, transparent 50%, rgba(37,99,235,.6) 50%); border-radius:0 0 3px 0; }
.ss-resizing, .ss-resizing * { cursor:inherit !important; user-select:none; }
.ss-cardedit .ss-insert { margin:0; }
.ss-cardedit:not(.formulas) .ss-cell { min-height:0; }
.ss-ruler { position:absolute; top:-20px; display:flex; height:14px; border-bottom:1px solid var(--paper-line); font-size:9px; color:#94a3b8; font-family:Inter,system-ui,sans-serif; }
.ss-ruler span:not(.ss-rz) { text-align:center; line-height:13px; border-right:1px dotted var(--paper-line); }
.ss-ruler .ss-rz { height:100%; background:rgba(37,99,235,.25); width:6px; transform:translateX(-3px); }
.ss-ruler .ss-rz:hover { background:rgba(37,99,235,.6); }
.ss-cardedit.formulas .ss-erow { align-items:stretch; padding:4px 0; border-bottom:1px solid var(--paper-line); border-radius:0; }
.ss-cardedit.formulas .ss-erow.alt { background:rgba(148,163,184,.10); }
.ss-cardedit.formulas .ss-erow.line { border-top:2px solid var(--ink-strong); }
.ss-cardedit.formulas .ss-cell { outline:1px dashed var(--paper-line); padding:3px; }
.ss-sheetedit.formulas table.ss-sig { table-layout:auto; }
.ss-sheetedit.formulas table.ss-sig td { overflow:visible; vertical-align:top; min-width:5em; }
.ss-sheetedit.formulas .ss-cell .ss-chip { white-space:nowrap; overflow-wrap:normal; }
.ss-sheetedit .ss-cell .ss-chip { white-space:normal; overflow-wrap:anywhere; max-width:100%; min-width:0; }
.ss-titlewrap { display:flex; gap:12px; align-items:center; } .ss-titlewrap > div { flex:1; min-width:0; } .ss-titlewrap img { object-fit:contain; flex:none; }
.ss-logoprev { display:flex; gap:10px; align-items:center; } .ss-logoprev img { width:48px; height:48px; object-fit:contain; border:1px solid var(--border); border-radius:6px; background:#fff; }
.ss-alert { border-radius:8px; padding:8px 10px; font-size:12.5px; line-height:1.45; display:flex; flex-direction:column; gap:4px; border:1px solid; }
.ss-hint.ss-bad { color:var(--err); font-weight:700; }
.ss-starters { display:flex; flex-direction:column; gap:6px; }
.ss-starters button { text-align:left; border:1px solid var(--border); background:var(--surface); color:var(--fg); border-radius:9px; padding:8px 10px; display:flex; flex-direction:column; gap:2px; cursor:pointer; }
.ss-starters button:hover { border-color:var(--accent); background:var(--accent-soft); }
.ss-starters span { font-size:12px; color:var(--muted); }
.ss-thumb { position:sticky; bottom:12px; margin:16px 0 0 auto; display:flex; flex-direction:column; align-items:center; gap:4px; border:1px solid var(--border); border-radius:10px; background:var(--surface); padding:8px; cursor:pointer; box-shadow:0 6px 18px rgba(15,23,42,.15); z-index:3; }
.ss-thumb:hover { border-color:var(--accent); }
.ss-thumb span { font-size:11px; color:var(--muted); }
.ss-thumb-page { pointer-events:none; overflow:hidden; }
.ss-thumb-page .ss-page { box-shadow:0 1px 4px rgba(15,23,42,.25); }
.ss-tour { position:fixed; z-index:85; width:300px; background:var(--strong); color:var(--bg); border-radius:12px; padding:12px 14px; box-shadow:0 16px 40px rgba(15,23,42,.35); font-size:13px; display:flex; flex-direction:column; gap:6px; }
.ss-tour p { margin:0; line-height:1.45; }
.ss-tour .ss-kbd { color:inherit; opacity:.7; }
.ss-tour .ss-btn.ghost { color:inherit; }
.ss-tour-focus { outline:3px solid var(--accent) !important; outline-offset:3px; border-radius:8px; }
.ss-quick { display:flex; flex-wrap:wrap; gap:5px; margin-top:6px; }
.ss-quick .ss-chip { cursor:pointer; }
.ss-alert ul { margin:2px 0 0 16px; padding:0; }
.ss-alert.ok { background:rgba(5,150,105,.08); border-color:rgba(5,150,105,.35); color:var(--fg); }
.ss-alert.warn { background:rgba(217,119,6,.10); border-color:rgba(217,119,6,.45); color:var(--fg); }
.ss-alert.err { background:rgba(225,29,72,.08); border-color:rgba(225,29,72,.45); color:var(--fg); }
.ss-alert + .ss-alert { margin-top:6px; }
.ss-status.ok { color:#047857; border-color:rgba(5,150,105,.45); }
.ss-status.warn { color:#b45309; border-color:rgba(217,119,6,.6); background:rgba(217,119,6,.08); font-weight:700; }
.ss-colsum { display:flex; flex-direction:column; gap:2px; }
.ss-colsum label { display:flex; gap:8px; align-items:center; font-size:13px; padding:3px 6px; border-radius:6px; }
.ss-sig-head { display:flex; gap:1em; align-items:center; border-bottom:2px solid var(--ink-strong); padding-bottom:.6em; margin-bottom:.8em; }
.ss-sig-head img { object-fit:contain; }
.ss-sig-foot { display:flex; gap:3em; margin-top:auto; }
.ss-sig-foot div { flex:1; border-top:1px solid var(--ink-strong); text-align:center; padding-top:.4em; }
#ss-print { display:none; }
@media print {
  body.ss-printing > *:not(#ss-print) { display:none !important; }
  body.ss-printing #ss-print { display:block; }
  #ss-print { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  #ss-print .ss-page { box-shadow:none; break-after:page; page-break-after:always; margin:0; }
  #ss-print .ss-page:last-child { break-after:auto; page-break-after:auto; }
}`;

    const injectCss = () => {
        if (typeof document === 'undefined' || document.getElementById('ss-style')) return;
        const el = document.createElement('style');
        el.id = 'ss-style';
        el.textContent = CSS;
        document.head.appendChild(el);
    };

    // ─── Paleta ────────────────────────────────────────────────────────────
    const GROUPS = [
        ['Montos', ['gross', 'bonuses', 'discounts', 'afterDiscounts', 'net', 'dailyRate']],
        ['Préstamos y adelantos', ['loans', 'loanPrincipal', 'loanInterest', 'loanBalanceBefore', 'loanBalanceAfter']],
        ['Empleado', ['no', 'folio', 'name', 'firstName', 'position', 'leader']],
        ['Días', ['days', 'daysRegular', 'daysOvertime', 'daysHoliday', 'daysRest']],
        ['Encabezado', ['company', 'payrollName', 'project', 'period', 'currency']]
    ];
    const TOOLS = [
        { label: '+', chip: O('+') }, { label: '−', chip: O('-') }, { label: '×', chip: O('*') }, { label: '÷', chip: O('/') },
        { label: '(', chip: { kind: 'paren', paren: '(' } }, { label: ')', chip: { kind: 'paren', paren: ')' } },
        { label: 'Aa Texto', chip: T('Texto') }, { label: '# Número', chip: { kind: 'number', value: 0 } },
        { label: '% Porcentaje', chip: { kind: 'number', value: 3, percent: true } }, { label: 'Σ Total hasta ahora', chip: RUN() }
    ];
    const OPS = { '+': '+', '-': '−', '*': '×', '/': '÷' };
    const PAPERS = [['letter', 'Carta (216 × 279 mm)'], ['a4', 'A4 (210 × 297 mm)'], ['legal', 'Legal (216 × 356 mm)'], ['half-letter', 'Media carta (140 × 216 mm)']];
    const SORTS = [['no', 'No.'], ['name', 'Nombre'], ['net', 'Monto neto'], ['position', 'Puesto']];
    const DEFAULT_OPEN = { 'Usados recientemente': true, 'Variables propias': true, 'Conceptos importados': true, Montos: true, 'Préstamos y adelantos': true, Herramientas: true };

    /**
     * @param {{ root: HTMLElement, getEmployees: () => any[], getNetAmount?: (emp: any) => number,
     *           storage?: { get: (k: string) => string | null, set: (k: string, v: string) => void },
     *           onClose?: () => void, locale?: string }} opts
     */
    const createStudio = (opts) => {
        const rootEl = opts.root;
        const storage = opts.storage || {
            get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
            set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }
        };
        const state = {
            store: migrateStore(null), sheet: 'A', formulas: false, preview: 0, sel: null, pop: null, drawer: null,
            printing: false, printOpts: { mode: 'all', ids: [], copies: 1 }, folded: {}, query: '', open: Object.assign({}, DEFAULT_OPEN), confirmDelete: false,
            variableEdit: null, variableDeleteConfirm: null
        };
        const histories = new Map();
        let employees = []; let engine; let fieldSet; let palette = []; let drag = null; let rz = false; let bound = false;
        let formulaBuilder = null; let variableSeedChips = null; let lastCommit = { key: '', at: 0 };

        const $ = (sel) => rootEl.querySelector(sel);

        // ─── Plantillas activas y persistencia ─────────────────────────────
        const typeOf = (sheet) => (sheet === 'A' ? 'cards' : 'table');
        const activeEntry = () => state.store.templates.find((t) => t.id === state.store.active[state.sheet]);
        const tpl = () => activeEntry().template;
        const save = () => storage.set(STORE_KEY, JSON.stringify(state.store));
        const load = () => {
            let raw = null;
            try { raw = JSON.parse(storage.get(STORE_KEY) || 'null'); } catch (e) { raw = null; }
            if (!raw) { try { raw = JSON.parse(storage.get(LEGACY_STORE_KEY) || 'null'); } catch (e) { raw = null; } }
            state.store = migrateStore(raw);
            // La última selección de impresión y la hoja abierta se recuerdan entre sesiones.
            state.printOpts = state.store.printOpts;
            state.sheet = state.store.sheet;
        };
        const history = () => {
            const id = state.store.active[state.sheet];
            if (!histories.has(id)) histories.set(id, createHistory(60));
            return histories.get(id);
        };
        /** Guarda una instantánea antes de un cambio. `key` agrupa cambios seguidos (p. ej. escribir en un campo). */
        const commit = (key) => {
            const now = Date.now();
            if (key && key === lastCommit.key && now - lastCommit.at < 1500) { lastCommit.at = now; return; }
            lastCommit = { key: key || '', at: now };
            history().push(JSON.stringify(tpl()));
        };
        const restore = (snap) => { activeEntry().template = JSON.parse(snap); state.sel = null; state.pop = null; };

        const rebuildEngine = () => {
            fieldSet = SF.createFieldSet({ records: employees, getNetAmount: opts.getNetAmount });
            const own = CV.createFieldSet(state.store.variables, fieldSet, SB);
            fieldSet.fields.push(...own.fields);
            engine = SB.createEngine({ fields: fieldSet.fields, resolveField: fieldSet.resolveField, locale: opts.locale || 'en-US', decimals: 2 });
            palette = [];
            const byKey = new Map(fieldSet.fields.map((f) => [f.key, f]));
            for (const c of own.listVariables()) palette.push({ group: 'Variables propias', label: c.label, chip: F(c.key) });
            for (const c of fieldSet.listConcepts()) palette.push({ group: 'Conceptos importados', label: c.label, chip: F(c.key) });
            for (const [group, keys] of GROUPS) for (const k of keys) if (byKey.has(k)) palette.push({ group, label: byKey.get(k).label, chip: F(k) });
            for (const t of TOOLS) palette.push({ group: 'Herramientas', label: t.label, chip: t.chip });
            palette.forEach((p) => { p.sig = JSON.stringify(p.chip); });
        };

        const fieldDef = (key) => { try { return engine.requireField(key); } catch (e) { return null; } };

        /** Mayor letra base con la que cada tarjeta (los empleados con más filas) cabe en su tamaño. */
        const autoFitFont = () => {
            const t = tpl();
            const lay = SB.computeLayout(t.layout);
            const probe = document.createElement('div');
            probe.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;';
            rootEl.appendChild(probe);
            const samples = sorted(employees, t.sortBy)
                .map(({ record, ctx }) => engine.evaluateRows(t.rows, record, ctx))
                .sort((a, b) => b.filter((r) => !r.hidden).length - a.filter((r) => !r.hidden).length)
                .slice(0, 8);
            const pt = fitFontSize((size) => samples.every((rows) => cardFits(rows, size, probe)), { max: 14, min: 5, step: 0.25 });
            probe.remove();
            return pt;
        };
        /** ¿Cabe esta tarjeta a tamaño real? Se mide igual que se imprime. */
        const cardFits = (rows, pt, host) => {
            const t = tpl();
            const lay = SB.computeLayout(t.layout);
            const own = !host;
            const probe = host || document.createElement('div');
            if (own) { probe.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;'; rootEl.appendChild(probe); }
            probe.innerHTML = `<div class="ss-card" style="${cardStyle(lay.cardWidth, lay.cardHeight, PRINT_K, pt)}">${cardInner(rows, t.columns, PRINT_K, pt)}</div>`;
            const card = probe.firstElementChild;
            const ok = card.scrollHeight <= card.clientHeight + 1;
            if (own) probe.remove();
            return ok;
        };

        // ─── Guía de primera vez ───────────────────────────────────────────
        const TOUR = [
            { at: '#ssPalette', title: '1 · Arrastra un dato', text: 'Arrastra un campo, por ejemplo “Bonificaciones”, sobre la tarjeta: se crea la fila con su nombre, su monto y el signo según su color.' },
            { at: '#ssCanvas .ss-paper', title: '2 · Revisa con datos reales', text: 'La tarjeta muestra un empleado de verdad. Cámbialo con ‹ ›, usa “Ver fórmulas” para ver los chips y haz clic en una celda para editarla.' },
            { at: '[data-act="print-step"]', title: '3 · Imprime', text: 'En “Imprimir…” eliges a quién, compruebas que cada sobre cuadre con SplitX y ajustas tamaños arrastrando en la vista previa.' }
        ];
        const renderTour = () => {
            const host = $('#ssTour');
            rootEl.querySelectorAll('.ss-tour-focus').forEach((x) => x.classList.remove('ss-tour-focus'));
            if (!host) return;
            const step = state.tour != null && !state.printing ? TOUR[state.tour] : null;
            const anchor = step && $(step.at);
            if (!anchor) { host.innerHTML = ''; return; }
            anchor.classList.add('ss-tour-focus');
            const last = state.tour === TOUR.length - 1;
            host.innerHTML = `<div class="ss-tour" role="dialog" aria-label="Guía rápida"><strong>${esc(step.title)}</strong><p>${esc(step.text)}</p>
                <div class="ss-row-btns"><span class="ss-kbd">${state.tour + 1} de ${TOUR.length}</span><div class="ss-grow"></div>
                <button class="ss-btn sm ghost" type="button" data-act="tour-end">Saltar</button>
                <button class="ss-btn sm primary" type="button" data-act="${last ? 'tour-end' : 'tour-next'}">${last ? 'Listo' : 'Siguiente →'}</button></div></div>`;
            const box = host.firstElementChild;
            const a = anchor.getBoundingClientRect();
            const bw = box.offsetWidth; const bh = box.offsetHeight;
            const vw = window.innerWidth; const vh = window.innerHeight;
            let left = a.right + 12; let top = a.top + 12;
            if (left + bw > vw - 8) { left = Math.max(8, Math.min(a.left, vw - bw - 8)); top = a.bottom + 10; }
            if (top + bh > vh - 8) top = Math.max(8, a.top - bh - 10);
            box.style.left = `${left}px`;
            box.style.top = `${top}px`;
        };

        // ─── Verificaciones de dinero ──────────────────────────────────────
        const netOf = (r) => (opts.getNetAmount ? opts.getNetAmount(r) : r.amount);
        const uniqueById = (list) => list.filter((e, i) => list.findIndex((x) => x.id === e.id) === i);
        const TOTAL_LABEL = { bonuses: 'Bonificaciones', discounts: 'Descuentos', loans: 'Préstamo/Adelanto' };
        const fmt = (n) => engine.formatNumber(n, 2);
        const moneyChecks = (list) => {
            const t = tpl();
            const out = { totals: null, bad: [], double: doubleCounted(t), drift: null };
            if (state.sheet === 'A') {
                out.totals = cardTotals(engine, t, sorted(uniqueById(list || employees), t.sortBy), netOf);
                out.bad = out.totals ? out.totals.filter((x) => !x.ok) : [];
            }
            const snap = state.store.printed[state.sheet];
            if (snap) {
                try {
                    const d = snapshotDiff(snap.sigs, printSignatures(engine, snap.template, sorted(employees, snap.template.sortBy), (e) => e.id));
                    if (d.changed.length || d.missing.length) out.drift = Object.assign({ at: snap.at }, d);
                } catch (e) { out.drift = null; }
            }
            out.warnings = out.bad.length + out.double.length + (out.drift ? 1 : 0);
            return out;
        };
        const names = (list) => (list.length > 4 ? `${list.slice(0, 4).map(esc).join(', ')} y ${list.length - 4} más` : list.map(esc).join(', '));
        const checksHTML = (c) => {
            let html = '';
            if (c.drift) {
                const when = new Date(c.drift.at);
                html += `<div class="ss-alert warn"><strong>Lo impreso el ${esc(when.toLocaleDateString())} a las ${esc(when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))} ya no coincide.</strong>
                  ${c.drift.changed.length ? `<div>Cambió: ${names(c.drift.changed)}</div>` : ''}${c.drift.missing.length ? `<div>Ya no está: ${names(c.drift.missing)}</div>` : ''}
                  <div class="ss-row-btns"><button class="ss-btn sm" type="button" data-act="drift-ok">Entendido</button></div></div>`;
            }
            for (const d of c.double) {
                const concepts = d.concepts.map((k) => (fieldDef(k) || { label: k }).label);
                html += `<div class="ss-alert warn"><strong>${esc(TOTAL_LABEL[d.total])} ya incluye ${names(concepts)}.</strong> Ese dinero se cuenta dos veces.
                  ${state.sheet === 'A' ? `<div class="ss-row-btns"><button class="ss-btn sm" type="button" data-act="breakdown" data-v="${d.total}">Desglosar ${esc(TOTAL_LABEL[d.total])} por concepto</button></div>` : ''}</div>`;
            }
            if (state.sheet === 'A') {
                if (!c.totals) html += '<p class="ss-hint">La tarjeta no tiene “Total hasta ahora”, así que no se puede comparar con SplitX.</p>';
                else if (!c.bad.length) html += `<div class="ss-alert ok">✓ ${c.totals.length === 1 ? 'La tarjeta cuadra' : `Las ${c.totals.length} tarjetas cuadran`} con el monto que SplitX pone en el sobre.</div>`;
                else {
                    html += `<div class="ss-alert err"><strong>${c.bad.length} tarjeta${c.bad.length === 1 ? ' no cuadra' : 's no cuadran'} con SplitX:</strong>
                      <ul>${c.bad.slice(0, 6).map((x) => `<li>${esc(x.record.employeeName || x.record.name)} — tarjeta ${esc(fmt(x.card))} · SplitX ${esc(fmt(x.net))}</li>`).join('')}</ul>
                      ${c.bad.length > 6 ? `<div>y ${c.bad.length - 6} más</div>` : ''}</div>`;
                }
            }
            return html;
        };
        const chipClass = (chip) => (chip.kind === 'field' ? 'k-' + catOf(chip.key)
            : { op: 'k-op', paren: 'k-op', text: 'k-text', number: 'k-number', running: 'k-running' }[chip.kind]);
        const chipLabel = (chip) => {
            switch (chip.kind) {
                case 'field': { const fd = fieldDef(chip.key); return fd ? fd.label : chip.key; }
                case 'text': return chip.value === '' ? '“ ”' : chip.value;
                case 'number': return chip.percent ? `${chip.value}%` : String(chip.value);
                case 'op': return OPS[chip.op];
                case 'paren': return chip.paren;
                case 'running': return 'Σ Total hasta ahora';
            }
            return '?';
        };
        const chipHTML = (chip, zone, i) => {
            const bad = chip.kind === 'field' && !fieldDef(chip.key);
            const isSel = state.sel && state.sel.zone === zone && state.sel.ci === i;
            const as = chip.kind === 'field' && chip.as === 'label' ? '<span class="as">NOMBRE</span>' : '';
            return `<span class="ss-chip ${chipClass(chip)}${isSel ? ' is-sel' : ''}${bad ? ' bad' : ''}" draggable="true" tabindex="0" role="button" data-ci="${i}" data-czone="${zone}">${as}${esc(chipLabel(chip))}</span>`;
        };

        // Zonas: "A:r:c" (celda de tarjeta) | "B:col:i" | "B:title:i"
        const cellOf = (zone) => {
            const t = tpl();
            const [s, a, b] = zone.split(':');
            if (s === 'A') return t.rows && t.rows[+a] && t.rows[+a].cells[+b];
            if (a === 'col') return t.columns && t.columns[+b] && t.columns[+b].cell;
            return t.title && t.title[+b];
        };
        const selCell = () => (state.sel && state.sel.zone ? cellOf(state.sel.zone) : null);
        const selChip = () => { const c = selCell(); return c && state.sel.ci != null ? c.chips[state.sel.ci] : null; };
        const select = (zone, ci) => { state.sel = { zone, ci: ci ?? null }; };
        const zoneIndex = (zone, n) => +zone.split(':')[n];
        const sorted = (list, sortBy) => { try { return engine.sortRecords(list, sortBy); } catch (e) { return engine.sortRecords(list, undefined); } };

        // ─── Papel ─────────────────────────────────────────────────────────
        const cellCat = (cell) => { const f = cell.chips.find((c) => c.kind === 'field' && c.as !== 'label'); return f ? catOf(f.key) : null; };
        // base: letra base de la tarjeta (pt); las celdas con tamaño propio escalan con ella.
        const outHTML = (res, cell, k, base) => {
            const cat = cellCat(cell);
            const align = cell.align || (cell.mode === 'number' ? 'right' : 'left');
            const style = `text-align:${align};font-weight:${cell.bold ? 700 : 400};${cell.size ? `font-size:${(base ? cellFontPt(cell, base) : cell.size) * PT_MM * k}px;` : ''}`;
            if (res.error) return `<span class="ss-out err" title="${esc(res.error)}" style="${style}">—</span>`;
            const cls = ['ss-out', cell.mode === 'number' ? 'n' : '', cat && cat !== 'field' ? 'c-' + cat : ''].join(' ');
            return `<span class="${cls}" style="${style}">${esc(res.text)}</span>`;
        };
        const gridCols = (cols) => cols.map((w) => `${w}fr`).join(' ');
        const cardInner = (rowResults, cols, k, base) => rowResults.filter((r) => !r.hidden).map((r) =>
            `<div class="ss-crow${r.row.lineAbove ? ' line' : ''}" style="grid-template-columns:${gridCols(cols)}">${r.cells.map((c) => outHTML(c, c.cell, k, base)).join('')}</div>`).join('');
        const cardStyle = (w, h, k, base) => `width:${w * k}px;height:${h * k}px;padding:${2.5 * k}px ${3 * k}px;font-size:${base * PT_MM * k}px;gap:${0.6 * k}px;`;

        /** Asas entre columnas de la tarjeta, sobre un contenedor del ancho del contenido. */
        const colGrips = (cols) => {
            const sumW = cols.reduce((a, b) => a + b, 0);
            let acc = 0;
            return cols.slice(0, -1).map((w, i) => {
                acc += w;
                return `<span class="ss-rz v" data-resize="ccol:${i}" style="left:${(acc / sumW) * 100}%" title="Arrastra para cambiar el ancho de la columna"></span>`;
            }).join('');
        };
        /** Regla sobre la tarjeta del editor: muestra las columnas y deja cambiar su ancho. */
        const rulerHTML = (cols, k) => (cols.length > 1
            ? `<div class="ss-ruler ss-rzhost" style="left:${3 * k}px;right:${3 * k}px">${cols.map((w) => `<span style="flex:${w}">${Math.round((w / cols.reduce((a, b) => a + b, 0)) * 100)}%</span>`).join('')}${colGrips(cols)}</div>`
            : '');
        /** Asas sobre la primera tarjeta de la vista previa: columnas y esquina para el tamaño. */
        const cardGrips = (k) => `<div class="ss-grips"><div class="ss-rzhost" style="position:absolute;top:0;bottom:0;left:${3 * k}px;right:${3 * k}px">${colGrips(tpl().columns)}</div>
            <span class="ss-rz corner" data-resize="card" title="Arrastra para cambiar el tamaño de la tarjeta"></span></div>`;

        const tableHTML = (t, items, k, withTotals, total, page) => {
            const sumW = t.columns.reduce((s, c) => s + (c.width || 1), 0);
            const o = tableOptions(t.options);
            const rowH = o.rowHeight * k;
            const cells = t.columns.map((c) => c.cell);
            // En la vista previa, la primera página trae asas para cambiar el ancho de las columnas.
            const grip = (i) => (page === 0 && i < t.columns.length - 1 ? `<span class="ss-rz" data-resize="tcol:${i}" title="Arrastra para cambiar el ancho"></span>` : '');
            const head = `<thead><tr>${t.columns.map((c, i) => `<th class="${c.border === 'none' ? 'b-none' : 'b-all'}" style="text-align:${c.cell.align || (c.cell.mode === 'number' ? 'right' : 'left')}">${esc(c.header)}${grip(i)}</th>`).join('')}</tr></thead>`;
            const body = items.map(({ record, ctx }) => {
                const res = engine.evaluateRows([{ cells }], record, ctx)[0].cells;
                return `<tr style="height:${rowH}px">${t.columns.map((c, i) => (c.border === 'sign'
                    ? `<td class="b-sign sl-${o.signLine}">${c.cell.chips.length ? outHTML(res[i], c.cell, k) : ''}<div class="sline"></div></td>`
                    : `<td class="${c.border === 'none' ? 'b-none' : 'b-all'}">${outHTML(res[i], c.cell, k)}</td>`)).join('')}</tr>`;
            }).join('');
            let foot = '';
            if (withTotals) {
                const sums = columnTotals(engine, t, withTotals);
                const firstSum = sums.findIndex((x) => x !== null);
                const span = firstSum > 0 ? firstSum : 1;
                foot = `<tr style="font-weight:700;background:#f8fafc">${t.columns.map((c, i) => {
                    if (i > 0 && i < span) return '';
                    if (sums[i] !== null) {
                        const single = c.cell.chips.length === 1 && c.cell.chips[0].kind === 'field' ? fieldDef(c.cell.chips[0].key) : null;
                        return `<td class="b-all ss-out n" style="text-align:right">${esc(engine.formatNumber(sums[i], single ? single.decimals : undefined))}</td>`;
                    }
                    if (i === 0) return `<td class="b-all" colspan="${span}">Totales (${total})</td>`;
                    return `<td class="${c.border === 'sign' ? 'b-none' : 'b-all'}"></td>`;
                }).join('')}</tr>`;
            }
            return `<table class="ss-sig${state.store.colors ? '' : ' mono-ink'}"><colgroup>${t.columns.map((c) => `<col style="width:${((c.width || 1) / sumW) * 100}%">`).join('')}</colgroup>${head}<tbody>${body}${foot}</tbody></table>`;
        };

        /** Lista final a imprimir (selección + copias). */
        const printList = () => selectEmployees(employees, state.sheet === 'A' ? state.printOpts : Object.assign({}, state.printOpts, { copies: 1 }));

        /** Páginas de la hoja actual a escala k (px por mm). */
        const pagesHTML = (k, forPrint) => {
            const list = printList();
            if (state.sheet === 'A') {
                const out = engine.renderCards(tpl(), list);
                const lay = out.layout;
                return out.pages.map((cards, p) => `
                    <div class="ss-page" style="width:${lay.pageWidth * k}px;height:${lay.pageHeight * k}px;padding:${lay.margin * k}px">
                      <div class="ss-cards" style="grid-template-columns:repeat(${lay.cols}, ${lay.cardWidth * k}px);grid-auto-rows:${lay.cardHeight * k}px;gap:${lay.gap * k}px">
                        ${cards.map((rows, i) => `<div class="ss-card${tpl().layout.cutMarks ? ' cut' : ''}${state.store.colors ? '' : ' mono-ink'}" style="${cardStyle(lay.cardWidth, lay.cardHeight, k, cardFontPt(tpl()))}">${cardInner(rows, tpl().columns, k, cardFontPt(tpl()))}${!forPrint && p === 0 && i === 0 ? cardGrips(k) : ''}</div>`).join('')}
                      </div></div>${forPrint ? '' : `<div class="ss-page-no">Hoja ${p + 1} de ${out.pages.length}</div>`}`).join('');
            }
            const t = tpl();
            const g = tablePageGeometry(t, !!state.store.logo);
            const o = tableOptions(t.options);
            const items = sorted(list, t.sortBy);
            let from = 0;
            const pages = tablePageSizes(t, !!state.store.logo, items.length).map((n) => { const rows = items.slice(from, from + n); from += n; return rows; });
            const first = items[0];
            const titleRes = first ? engine.evaluateRows(t.title.map((c) => ({ cells: [c] })), first.record, first.ctx) : [];
            return pages.map((rows, p) => `
                <div class="ss-page" style="width:${g.pageWidth * k}px;height:${g.pageHeight * k}px;padding:${g.margin * k}px;display:flex;flex-direction:column;font-size:${9 * PT_MM * k}px">
                  <div class="ss-sig-head">
                    ${state.store.logo ? `<img src="${state.store.logo}" alt="Logo" style="width:${18 * k}px;height:${18 * k}px;filter:${logoFilter(o.logoStyle)}">` : ''}
                    <div style="flex:1;display:flex;flex-direction:column;gap:${0.6 * k}px">${titleRes.map((r) => `<div style="display:grid">${outHTML(r.cells[0], r.cells[0].cell, k)}</div>`).join('')}</div>
                    <div style="color:#64748b;text-align:right">Hoja ${p + 1} de ${pages.length}</div>
                  </div>
                  ${tableHTML(t, rows, k, o.totals && p === pages.length - 1 ? items : null, items.length, forPrint ? null : p)}
                  ${footerOnPage(o.signatures, p, pages.length) && o.signLabels.length ? `<div class="ss-sig-foot" style="padding-top:${10 * k}px">${o.signLabels.map((l) => `<div>${esc(l)}</div>`).join('')}</div>` : ''}
                </div>${forPrint ? '' : `<div class="ss-page-no">Hoja ${p + 1} de ${pages.length}</div>`}`).join('');
        };

        // ─── Estructura ────────────────────────────────────────────────────
        const segHTML = (bind, value, options) => `<div class="ss-seg sm" role="group">${options.map(([v, l]) =>
            `<button type="button" data-set="${bind}" data-v="${esc(JSON.stringify(v))}" aria-pressed="${JSON.stringify(value) === JSON.stringify(v)}">${esc(l)}</button>`).join('')}</div>`;
        const selectHTML = (id, bind, value, list) => `<select id="${id}" class="ss-inp" data-bind="${bind}">${list.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

        const renderShell = () => {
            rootEl.innerHTML = `
              <header class="ss-bar" id="ssBar"></header>
              ${state.printing ? '<div class="ss-printstep" id="ssPrint"></div>' : `
              <div class="ss-pagebar" id="ssPageBar"></div>
              <div class="ss-body">
                <aside class="ss-col ss-palette" id="ssPalette" aria-label="Chips"></aside>
                <main class="ss-col" id="ssCanvasCol"><div class="ss-canvas" id="ssCanvas"></div></main>
                <aside class="ss-col ss-inspector" id="ssInspector" aria-label="Propiedades"></aside>
              </div>`}
              <div id="ssLayer"></div><div id="ssDrawer"></div><div id="ssToast"></div><div id="ssTour"></div>
              <div class="ss-trash" aria-hidden="true">Suelta para quitar el chip</div>`;
            renderBar();
            if (state.printing) renderPrintStep();
            else { renderPageBar(); renderPalette(); renderCanvas(); renderInspector(); }
            renderLayer();
            renderTour();
        };

        const renderBar = () => {
            const el = $('#ssBar');
            if (!el) return;
            const h = history();
            el.innerHTML = state.printing
                ? `<button class="ss-btn" type="button" data-act="print-back">← Editar plantilla</button>
                   <span class="ss-title">Imprimir · ${esc(activeEntry().name)}</span><div class="ss-grow"></div>
                   <button class="ss-btn ghost" type="button" data-act="close">Cerrar ✕</button>`
                : `<span class="ss-title">Hojas imprimibles</span>
                   <div class="ss-seg" role="group" aria-label="Tipo de hoja">
                     <button type="button" data-act="sheet" data-v="A" aria-pressed="${state.sheet === 'A'}">Tarjeta del sobre</button>
                     <button type="button" data-act="sheet" data-v="B" aria-pressed="${state.sheet === 'B'}">Hoja de firmas</button>
                     <button type="button" data-act="documents" aria-label="Documentos personalizados">Documentos</button>
                   </div>
                   ${state.sheet === 'B' ? '<button class="ss-btn sm" id="ssVarsBarBtn" type="button" data-act="vars-open" title="Crear y editar fórmulas visuales para las columnas de firmas">ƒx Variables</button>' : ''}
                   <button class="ss-btn ss-tplbtn" type="button" data-pop="tpl" id="ssTplBtn" title="Plantillas guardadas">📄 ${esc(activeEntry().name)} ▾</button>
                   <div class="ss-grow"></div>
                   <button class="ss-btn ghost" type="button" data-act="undo" ${h.canUndo() ? '' : 'disabled'} title="Deshacer (Ctrl+Z)">↶ Deshacer</button>
                   <button class="ss-btn ghost" type="button" data-act="redo" ${h.canRedo() ? '' : 'disabled'} title="Rehacer (Ctrl+Y)">↷ Rehacer</button>
                   <button class="ss-btn ghost" type="button" data-act="tour" title="Guía rápida" aria-label="Guía rápida">?</button>
                   <button class="ss-btn primary" type="button" data-act="print-step">Imprimir…</button>
                   <button class="ss-btn ghost" type="button" data-act="close" aria-label="Cerrar hojas imprimibles">Cerrar ✕</button>`;
        };

        const renderPageBar = () => {
            const el = $('#ssPageBar');
            if (!el) return;
            el.innerHTML = `<span>Hoja:</span><button class="ss-btn sm" type="button" data-pop="page" id="ssPageBtn">${esc(pageSummary(tpl()))} ▾</button>
              <label class="ss-check" style="font-size:12px"><input id="ssColors" type="checkbox" data-bind="colors" ${state.store.colors ? 'checked' : ''}> Montos a color</label>
              ${(() => { const c = moneyChecks(); return employees.length ? `<button class="ss-btn sm ss-status ${c.warnings ? 'warn' : 'ok'}" type="button" data-pop="checks" id="ssChecksBtn">${c.warnings ? `⚠ ${c.warnings} aviso${c.warnings === 1 ? '' : 's'}` : state.sheet === 'A' && c.totals ? '✓ Cuadra con SplitX' : '✓ Sin avisos'}</button>` : ''; })()}
              <div class="ss-grow"></div><span class="ss-kbd">Ctrl+Z deshacer · Supr quita el chip seleccionado · Esc cierra</span>`;
        };

        const renderPalette = () => {
            const el = $('#ssPalette');
            if (!el) return;
            const q = state.query;
            const groups = [];
            const add = (name, item, i) => {
                let g = groups.find((x) => x.name === name);
                if (!g) groups.push((g = { name, items: [] }));
                g.items.push(`<span class="ss-chip ${chipClass(item.chip)}" draggable="true" tabindex="0" role="button" data-pi="${i}" title="Arrástralo a la tarjeta o tócalo para agregarlo a la celda seleccionada">${esc(item.label)}</span>`);
            };
            if (!q) state.store.recent.forEach((sig) => { const i = palette.findIndex((p) => p.sig === sig); if (i >= 0) add('Usados recientemente', palette[i], i); });
            palette.forEach((p, i) => { if (paletteMatches(p.label, q)) add(p.group, p, i); });
            el.innerHTML = `<button type="button" class="ss-btn primary" id="ssVarsBtn" data-act="vars-open" style="width:100%">+ Variables propias (${state.store.variables.length})</button><div class="ss-search"><input id="ssSearch" class="ss-inp" type="search" placeholder="Buscar chip…" value="${esc(q)}" data-bind="query" aria-label="Buscar chip"></div>
              ${groups.length ? groups.map((g) => `<details class="ss-group" data-group="${esc(g.name)}" ${q || state.open[g.name] ? 'open' : ''}>
                <summary>${esc(g.name)} <span class="count">${g.items.length}</span></summary><div class="ss-chips">${g.items.join('')}</div></details>`).join('')
                : '<p class="ss-hint">Ningún chip coincide.</p>'}
              <p class="ss-hint" style="margin-top:auto">Suelta un campo <strong>sobre la tarjeta</strong> para crear su fila completa, o <strong>dentro de una celda</strong> para armar una fórmula.</p>`;
        };


        // Las variables son locales a la impresión; jamás se escriben en la nómina original.
        const employeeVarId = (e) => e.employeeNumber != null ? String(e.employeeNumber) : e.id != null ? 'id:' + e.id : null;
        const renderVariablesDialog = () => {
            let host = $('#ssVarsDialog');
            if (!host) {
                host = document.createElement('div');
                host.id = 'ssVarsDialog';
                rootEl.appendChild(host);
            }
            const current = state.store.variables.find(v => v.id === state.variableEdit);
            const options = employees.filter(e => employeeVarId(e)).map(e =>
                `<option value="${esc(employeeVarId(e))}">${esc(e.employeeNumber || e.name)} · ${esc(e.name)}</option>`).join('');
            host.innerHTML = `<div style="position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.62);display:flex;justify-content:center;align-items:center;padding:16px">
              <section role="dialog" aria-modal="true" aria-label="Variables personalizadas" style="background:var(--surface,#fff);color:var(--text,#1e293b);width:min(620px,100%);max-height:92vh;overflow:auto;border-radius:15px;border:1px solid var(--border,#ddd);padding:18px;box-shadow:0 12px 36px #0003">
                <div class="ss-row-btns"><h2 style="font-size:18px;margin:0">Variables propias para impresión</h2><div class="ss-grow"></div><button class="ss-btn" data-act="vars-close" type="button">Cerrar ✕</button></div>
                <p class="ss-hint">Úsalas en sobres y hojas de firmas. No modifican los importes originales de SA. Puedes combinarlas con campos importados en fórmulas.</p>
                <div id="ssVarsList" style="display:flex;flex-direction:column;gap:5px;margin:12px 0;max-height:180px;overflow:auto">
                  ${state.store.variables.length ? state.store.variables.map(v =>
                    `<div class="ss-row-btns" style="justify-content:space-between;align-items:center;border-bottom:1px solid var(--border,#ddd);padding:5px 0">
                      <span><strong>${esc(v.label)}</strong> <small>(${esc(v.id)}) · ${v.kind === 'formula' ? 'Cálculo' : 'Valor fijo'}${Object.keys(v.overrides || {}).length ? ' · ' + Object.keys(v.overrides).length + ' excepciones' : ''}</small></span>
                      <span><button class="ss-btn sm" data-act="vars-edit" data-v="${esc(v.id)}" type="button">Editar</button>
                      <button class="ss-btn sm ${state.variableDeleteConfirm === v.id ? 'danger' : ''}" data-act="vars-delete" data-v="${esc(v.id)}" type="button">${state.variableDeleteConfirm === v.id ? 'Confirmar' : 'Eliminar'}</button></span>
                    </div>`).join('') : '<p class="ss-hint">Todavía no hay variables creadas.</p>'}
                </div>
                <h3 style="margin:12px 0 8px;font-size:14px">${current ? 'Editar variable' : 'Crear variable'}</h3>
                <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px">
                  <label>ID<input id="ssVarId" class="ss-inp" placeholder="transporte" maxlength="32" value="${esc(current?.id || '')}" ${current ? 'readonly' : ''}></label>
                  <label>Nombre<input id="ssVarLabel" class="ss-inp" maxlength="60" placeholder="Transporte" value="${esc(current?.label || '')}"></label>
                  <label>Tipo<select id="ssVarKind" class="ss-inp"><option value="fixed" ${current?.kind !== 'formula' ? 'selected' : ''}>Número</option><option value="formula" ${current?.kind === 'formula' ? 'selected' : ''}>Fórmula</option></select></label>
                  <label>Valor general<input id="ssVarValue" type="number" step="any" class="ss-inp" value="${current?.kind === 'fixed' ? esc(current.value) : '0'}"></label>
                </div>
                <label style="display:block;margin-top:8px">Fórmula (si seleccionas «Fórmula»)<input id="ssVarFormula" class="ss-inp" style="width:100%" maxlength="180" placeholder="gross * 5% + transporte" value="${esc(current?.formula || '')}"></label>
                <p class="ss-hint">Campos disponibles: gross (bruto), days (días), dailyRate (tarifa), bonuses y cualquier variable propia por su ID. Operadores: + − × ÷ ( ) y %.</p>
                <div style="display:grid;grid-template-columns:2fr 1fr;gap:8px">
                  <label>Empleado (excepción opcional)<select id="ssVarEmployee" class="ss-inp"><option value="">Valor general</option>${options}</select></label>
                  <label>Valor para ese empleado<input id="ssVarOverride" type="number" step="any" class="ss-inp" placeholder="Sin excepción"></label>
                </div>
                <p class="ss-hint">Las excepciones se aplican a variables de tipo Número y se asocian al número del empleado (o ID local si no tiene número).</p>
                <p id="ssVarsMsg" role="alert" style="color:#b91c1c;font-size:12px;min-height:18px;margin:8px 0"></p>
                <div class="ss-row-btns" style="justify-content:flex-end">
                  ${current ? '<button class="ss-btn" data-act="vars-new" type="button">Nueva variable</button>' : ''}
                  <button class="ss-btn primary" data-act="vars-save" type="button">${current ? 'Guardar cambios' : 'Crear variable'}</button>
                </div>
              </section></div>`;
            formulaBuilder = FB.mount({
                host, fields: fieldSet.fields, variables: state.store.variables,
                employees, existing: current, seed: variableSeedChips,
                savePreview: {
                    resolveField: fieldSet.resolveField,
                    createFieldSet: (defs) => CV.createFieldSet(defs,
                        SF.createFieldSet({ records: employees, getNetAmount: opts.getNetAmount }), SB)
                }
            });
            variableSeedChips = null;
        };
        const closeVariablesDialog = () => { $('#ssVarsDialog')?.remove(); formulaBuilder=null; variableSeedChips=null; state.variableEdit = null; state.variableDeleteConfirm = null; };
        const variableError = message => { const el = $('#ssVarsMsg'); if (el) el.textContent = message; };
        const saveVariable = () => {
            try {
                const enteredId = $('#ssVarId').value.trim();
                const label = $('#ssVarLabel').value.trim();
                const suggested = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0,32);
                const id = enteredId || (suggested.match(/^[a-z]/) ? suggested : 'variable_' + suggested).slice(0,32);
                const kind = $('#ssVarKind').value;
                const original = state.store.variables.find(v => v.id === id);
                const next = { id, label: $('#ssVarLabel').value.trim(), kind };
                if (kind === 'fixed') {
                    const raw = $('#ssVarValue').value;
                    if (!raw.trim()) throw new Error('Indica un valor numérico.');
                    next.value = Number(raw);
                    next.overrides = { ...(original?.kind === 'fixed' ? original.overrides : {}) };
                    const employee = $('#ssVarEmployee').value;
                    const override = $('#ssVarOverride').value.trim();
                    if (employee) {
                        if (!override) delete next.overrides[employee];
                        else next.overrides[employee] = Number(override);
                    }
                } else next.formula = formulaBuilder ? formulaBuilder.getFormula() : $('#ssVarFormula').value.trim();
                const old = state.store.variables;
                if (old.some(v => v.id === id) && state.variableEdit !== id)
                    throw new Error('Ya existe una variable con ese ID.');
                const defs = original ? old.map(v => v.id === id ? next : v) : [...old, next];
                CV.validateDefinitions(defs, SF.createFieldSet({ records: employees, getNetAmount: opts.getNetAmount }));
                state.store.variables = defs;
                state.store.ready = { A: false, B: false };
                save(); rebuildEngine(); closeVariablesDialog(); touch(); toast('Variable guardada para imprimir', true);
            } catch (err) { variableError(err.message); }
        };

        const empNav = () => {
            if (!employees.length) return '';
            const opts2 = employees.map((e, i) => `<option value="${i}" ${i === state.preview ? 'selected' : ''}>${esc(e.employeeNumber || i + 1)} · ${esc(e.employeeName || e.name)}</option>`).join('');
            return `<div class="ss-emp"><button class="ss-btn sm" type="button" data-act="emp" data-v="-1" aria-label="Empleado anterior">‹</button>
              <select id="ssEmp" class="ss-inp" data-bind="preview" aria-label="Empleado de muestra">${opts2}</select>
              <button class="ss-btn sm" type="button" data-act="emp" data-v="1" aria-label="Empleado siguiente">›</button></div>`;
        };

        const cellHTML = (zone, cell, res, k) => {
            const isSel = state.sel && state.sel.zone === zone;
            const inTable = zone.startsWith('B:col');
            // En la tabla las celdas son angostas: sus chips se editan en el panel derecho.
            const showChips = state.formulas || (isSel && !inTable);
            const empty = inTable && !state.formulas ? '&nbsp;' : '<span class="empty">vacía</span>';
            const inner = showChips
                ? (cell.chips.map((c, i) => chipHTML(c, zone, i)).join('') || '<span class="empty">vacía</span>')
                : (cell.chips.length ? outHTML(res, cell, k, zone.startsWith('A:') ? cardFontPt(tpl()) : undefined) : empty);
            // En la vista de fórmulas los chips siguen la alineación de la celda, como el resultado impreso.
            const align = cell.align || (cell.mode === 'number' ? 'right' : 'left');
            const justify = showChips ? `justify-content:${{ left: 'flex-start', center: 'center', right: 'flex-end' }[align]}` : '';
            return `<div class="ss-cell${isSel && state.sel.ci == null ? ' sel' : ''}${showChips ? ' chipview' : ''}" data-zone="${zone}" tabindex="0" role="button" aria-label="Celda" style="${justify}">${inner}</div>`;
        };

        /** Miniatura de la primera hoja en la esquina del lienzo: un clic lleva a Imprimir. */
        const renderThumb = () => {
            const el = $('#ssCanvas');
            if (!el || !employees.length) return;
            const L = tpl().layout;
            const [w, h] = SB.PAPER_SIZES[L.paper] || SB.PAPER_SIZES.letter;
            const [pw, ph] = L.orientation === 'landscape' ? [h, w] : [w, h];
            // Se dibuja a buen tamaño y se reduce con transform: el navegador no achica bien letras diminutas.
            const k = PRINT_K;
            const scale = 150 / (pw * k);
            const box = document.createElement('div');
            box.innerHTML = pagesHTML(k, true);
            const pages = box.querySelectorAll('.ss-page');
            pages.forEach((pg, i) => { if (i) pg.remove(); });
            const thumb = document.createElement('button');
            thumb.type = 'button';
            thumb.className = 'ss-thumb';
            thumb.dataset.act = 'print-step';
            thumb.title = 'Ver la hoja completa e imprimir';
            thumb.innerHTML = `<div class="ss-thumb-page" style="width:${pw * k * scale}px;height:${ph * k * scale}px"><div style="transform:scale(${scale});transform-origin:0 0">${box.innerHTML}</div></div><span>Hoja 1 de ${pages.length} · ${esc(pageSummary(tpl()).split(' · ').slice(-1)[0])}</span>`;
            el.appendChild(thumb);
        };
        const renderCanvas = () => {
            renderCanvasBody();
            renderThumb();
        };
        const renderCanvasBody = () => {
            const el = $('#ssCanvas');
            if (!el) return;
            const tools = `<div class="ss-tools">
                ${segHTML('formulas', state.formulas, [[false, 'Ver datos'], [true, 'Ver fórmulas']])}
                ${empNav()}<div class="ss-grow"></div>
                <span class="ss-hint" id="ssCanvasInfo"></span></div>`;
            if (!employees.length) { el.innerHTML = tools + '<p class="ss-hint">No hay empleados. Agrega o importa empleados en SplitX.</p>'; return; }
            state.preview = Math.min(state.preview, employees.length - 1);
            const rec = employees[state.preview];
            const ctx = { index: state.preview };
            const avail = Math.max(320, (($('#ssCanvasCol') || el).clientWidth || 700) - 140);
            if (state.sheet === 'A') {
                const t = tpl();
                const lay = SB.computeLayout(t.layout);
                const k = Math.min(4.2, avail / lay.cardWidth);
                const res = engine.evaluateRows(t.rows, rec, ctx);
                const rowSel = state.sel && state.sel.zone.startsWith('A:') ? zoneIndex(state.sel.zone, 1) : -1;
                const rows = t.rows.map((row, r) => `
                    <div class="ss-insert" data-insert="${r}" style="height:${r ? 0.6 * k : 0}px"></div>
                    <div class="ss-erow${row.lineAbove ? ' line' : ''}${r % 2 ? ' alt' : ''}${res[r].hidden && !state.formulas ? ' ghost' : ''}${rowSel === r ? ' row-sel' : ''}" data-row="${r}" style="grid-template-columns:${gridCols(t.columns)}">
                      <span class="ss-handle" draggable="true" data-rowdrag="${r}" title="Arrastra para mover la fila" aria-hidden="true">⋮⋮</span>
                      ${row.cells.map((cell, c) => cellHTML(`A:${r}:${c}`, cell, res[r].cells[c], k)).join('')}
                      <button class="ss-rowmenu" type="button" data-pop="row" data-v="${r}" id="ssRowMenu${r}" aria-label="Opciones de la fila ${r + 1}">⋯</button>
                      ${res[r].hidden && !state.formulas ? '<span class="ss-ghost-tag">oculta para este empleado</span>' : ''}
                    </div>`).join('');
                el.innerHTML = `${tools}
                  <div class="ss-stage" data-stage="end">
                    <div class="ss-paper ss-cardedit${state.formulas ? ' formulas' : ''}${state.store.colors ? '' : ' mono-ink'}" id="ssCardEdit" style="width:${state.formulas ? Math.max(lay.cardWidth * k, Math.min(avail, 760)) : lay.cardWidth * k}px;min-height:${state.formulas ? 0 : lay.cardHeight * k}px;padding:${2.5 * k}px ${3 * k}px;font-size:${cardFontPt(t) * PT_MM * k}px">
                      ${rulerHTML(t.columns, k)}
                      ${rows}<div class="ss-insert" data-insert="${t.rows.length}" style="height:${0.6 * k}px"></div>
                      ${state.formulas ? '' : `<div class="ss-limit" style="top:${lay.cardHeight * k}px"><span>límite de la tarjeta</span></div>`}
                    </div>
                    <div class="ss-dropzone" data-insert="end">
                      <span>Suelta aquí un campo para agregar su fila “Concepto | Monto”</span>
                      <button class="ss-btn sm" type="button" data-act="add-row">+ Fila vacía</button>
                    </div>
                  </div><div id="ssCanvasWarn"></div>`;
                const info = $('#ssCanvasInfo');
                if (info) {
                    const one = cardTotals(engine, t, [{ record: rec, ctx }], netOf);
                    const check = !one ? '' : one[0].ok ? ' · ✓ cuadra con SplitX' : ` · ⚠ tarjeta ${fmt(one[0].card)} · SplitX ${fmt(one[0].net)}`;
                    info.textContent = `Tarjeta de ${Math.round(lay.cardWidth)} × ${Math.round(lay.cardHeight)} mm${check}`;
                    info.classList.toggle('ss-bad', !!one && !one[0].ok);
                }
                requestAnimationFrame(() => {
                    const card = $('#ssCardEdit'); const warn = $('#ssCanvasWarn');
                    const overflow = !!card && !cardFits(res, cardFontPt(t));
                    if (card && warn) warn.innerHTML = overflow ? '<p class="ss-warn">El contenido pasa del límite de la tarjeta. <button class="ss-btn sm" type="button" data-act="font-fit">Ajustar al tamaño</button> o agranda la tarjeta en la barra “Hoja”.</p>' : '';
                });
            } else {
                const t = tpl();
                const g = tablePageGeometry(t, !!state.store.logo);
                const k = Math.min(3, avail / g.pageWidth);
                const first = sorted(employees, t.sortBy);
                const titleRes = engine.evaluateRows(t.title.map((c) => ({ cells: [c] })), rec, ctx);
                const colSel = state.sel && state.sel.zone.startsWith('B:col') ? zoneIndex(state.sel.zone, 2) : -1;
                const titleSel = state.sel && state.sel.zone.startsWith('B:title') ? zoneIndex(state.sel.zone, 2) : -1;
                const titles = t.title.map((c, i) => `<div class="ss-tline${titleSel === i ? ' row-sel' : ''}">${cellHTML(`B:title:${i}`, c, titleRes[i].cells[0], k)}
                    <button class="ss-rowmenu" type="button" data-pop="title" data-v="${i}" id="ssTitleMenu${i}" aria-label="Opciones de la línea ${i + 1}">⋯</button></div>`).join('');
                const sumW = t.columns.reduce((s, c) => s + (c.width || 1), 0);
                const cells = t.columns.map((c) => c.cell);
                const grip = (i) => (i < t.columns.length - 1 ? `<span class="ss-rz" draggable="false" data-resize="tcol:${i}" title="Arrastra para cambiar el ancho"></span>` : '');
                const head = `<thead><tr>${t.columns.map((c, i) => `<th class="${c.border === 'none' ? 'b-none' : 'b-all'}${colSel === i ? ' col-sel' : ''}" draggable="true" data-coldrag="${i}" data-colpick="B:col:${i}" style="text-align:${c.cell.align || (c.cell.mode === 'number' ? 'right' : 'left')}" title="Clic para editar · arrastra para mover">${esc(c.header) || '<span style="opacity:.5">(sin título)</span>'}${grip(i)}</th>`).join('')}</tr></thead>`;
                const sample = state.formulas ? first.slice(0, 1) : first.slice(0, 5);
                const body = sample.map(({ record, ctx: cx }, ri) => {
                    const res = engine.evaluateRows([{ cells }], record, cx)[0].cells;
                    return `<tr style="height:${(t.options.rowHeight || 11) * k}px">${t.columns.map((c, i) => {
                        const cls = `${c.border === 'sign' ? `b-sign sl-${tableOptions(t.options).signLine}` : c.border === 'none' ? 'b-none' : 'b-all'}${colSel === i ? ' col-sel' : ''}`;
                        const zone = `B:col:${i}`;
                        const content = ri === 0 || state.formulas ? cellHTML(zone, c.cell, res[i], k) : `<div data-colpick="${zone}" style="cursor:pointer">${c.cell.chips.length ? outHTML(res[i], c.cell, k) : '&nbsp;'}</div>`;
                        return `<td class="${cls}">${content}${c.border === 'sign' ? '<div class="sline"></div>' : ''}</td>`;
                    }).join('')}</tr>`;
                }).join('');
                el.innerHTML = `${tools}
                  <div class="ss-stage">
                    <div class="ss-paper ss-sheetedit${state.formulas ? ' formulas' : ''}${state.store.colors ? '' : ' mono-ink'}" style="${state.formulas ? 'min-width' : 'width'}:${g.pageWidth * k}px;font-size:${9 * PT_MM * k}px">
                      <div class="ss-titles"><div class="ss-titlewrap">${state.store.logo ? `<img src="${state.store.logo}" alt="Logo" style="width:${18 * k}px;height:${18 * k}px;filter:${logoFilter(tableOptions(t.options).logoStyle)}">` : ''}<div>${titles}</div></div>
                        <div class="ss-dropzone" data-insert-title="end" style="margin-top:4px;padding:6px">Suelta un campo aquí para agregar una línea al encabezado <button class="ss-btn sm" type="button" data-act="add-title">+ Línea</button></div>
                      </div>
                      <div class="ss-sigedit"><table class="ss-sig"><colgroup>${t.columns.map((c) => `<col style="width:${((c.width || 1) / sumW) * 100}%">`).join('')}</colgroup>${head}<tbody>${body}</tbody></table>
                        <div class="ss-colstrip" data-insert-col="end">Suelta un campo: nueva columna</div></div>
                      <p class="ss-hint">Vista de ${sample.length} de ${employees.length} empleados. La hoja completa se ve al imprimir.</p>
                    </div>
                  </div>`;
                const info = $('#ssCanvasInfo');
                if (info) info.textContent = `${g.rowsPerPage} empleados por hoja`;
            }
        };

        const cardSection = () => `<div class="ss-sec"><h3 class="ss-lbl">Tarjeta</h3>
            <div class="ss-field">Columnas ${segHTML('card.cols', tpl().columns.length, [[1, '1'], [2, '2'], [3, '3']])}</div>
            <div class="ss-grid2">${tpl().columns.map((w, i) => `<label class="ss-field">Ancho col. ${i + 1}<input id="ssColW${i}" class="ss-inp ss-num" type="number" min="0.2" max="10" step="0.1" data-bind="card.w${i}" data-type="number" value="${esc(w)}"></label>`).join('')}</div></div>`;

        /** Totales, firmas y pie de la hoja de firmas (inspector y paso de impresión). */
        const tableSettingsHTML = () => {
            const t = tpl();
            const o = tableOptions(t.options);
            const numeric = t.columns.map((c, i) => [c, i]).filter(([c]) => c.cell.mode === 'number');
            return `<div class="ss-sec"><h3 class="ss-lbl">Totales</h3>
                <label class="ss-check"><input id="ssTotals" type="checkbox" data-bind="opt.totals" ${o.totals ? 'checked' : ''}> Fila de totales al final</label>
                ${o.totals && numeric.length ? `<div class="ss-colsum">${numeric.map(([c, i]) => `<label><input type="checkbox" data-bind="colsum.${i}" ${c.sum ? 'checked' : ''}> Σ ${esc(c.header || `Columna ${i + 1}`)}</label>`).join('')}</div>` : ''}</div>
              <div class="ss-sec"><h3 class="ss-lbl">Firmas</h3>
                <div class="ss-field">Línea de firma ${segHTML('opt.signLine', o.signLine, [['low', 'Abajo'], ['middle', 'En medio'], ['divider', 'Sobre la división']])}</div>
                <div class="ss-field">Pie “${esc(o.signLabels.join(' / '))}” ${segHTML('opt.signatures', o.signatures, [['none', 'No'], ['all', 'Todas'], ['first', 'Primera'], ['last', 'Última']])}</div>
                ${o.signatures !== 'none' ? `<label class="ss-field">Quién firma al pie (separa con comas)<input id="ssSignLabels" class="ss-inp" data-bind="opt.signLabels" value="${esc(o.signLabels.join(', '))}" maxlength="120"></label>` : ''}</div>`;
        };

        /** Operadores, texto y números a mano junto a la celda seleccionada. */
        const quickToolsHTML = () => `<div class="ss-quick" role="toolbar" aria-label="Agregar a la celda">${TOOLS.map((tool, i) =>
            `<button type="button" class="ss-chip ${chipClass(tool.chip)}" data-act="quick-chip" data-v="${i}" title="Agregar ${esc(tool.label)} a la celda">${esc(tool.label)}</button>`).join('')}</div>`;

        // Available for both the payment-envelope cells and numeric columns of
        // the signature sheet. Do not offer a formula save on text/signature cells.
        const saveCellAsVariableButton = (cell) =>
            cell.mode === 'number' && cell.chips.length
                ? '<button type="button" class="ss-btn sm" id="ssSaveCellAsVariable" data-act="vars-from-cell">Guardar cálculo como variable</button>'
                : '';

        const chipStripHTML = (zone, cell) => `<div class="ss-field">Chips de la celda
            <div class="ss-cell chipview" data-zone="${zone}" style="min-height:40px;border:1.5px dashed var(--border-strong);border-radius:8px;padding:6px;outline:0">${cell.chips.map((c, i) => chipHTML(c, zone, i)).join('') || '<span class="ss-hint">Suelta o toca chips para agregarlos</span>'}</div></div>`;

        const cellProps = (cell, isTitle) => {
            let html = '';
            if (!isTitle) html += `<div class="ss-field">Tipo ${segHTML('cell.mode', cell.mode, [['text', 'Texto'], ['number', 'Número (calcula)']])}</div>`;
            if (cell.mode === 'number') {
                html += `<div class="ss-field">Muestra ${segHTML('cell.show', cell.show || 'result', [['result', 'Resultado'], ['expression', 'Fórmula'], ['both', 'Ambos']])}</div>
                  <div class="ss-field">Total acumulado ${segHTML('cell.total', cell.total || 'auto', [['auto', 'Automático'], ['set', 'Fija el total'], ['apply', 'Se aplica'], ['ignore', 'No cuenta']])}</div>`;
            }
            html += `<div class="ss-field">Alineación ${segHTML('cell.align', cell.align || (cell.mode === 'number' ? 'right' : 'left'), [['left', 'Izquierda'], ['center', 'Centro'], ['right', 'Derecha']])}</div>
              <div class="ss-grid2"><label class="ss-check"><input id="ssBold" type="checkbox" data-bind="cell.bold" ${cell.bold ? 'checked' : ''}> Negrita</label>
              <label class="ss-field">Letra (pt)<input id="ssSize" class="ss-inp ss-num" type="number" min="5" max="40" step="0.5" data-bind="cell.size" data-type="number" value="${esc(cell.size || '')}" placeholder="${isTitle ? '10' : state.sheet === 'A' ? '8.5' : '9'}"></label></div>`;
            return html;
        };

        /** Secciones plegables: un clic en el título las oculta; se recuerda por tipo de sección. */
        const foldSections = (el) => {
            if (!el) return;
            el.querySelectorAll(':scope > .ss-sec > h3.ss-lbl:first-child').forEach((h) => {
                const key = h.textContent.replace(/\d+/g, '#').trim();
                h.dataset.fold = key;
                h.tabIndex = 0;
                h.setAttribute('role', 'button');
                const closed = !!state.folded[key];
                h.setAttribute('aria-expanded', String(!closed));
                h.parentElement.classList.toggle('collapsed', closed);
            });
        };
        const renderInspector = () => {
            renderInspectorBody();
            foldSections($('#ssInspector'));
        };
        const renderInspectorBody = () => {
            const el = $('#ssInspector');
            if (!el) return;
            const cell = selCell();
            if (!cell) {
                el.innerHTML = state.sheet === 'A'
                    ? `<div class="ss-sec"><h3 class="ss-lbl">Cómo se usa</h3>
                        <p class="ss-hint">• Arrastra un campo <strong>sobre la tarjeta</strong>: se crea la fila completa con su nombre, su monto y el signo según su color.</p>
                        <p class="ss-hint">• Haz clic en una celda para ver sus chips y opciones aquí.</p>
                        <p class="ss-hint">• Pasa el ratón por una fila: <strong>⋮⋮</strong> la mueve y <strong>⋯</strong> muestra sus opciones.</p>
                        <p class="ss-hint">• Las filas grises están ocultas para el empleado de muestra porque no tiene ese monto.</p></div>${cardSection()}`
                    : `<div class="ss-sec"><h3 class="ss-lbl">Cómo se usa</h3>
                        <p class="ss-hint">• Arrastra un campo a la franja de la derecha de la tabla para crear una columna, o sobre un encabezado para insertarla antes.</p>
                        <p class="ss-hint">• Haz clic en un encabezado o una celda para editar esa columna y guardar sus cálculos como variables.</p>
                        <p class="ss-hint">• Arrastra los encabezados para reordenar columnas.</p></div>
                       ${tableSettingsHTML()}`;
                return;
            }
            const zone = state.sel.zone;
            const isTitle = zone.startsWith('B:title');
            let html = '';
            if (state.sheet === 'A') {
                const r = zoneIndex(zone, 1);
                const c = zoneIndex(zone, 2);
                const row = tpl().rows[r];
                html += `<div class="ss-sec"><h3 class="ss-lbl">Fila ${r + 1} · celda ${c + 1}</h3>${chipStripHTML(zone, cell)}${quickToolsHTML()}${saveCellAsVariableButton(cell)}${cellProps(cell, false)}</div>
                  <div class="ss-sec"><h3 class="ss-lbl">Fila ${r + 1}</h3>
                    <div class="ss-field">Si sus montos están vacíos o en 0 ${segHTML('row.whenEmpty', row.whenEmpty || 'show', [['show', 'Mostrar'], ['dash', 'Guion “-”'], ['hide', 'Ocultar fila']])}</div>
                    <label class="ss-check"><input id="ssLine" type="checkbox" data-bind="row.lineAbove" ${row.lineAbove ? 'checked' : ''}> Línea separadora encima</label></div>${cardSection()}`;
            } else if (isTitle) {
                html += `<div class="ss-sec"><h3 class="ss-lbl">Línea ${zoneIndex(zone, 2) + 1} del encabezado</h3>${chipStripHTML(zone, cell)}${quickToolsHTML()}${saveCellAsVariableButton(cell)}${cellProps(cell, true)}</div>`;
            } else {
                const i = zoneIndex(zone, 2);
                const col = tpl().columns[i];
                html += `<div class="ss-sec"><h3 class="ss-lbl">Columna ${i + 1}</h3>
                    <label class="ss-field">Encabezado<input id="ssHeader" class="ss-inp" data-bind="col.header" value="${esc(col.header)}" maxlength="60"></label>
                    ${chipStripHTML(zone, cell)}${quickToolsHTML()}${saveCellAsVariableButton(cell)}
                    <div class="ss-grid2"><label class="ss-field">Ancho relativo<input id="ssWidth" class="ss-inp ss-num" type="number" min="0.2" max="10" step="0.1" data-bind="col.width" data-type="number" value="${esc(col.width)}"></label>
                    <label class="ss-check" style="align-self:end;min-height:34px"><input id="ssSum" type="checkbox" data-bind="col.sum" ${col.sum ? 'checked' : ''}> Sumar al pie</label></div>
                    <div class="ss-field">Bordes ${segHTML('col.border', col.border, [['all', 'Todos'], ['sign', 'Línea de firma'], ['none', 'Sin bordes']])}</div>
                    ${cellProps(cell, false)}
                    <div class="ss-row-btns"><button class="ss-btn sm" type="button" data-act="col-move" data-v="-1">← Mover</button><button class="ss-btn sm" type="button" data-act="col-move" data-v="1">Mover →</button><button class="ss-btn sm danger" type="button" data-act="col-del">Eliminar columna</button></div></div>`;
            }
            el.innerHTML = html;
        };

        // ─── Ventanas emergentes (chip, fila, plantillas, hoja) ────────────
        const popChip = () => {
            const chip = selChip();
            if (!chip) return '';
            let body = `<h3 class="ss-lbl">${esc(chipLabel(chip))}</h3>`;
            if (chip.kind === 'field') {
                body += fieldDef(chip.key) ? '' : `<div class="ss-msg-err">Campo desconocido: ${esc(chip.key)}</div>`;
                body += `<div class="ss-field">Imprime ${segHTML('chip.as', chip.as === 'label' ? 'label' : 'value', [['value', 'El valor'], ['label', 'El nombre']])}</div>`;
            } else if (chip.kind === 'text') {
                body += `<label class="ss-field">Texto<input id="ssChipText" class="ss-inp" data-bind="chip.value" value="${esc(chip.value)}" maxlength="200"></label>`;
            } else if (chip.kind === 'number') {
                body += `<div class="ss-grid2"><label class="ss-field">Valor<input id="ssChipNum" class="ss-inp ss-num" data-bind="chip.value" data-type="number" value="${esc(chip.value)}" inputmode="decimal"></label>
                  <label class="ss-check" style="align-self:end;min-height:34px"><input id="ssChipPct" type="checkbox" data-bind="chip.percent" ${chip.percent ? 'checked' : ''}> %</label></div>`;
            } else if (chip.kind === 'op') {
                body += `<div class="ss-field">Operador ${segHTML('chip.op', chip.op, [['+', '+'], ['-', '−'], ['*', '×'], ['/', '÷']])}</div>`;
            }
            body += `<div class="ss-row-btns"><button class="ss-btn sm" type="button" data-act="chip-move" data-v="-1">←</button><button class="ss-btn sm" type="button" data-act="chip-move" data-v="1">→</button><div class="ss-grow"></div><button class="ss-btn sm danger" type="button" data-act="chip-del">Quitar</button></div>`;
            return body;
        };
        const popRow = (r) => {
            const row = tpl().rows[r];
            if (!row) return '';
            const we = row.whenEmpty || 'show';
            return `<div class="ss-menu">
              <button type="button" data-act="row-move" data-v="${r}:-1">Subir <span class="ss-kbd">↑</span></button>
              <button type="button" data-act="row-move" data-v="${r}:1">Bajar <span class="ss-kbd">↓</span></button>
              <button type="button" data-act="row-dup" data-v="${r}">Duplicar</button><hr>
              <button type="button" data-act="row-empty" data-v="${r}:show" class="${we === 'show' ? 'active' : ''}">Si está vacía: mostrar</button>
              <button type="button" data-act="row-empty" data-v="${r}:dash" class="${we === 'dash' ? 'active' : ''}">Si está vacía: guion “-”</button>
              <button type="button" data-act="row-empty" data-v="${r}:hide" class="${we === 'hide' ? 'active' : ''}">Si está vacía: ocultar</button>
              <button type="button" data-act="row-line" data-v="${r}" class="${row.lineAbove ? 'active' : ''}">Línea separadora encima</button><hr>
              <button type="button" data-act="row-del" data-v="${r}" class="danger">Eliminar fila</button></div>`;
        };
        const popTitle = (i) => `<div class="ss-menu">
              <button type="button" data-act="title-move" data-v="${i}:-1">Subir</button>
              <button type="button" data-act="title-move" data-v="${i}:1">Bajar</button><hr>
              <button type="button" data-act="title-del" data-v="${i}" class="danger">Eliminar línea</button></div>`;
        const popTpl = () => {
            const type = typeOf(state.sheet);
            const list = state.store.templates.filter((t) => t.template.type === type);
            const cur = activeEntry();
            if (state.showStarters) {
                const type = typeOf(state.sheet);
                return `<h3 class="ss-lbl">Nueva plantilla: elige un punto de partida</h3>
                  <div class="ss-starters">${starterTemplates().filter((st) => st.type === type).map((st) =>
                    `<button type="button" data-act="tpl-starter" data-v="${st.id}"><strong>${esc(st.name)}</strong><span>${esc(st.hint)}</span></button>`).join('')}</div>
                  <div class="ss-row-btns"><button class="ss-btn sm" type="button" data-act="tpl-starter-cancel">Cancelar</button></div>`;
            }
            return `<h3 class="ss-lbl">Plantillas · ${state.sheet === 'A' ? 'tarjeta del sobre' : 'hoja de firmas'}</h3>
              <div class="ss-menu">${list.map((t) => `<button type="button" data-act="tpl-use" data-v="${t.id}" class="${t.id === cur.id ? 'active' : ''}">${esc(t.name)}${t.id === cur.id ? ' <span>✓</span>' : ''}</button>`).join('')}</div>
              <label class="ss-field">Nombre de esta plantilla<input id="ssTplName" class="ss-inp" data-bind="tplname" value="${esc(cur.name)}" maxlength="80"></label>
              <div class="ss-row-btns">
                <button class="ss-btn sm" type="button" data-act="tpl-new">+ Nueva</button>
                <button class="ss-btn sm" type="button" data-act="tpl-dup">Duplicar</button>
                <button class="ss-btn sm" type="button" data-act="open-json">JSON…</button>
                ${list.length > 1 ? (state.confirmDelete
                    ? `<button class="ss-btn sm danger" type="button" data-act="tpl-del-yes">¿Eliminar “${esc(cur.name)}”? Sí</button><button class="ss-btn sm" type="button" data-act="tpl-del-no">No</button>`
                    : '<button class="ss-btn sm danger" type="button" data-act="tpl-del">Eliminar</button>') : ''}
              </div>`;
        };
        const popPage = () => {
            const t = tpl();
            const L = t.layout;
            let html = `<h3 class="ss-lbl">Hoja</h3>
              <label class="ss-field">Papel${selectHTML('ssPaper', 'lay.paper', L.paper, PAPERS)}</label>
              <div class="ss-field">Orientación ${segHTML('lay.orientation', L.orientation, [['portrait', 'Vertical'], ['landscape', 'Horizontal']])}</div>`;
            if (state.sheet === 'A') {
                html += `<div class="ss-field">Tarjetas ${segHTML('lay.mode', L.mode, [['grid', 'Cuántas por hoja'], ['size', 'Tamaño en mm']])}</div>
                  <div class="ss-grid2">${L.mode === 'grid'
                    ? `<label class="ss-field">Columnas<input id="ssCols" class="ss-inp ss-num" type="number" min="1" max="6" data-bind="lay.cols" data-type="number" value="${esc(L.cols)}"></label>
                       <label class="ss-field">Filas<input id="ssRows" class="ss-inp ss-num" type="number" min="1" max="12" data-bind="lay.rows" data-type="number" value="${esc(L.rows)}"></label>`
                    : `<label class="ss-field">Ancho (mm)<input id="ssCW" class="ss-inp ss-num" type="number" min="20" max="300" data-bind="lay.cardWidth" data-type="number" value="${esc(L.cardWidth || 90)}"></label>
                       <label class="ss-field">Alto (mm)<input id="ssCH" class="ss-inp ss-num" type="number" min="15" max="300" data-bind="lay.cardHeight" data-type="number" value="${esc(L.cardHeight || 55)}"></label>`}
                    <label class="ss-field">Margen (mm)<input id="ssMargin" class="ss-inp ss-num" type="number" min="0" max="40" data-bind="lay.margin" data-type="number" value="${esc(L.margin)}"></label>
                    <label class="ss-field">Separación (mm)<input id="ssGap" class="ss-inp ss-num" type="number" min="0" max="20" data-bind="lay.gap" data-type="number" value="${esc(L.gap)}"></label></div>
                  <label class="ss-check"><input id="ssCut" type="checkbox" data-bind="lay.cutMarks" ${L.cutMarks ? 'checked' : ''}> Líneas de corte punteadas</label>
                  <div class="ss-grid2"><label class="ss-field">Letra base (pt)<input id="ssFont" class="ss-inp ss-num" type="number" min="5" max="14" step="0.25" data-bind="lay.fontSize" data-type="number" value="${esc(cardFontPt(t))}"></label>
                    <button class="ss-btn sm" type="button" data-act="font-fit" style="align-self:end;min-height:34px" title="Busca la letra más grande con la que todo cabe en cada tarjeta">Ajustar al tamaño</button></div>`;
            } else {
                html += `<div class="ss-grid2"><label class="ss-field">Margen (mm)<input id="ssMargin" class="ss-inp ss-num" type="number" min="0" max="40" data-bind="lay.margin" data-type="number" value="${esc(L.margin)}"></label>
                  <label class="ss-field">Alto de fila (mm)<input id="ssRowH" class="ss-inp ss-num" type="number" min="6" max="30" step="0.5" data-bind="opt.rowHeight" data-type="number" value="${esc(t.options.rowHeight)}"></label></div>
                  <label class="ss-field">Logo (imagen)<input id="ssLogo" class="ss-inp" type="file" accept="image/*" data-act-change="logo"></label>
                  ${state.store.logo ? `<div class="ss-field">Logo ${segHTML('opt.logoStyle', tableOptions(t.options).logoStyle, [['color', 'A color'], ['bw', 'Blanco y negro'], ['invert', 'Invertido']])}</div>
                    <div class="ss-logoprev"><img src="${state.store.logo}" alt="Logo" style="filter:${logoFilter(tableOptions(t.options).logoStyle)}">
                    <button class="ss-btn sm" type="button" data-act="logo-del">Quitar logo</button></div>` : ''}`;
            }
            html += `<div class="ss-grid2"><label class="ss-field">Ordenar por${selectHTML('ssSort', 'sort.field', (t.sortBy || {}).field || 'no', SORTS)}</label>
              <div class="ss-field">Sentido ${segHTML('sort.dir', (t.sortBy || {}).dir || 'asc', [['asc', '↑'], ['desc', '↓']])}</div></div>`;
            return html;
        };

        const renderLayer = () => {
            const host = $('#ssLayer');
            if (!host) return;
            const p = state.pop;
            if (!p) { host.innerHTML = ''; return; }
            let body = '';
            let anchor = null;
            if (p.type === 'chip') { body = popChip(); anchor = rootEl.querySelector(`#ssCanvas .ss-chip.is-sel`) || rootEl.querySelector('.ss-chip.is-sel'); }
            else if (p.type === 'row') { body = popRow(p.v); anchor = $(`#ssRowMenu${p.v}`); }
            else if (p.type === 'title') { body = popTitle(p.v); anchor = $(`#ssTitleMenu${p.v}`); }
            else if (p.type === 'tpl') { body = popTpl(); anchor = $('#ssTplBtn'); }
            else if (p.type === 'page') { body = popPage(); anchor = $('#ssPageBtn'); }
            else if (p.type === 'checks') { body = `<h3 class="ss-lbl">Verificación</h3>${checksHTML(moneyChecks())}`; anchor = $('#ssChecksBtn'); }
            if (!body || !anchor) { state.pop = null; host.innerHTML = ''; return; }
            host.innerHTML = `<div class="ss-pop" id="ssPop" role="dialog">${body}</div>`;
            const pop = $('#ssPop');
            const a = anchor.getBoundingClientRect();
            const w = pop.offsetWidth; const h = pop.offsetHeight;
            const vw = window.innerWidth; const vh = window.innerHeight;
            let left = Math.min(Math.max(8, a.left), vw - w - 8);
            let top = a.bottom + 6;
            if (top + h > vh - 8) top = Math.max(8, a.top - h - 6);
            pop.style.left = `${left}px`;
            pop.style.top = `${top}px`;
        };

        // ─── Paso de impresión ─────────────────────────────────────────────
        /** Resumen "N tarjetas → M hojas" del paso de impresión. */
        const printSummary = (list) => {
            let summary;
            if (state.sheet === 'A') {
                const lay = SB.computeLayout(tpl().layout);
                const pages = Math.ceil(list.length / lay.perPage);
                summary = `${list.length} tarjeta${list.length === 1 ? '' : 's'} · ${lay.perPage} por hoja → <strong>${pages} hoja${pages === 1 ? '' : 's'}</strong>`;
            } else {
                const pages = tablePageSizes(tpl(), !!state.store.logo, list.length).length;
                summary = `${list.length} empleado${list.length === 1 ? '' : 's'} → <strong>${pages} hoja${pages === 1 ? '' : 's'}</strong>`;
            }
            return summary;
        };
        const renderPrintStep = () => {
            const el = $('#ssPrint');
            if (!el) return;
            const o = state.printOpts;
            const count = (mode) => selectEmployees(employees, { mode, ids: o.ids }).length;
            const radio = (mode, label) => `<label class="ss-radio${o.mode === mode ? ' on' : ''}"><input type="radio" name="ssWho" data-bind="print.mode" value="${mode}" ${o.mode === mode ? 'checked' : ''}> ${label}<span class="n">${count(mode)}</span></label>`;
            const list = printList();
            const keepScroll = el.querySelector('.ss-printside') ? el.querySelector('.ss-printside').scrollTop : 0;
            const checks = checksHTML(moneyChecks(list));
            el.innerHTML = `<aside class="ss-printside">
                ${checks ? `<div class="ss-sec"><h3 class="ss-lbl">Verificación</h3>${checks}</div>` : ''}
                <div class="ss-sec"><h3 class="ss-lbl">¿A quién?</h3>
                  ${radio('all', 'Todos los empleados')}${radio('unpaid', 'Solo los no pagados')}${radio('loan', 'Solo con préstamo o adelanto')}${radio('custom', 'Elegir…')}
                  ${o.mode === 'custom' ? `<div class="ss-row-btns"><button class="ss-btn sm" type="button" data-act="pick-all">Todos</button><button class="ss-btn sm" type="button" data-act="pick-none">Ninguno</button></div>
                    <div class="ss-emplist">${employees.map((e) => `<label><input type="checkbox" data-pick="${esc(e.id)}" ${o.ids.includes(e.id) ? 'checked' : ''}> ${esc(e.employeeNumber || '')} ${esc(e.employeeName || e.name)}</label>`).join('')}</div>` : ''}</div>
                ${state.sheet === 'A' ? `<div class="ss-sec"><h3 class="ss-lbl">Copias</h3><div class="ss-field">Tarjetas por empleado ${segHTML('print.copies', o.copies, [[1, '1'], [2, '2'], [3, '3']])}</div></div>` : ''}
                <div class="ss-sec"><p class="ss-hint">${esc(pageSummary(tpl()))}</p><p class="ss-hint" id="ssPrintSummary"></p></div>
                <div class="ss-sec">${popPage()}
                  <p class="ss-hint">${state.sheet === 'A'
                    ? 'En la vista previa, arrastra la esquina azul de la primera tarjeta para cambiar su tamaño, o las líneas entre columnas para su ancho.'
                    : 'En la vista previa, arrastra los bordes de los encabezados de la primera hoja para cambiar el ancho de las columnas.'}</p></div>
                ${state.sheet === 'B' ? tableSettingsHTML() : ''}
                <button class="ss-btn primary ss-big" type="button" data-act="print" ${list.length ? '' : 'disabled'}>🖨 Imprimir</button>
                <p class="ss-hint">Se abre el diálogo de impresión: elige tu impresora o “Guardar como PDF”, con márgenes “Ninguno” y escala 100%.</p>
              </aside>
              <section class="ss-printpages" id="ssPrintPages"><div class="ss-desk" id="ssDesk"></div></section>`;
            foldSections(el.querySelector('.ss-printside'));
            el.querySelector('.ss-printside').scrollTop = keepScroll;
            renderPrintDesk();
        };
        const renderPrintDesk = () => {
            const desk = $('#ssDesk');
            if (!desk) return;
            const list = printList();
            const L = tpl().layout;
            const [w, h] = SB.PAPER_SIZES[L.paper] || SB.PAPER_SIZES.letter;
            const pw = L.orientation === 'landscape' ? h : w;
            const avail = Math.max(280, ($('#ssPrintPages').clientWidth || 800) - 60);
            desk.innerHTML = list.length ? pagesHTML(Math.min(2.4, avail / pw), false) : '<p class="ss-hint">No hay empleados seleccionados.</p>';
            const sum = $('#ssPrintSummary');
            if (sum) sum.innerHTML = printSummary(list);
        };

        // ─── Cambios de estado ─────────────────────────────────────────────
        const touch = (parts) => {
            save();
            const p = parts === undefined ? 'all' : parts;
            if (p === 'all') return renderShell();
            if (p.includes('bar')) renderBar();
            if (p.includes('pagebar')) renderPageBar();
            if (p.includes('palette')) renderPalette();
            if (p.includes('canvas')) renderCanvas();
            if (state.tour != null && p.includes('canvas')) renderTour();
            if (p.includes('insp')) renderInspector();
            if (state.printing) {
                // En el paso de impresión los cambios de plantilla se ven en la vista previa.
                if (p.includes('print') || /canvas|pagebar|insp/.test(p)) renderPrintStep();
                else if (p.includes('desk')) renderPrintDesk();
            }
            if (p.includes('layer')) renderLayer();
        };
        const EDIT = 'bar canvas insp layer pagebar';

        const remember = (chip) => {
            const sig = JSON.stringify(chip);
            state.store.recent = [sig, ...state.store.recent.filter((s) => s !== sig)].slice(0, 8);
        };
        const insertChip = (zone, chip, at) => {
            const cell = cellOf(zone);
            if (!cell) return;
            commit();
            const idx = at == null ? cell.chips.length : at;
            cell.chips.splice(idx, 0, clone(chip));
            select(zone, idx);
            remember(chip);
            const c = cell.chips[idx];
            state.pop = c.kind === 'text' || c.kind === 'number' ? { type: 'chip' } : null;
        };
        /** Soltar un chip de la paleta fuera de las celdas: crea la fila (tarjeta), la columna o la línea. */
        /** Al soltar "al final" de la tarjeta, la fila nueva va antes de la fila del total para que cuente. */
        const endRowIndex = () => {
            const rows = tpl().rows;
            const i = rows.findIndex((r) => r.cells.some((c) => c.chips.some((ch) => ch.kind === 'running')));
            return i >= 0 ? i : rows.length;
        };
        /** Las columnas nuevas van antes de las columnas de firma del final. */
        const endColIndex = () => {
            const cols = tpl().columns;
            let i = cols.length;
            while (i > 0 && cols[i - 1].border === 'sign') i--;
            return i;
        };
        const smartInsert = (target, at, chip) => {
            const t = tpl();
            commit();
            remember(chip);
            if (target === 'row') {
                const row = chip.kind === 'field'
                    ? smartRowFor(chip.key, fieldDef(chip.key), t.columns.length)
                    : { cells: t.columns.map((_, i) => ({ mode: 'text', chips: i === 0 ? [clone(chip)] : [] })) };
                t.rows.splice(at, 0, row);
                select(`A:${at}:${row.cells.length - 1}`);
                toast(chip.kind === 'field' ? `Fila “${chipLabel(chip)}” agregada` : 'Fila agregada');
            } else if (target === 'col') {
                const col = chip.kind === 'field' ? smartColumnFor(chip.key, fieldDef(chip.key)) : { header: 'Nueva', width: 1, border: 'all', sum: false, cell: { mode: 'text', chips: [clone(chip)] } };
                t.columns.splice(at, 0, col);
                select(`B:col:${at}`);
                toast(`Columna “${col.header}” agregada`);
            } else if (target === 'title') {
                t.title.splice(at, 0, { mode: 'text', size: 10, chips: chip.kind === 'field' ? [F(chip.key, 'label'), T(':'), F(chip.key)] : [clone(chip)] });
                select(`B:title:${at}`);
            }
            state.pop = null;
        };

        let toastTimer = null;
        const toast = (msg, undoable) => {
            const host = $('#ssToast');
            if (!host) return;
            host.innerHTML = `<div class="ss-toast" role="status">${esc(msg)}${undoable ? ' <button type="button" data-act="undo">Deshacer</button>' : ''}</div>`;
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => { host.innerHTML = ''; }, 3200);
        };

        const setByBind = (bind, value) => {
            const [scope, key] = bind.split('.');
            const t = tpl();
            const cell = selCell();
            switch (scope) {
                case 'query': state.query = value; return 'palette';
                case 'formulas': state.formulas = value; return 'canvas layer';
                case 'colors': state.store.colors = value; return 'canvas print';
                case 'preview': state.preview = +value; return 'canvas';
                case 'tplname': activeEntry().name = String(value).slice(0, 80) || 'Plantilla'; return 'bar';
                case 'print':
                    if (key === 'mode') { state.printOpts.mode = value; if (value === 'custom' && !state.printOpts.ids.length) state.printOpts.ids = employees.map((e) => e.id); }
                    else state.printOpts[key] = value;
                    return 'print';
                case 'chip': {
                    const c = selChip();
                    if (!c) return '';
                    commit(`chip:${key}`);
                    if (key === 'as') { if (value === 'label') c.as = 'label'; else delete c.as; } else c[key] = value;
                    return 'canvas insp layer';
                }
                case 'cell':
                    if (!cell) return '';
                    commit(`cell:${key}`);
                    if (key === 'size' && !Number.isFinite(value)) delete cell.size;
                    else if (key === 'show' && value === 'result') delete cell.show;
                    else if (key === 'total' && value === 'auto') delete cell.total;
                    else cell[key] = value;
                    return EDIT;
                case 'row': {
                    const row = t.rows[zoneIndex(state.sel.zone, 1)];
                    commit(`row:${key}`);
                    if (key === 'whenEmpty' && value === 'show') delete row.whenEmpty;
                    else if (key === 'lineAbove' && !value) delete row.lineAbove;
                    else row[key] = value;
                    return EDIT;
                }
                case 'col': {
                    const col = t.columns[zoneIndex(state.sel.zone, 2)];
                    commit(`col:${key}`);
                    col[key] = key === 'width' ? Math.max(0.2, value || 1) : value;
                    return 'bar canvas';
                }
                case 'opt':
                    commit(`opt:${key}`);
                    if (key === 'signLabels') t.options.signLabels = String(value).split(',').map((x) => x.trim()).filter(Boolean);
                    else t.options[key] = key === 'rowHeight' ? Math.max(6, value || 11) : value;
                    return 'bar canvas pagebar' + (key === 'totals' || key === 'signatures' ? ' insp' : '') + (key === 'logoStyle' ? ' layer' : '');
                case 'colsum':
                    commit(`colsum:${key}`);
                    t.columns[+key].sum = !!value;
                    return 'bar canvas';
                case 'card': {
                    const cols = t.columns;
                    commit(`card:${key}`);
                    if (key === 'cols') {
                        while (cols.length < value) { cols.push(1); t.rows.forEach((r) => r.cells.push(cT([]))); }
                        while (cols.length > value) {
                            cols.pop();
                            t.rows.forEach((r) => { const gone = r.cells.pop(); r.cells[r.cells.length - 1].chips.push(...gone.chips); });
                        }
                        state.sel = null;
                        return EDIT;
                    }
                    cols[+key.slice(1)] = Math.max(0.2, value || 1);
                    return 'bar canvas';
                }
                case 'lay': {
                    if (typeof value === 'number' && !Number.isFinite(value)) return '';
                    commit(`lay:${key}`);
                    t.layout[key] = value;
                    if (key === 'mode' && value === 'size') { t.layout.cardWidth = t.layout.cardWidth || 90; t.layout.cardHeight = t.layout.cardHeight || 55; }
                    return 'bar canvas pagebar' + (key === 'mode' || key === 'orientation' || key === 'paper' ? ' layer' : '');
                }
                case 'sort': commit('sort'); t.sortBy = Object.assign({ field: 'no', dir: 'asc' }, t.sortBy, { [key]: value }); return 'bar canvas layer';
            }
            return '';
        };

        const moveIn = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return i; [arr[i], arr[j]] = [arr[j], arr[i]]; return j; };
        const pair = (v) => v.split(':').map((x) => (/^-?\d+$/.test(x) ? +x : x));

        const print = () => {
            if (!printList().length) return toast('No hay empleados para imprimir');
            let host = document.getElementById('ss-print');
            if (!host) { host = document.createElement('div'); host.id = 'ss-print'; document.body.appendChild(host); }
            host.innerHTML = pagesHTML(PRINT_K, true);
            let rule = document.getElementById('ss-page-rule');
            if (!rule) { rule = document.createElement('style'); rule.id = 'ss-page-rule'; document.head.appendChild(rule); }
            const L = tpl().layout;
            rule.textContent = `@media print { ${printPageRule(L.paper, L.orientation)} }`;
            // Copia de lo impreso: si luego cambian los datos, se avisa que el papel ya no coincide.
            const t = tpl();
            state.store.printed[state.sheet] = { at: new Date().toISOString(), template: clone(t), sigs: printSignatures(engine, t, sorted(uniqueById(printList()), t.sortBy), (e) => e.id) };
            state.store.ready[state.sheet] = true;
            save();
            const done = () => { document.body.classList.remove('ss-printing'); host.innerHTML = ''; window.removeEventListener('afterprint', done); touch(); };
            window.addEventListener('afterprint', done);
            document.body.classList.add('ss-printing');
            window.print();
        };

        const doUndo = (dir) => {
            const h = history();
            const snap = dir < 0 ? h.undo(JSON.stringify(tpl())) : h.redo(JSON.stringify(tpl()));
            if (snap === null) return;
            restore(snap);
            lastCommit = { key: '', at: 0 };
            touch('all');
        };

        const actions = {
            sheet: (v) => { state.sheet = v; state.store.sheet = v; state.sel = null; state.pop = null; touch(); },
            'vars-from-cell': () => {
                const cell = selCell();
                if (!cell || !cell.chips.length || cell.chips.some(c => !['field','number','op','paren'].includes(c.kind)))
                    return toast('Selecciona una celda con un cálculo numérico para guardarlo como variable');
                variableSeedChips = clone(cell.chips);
                state.variableEdit = null;
                renderVariablesDialog();
            },
            'vars-open': () => { state.variableEdit = null; state.variableDeleteConfirm = null; renderVariablesDialog(); },
            'documents': () => { if (typeof opts.onOpenDocuments === 'function') opts.onOpenDocuments(); },
            'vars-close': () => closeVariablesDialog(),
            'vars-new': () => { state.variableEdit = null; renderVariablesDialog(); },
            'vars-edit': (id) => { state.variableEdit = id; state.variableDeleteConfirm = null; renderVariablesDialog(); },
            'vars-save': () => saveVariable(),
            'vars-delete': (id) => {
                if (state.variableDeleteConfirm !== id) { state.variableDeleteConfirm = id; return renderVariablesDialog(); }
                const key = 'custom:' + id;
                if (JSON.stringify(state.store.templates).includes('"key":"' + key + '"'))
                    return variableError('La variable aparece en una plantilla. Quítala de la plantilla antes de eliminarla.');
                try {
                    const defs = state.store.variables.filter(v => v.id !== id);
                    CV.validateDefinitions(defs, SF.createFieldSet({ records: employees, getNetAmount: opts.getNetAmount }));
                    state.store.variables = defs;
                    state.store.ready = { A: false, B: false };
                    save(); rebuildEngine(); state.variableEdit = null; state.variableDeleteConfirm = null;
                    closeVariablesDialog(); touch(); toast('Variable eliminada', true);
                } catch (e) { variableError(e.message); }
            },
            close: () => api.close(),
            undo: () => doUndo(-1),
            redo: () => doUndo(1),
            'print-step': () => { state.printing = true; state.pop = null; touch(); },
            'print-back': () => { state.printing = false; touch(); },
            'quick-chip': (v) => {
                if (!state.sel || !state.sel.zone) return toast('Primero haz clic en una celda');
                insertChip(state.sel.zone, TOOLS[+v].chip, state.sel.ci != null ? state.sel.ci + 1 : null);
                touch(EDIT + ' palette');
            },
            'font-fit': () => {
                const pt = autoFitFont();
                commit();
                tpl().layout.fontSize = pt;
                touch();
                toast(`Letra ajustada a ${pt} pt para que todo quepa`, true);
            },
            tour: () => { state.tour = 0; state.pop = null; if (state.printing) { state.printing = false; touch(); } else renderTour(); renderLayer(); },
            'tour-next': () => { state.tour += 1; renderTour(); },
            'tour-end': () => { state.tour = null; state.store.tourDone = true; save(); renderTour(); },
            'drift-ok': () => { delete state.store.printed[state.sheet]; state.pop = null; touch(); },
            breakdown: (total) => {
                const prefix = TOTAL_PREFIX[total];
                const concepts = fieldSet.listConcepts().map((c) => c.key).filter((k) => k.startsWith(prefix + ':'));
                commit();
                activeEntry().template = breakDownRow(tpl(), total, concepts, fieldDef);
                state.sel = null; state.pop = null;
                touch();
                toast(`${TOTAL_LABEL[total]} desglosado por concepto`, true);
            },
            print,
            'pick-all': () => { state.printOpts.ids = employees.map((e) => e.id); touch('print'); },
            'pick-none': () => { state.printOpts.ids = []; touch('print'); },
            emp: (v) => { const n = employees.length; state.preview = (state.preview + +v + n) % n; touch('canvas layer'); },
            'add-row': () => { commit(); const t = tpl(); t.rows.push({ cells: t.columns.map((_, i) => (i === t.columns.length - 1 && i > 0 ? cN([]) : cT([]))) }); select(`A:${t.rows.length - 1}:0`); touch(EDIT); },
            'row-move': (v) => { const [r, d] = pair(v); commit(); const j = moveIn(tpl().rows, r, d); select(`A:${j}:0`); state.pop = { type: 'row', v: j }; touch(EDIT); },
            'row-dup': (v) => { const r = +v; commit(); tpl().rows.splice(r + 1, 0, clone(tpl().rows[r])); state.pop = null; touch(EDIT); },
            'row-del': (v) => { const r = +v; commit(); tpl().rows.splice(r, 1); state.sel = null; state.pop = null; touch(EDIT); toast('Fila eliminada', true); },
            'row-empty': (v) => { const [r, mode] = pair(v); commit(); const row = tpl().rows[r]; if (mode === 'show') delete row.whenEmpty; else row.whenEmpty = mode; touch(EDIT); },
            'row-line': (v) => { const r = +v; commit(); const row = tpl().rows[r]; if (row.lineAbove) delete row.lineAbove; else row.lineAbove = true; touch(EDIT); },
            'col-move': (v) => { commit(); const j = moveIn(tpl().columns, zoneIndex(state.sel.zone, 2), +v); select(`B:col:${j}`); touch(EDIT); },
            'col-del': () => { commit(); tpl().columns.splice(zoneIndex(state.sel.zone, 2), 1); state.sel = null; touch(EDIT); toast('Columna eliminada', true); },
            'add-title': () => { commit(); tpl().title.push(cT([], { size: 10 })); select(`B:title:${tpl().title.length - 1}`); touch(EDIT); },
            'title-move': (v) => { const [i, d] = pair(v); commit(); const j = moveIn(tpl().title, i, d); select(`B:title:${j}`); state.pop = { type: 'title', v: j }; touch(EDIT); },
            'title-del': (v) => { commit(); tpl().title.splice(+v, 1); state.sel = null; state.pop = null; touch(EDIT); toast('Línea eliminada', true); },
            'chip-move': (v) => { commit(); state.sel.ci = moveIn(selCell().chips, state.sel.ci, +v); touch(EDIT); },
            'chip-del': () => { commit(); const [gone] = selCell().chips.splice(state.sel.ci, 1); state.sel.ci = null; state.pop = null; touch(EDIT); toast(`Se quitó “${chipLabel(gone)}”`, true); },
            'logo-del': () => { state.store.logo = null; touch('canvas layer'); },
            'tpl-use': (v) => { state.store.active[state.sheet] = v; state.sel = null; state.pop = null; state.confirmDelete = false; touch(); },
            'tpl-new': () => { state.showStarters = true; touch('layer'); },
            'tpl-starter-cancel': () => { state.showStarters = false; touch('layer'); },
            'tpl-starter': (id) => {
                const st = starterTemplates().find((x) => x.id === id);
                if (!st) return;
                const template = st.build(fieldSet.listConcepts().map((c) => c.key));
                const entry = { id: newId(), name: st.name, template };
                state.showStarters = false;
                state.store.templates.push(entry); state.store.active[state.sheet] = entry.id; state.sel = null; state.pop = { type: 'tpl' }; touch();
                const inp = $('#ssTplName'); if (inp) { inp.focus(); inp.select(); }
            },
            'tpl-dup': () => {
                const cur = activeEntry();
                const entry = { id: newId(), name: `${cur.name} (copia)`.slice(0, 80), template: clone(cur.template) };
                state.store.templates.push(entry); state.store.active[state.sheet] = entry.id; state.sel = null; state.pop = { type: 'tpl' }; touch();
            },
            'tpl-del': () => { state.confirmDelete = true; touch('layer'); },
            'tpl-del-no': () => { state.confirmDelete = false; touch('layer'); },
            'tpl-del-yes': () => {
                const cur = activeEntry();
                state.store.templates = state.store.templates.filter((t) => t.id !== cur.id);
                state.store.active = migrateStore(state.store).active;
                state.confirmDelete = false; state.sel = null; state.pop = null; touch(); toast(`Se eliminó “${cur.name}”`);
            },
            'open-json': () => { state.pop = null; state.drawer = 'tpl'; renderLayer(); renderDrawer(); },
            'close-drawer': () => { state.drawer = null; renderDrawer(); },
            'copy-tpl': () => {
                const ta = $('#ssTplText');
                const fallback = () => { ta.select(); toast('Selecciona y copia con Ctrl+C'); };
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(() => toast('Plantilla copiada'), fallback);
                else fallback();
            },
            'apply-tpl': () => {
                const out = $('#ssTplMsg');
                try {
                    const text = $('#ssTplText').value;
                    let next;
                    if (state.sheet === 'A') next = SB.parseTemplate(text);
                    else { next = JSON.parse(text); const errs = validateTableTemplate(next); if (errs.length) throw new Error(`Plantilla inválida:\n${errs.join('\n')}`); }
                    commit();
                    activeEntry().template = next;
                    state.sel = null; state.drawer = null;
                    touch(); toast('Plantilla aplicada', true);
                } catch (e) { out.innerHTML = `<span class="ss-msg-err">${esc(e.message)}</span>`; }
            },
            'reset-tpl': () => {
                commit();
                activeEntry().template = state.sheet === 'A' ? defaultCardTemplate() : defaultTableTemplate();
                state.sel = null; state.drawer = null;
                touch(); toast('Se restauró la plantilla de ejemplo', true);
            }
        };

        const renderDrawer = () => {
            const host = $('#ssDrawer');
            if (!host) return;
            if (!state.drawer) { host.innerHTML = ''; return; }
            host.innerHTML = `<div class="ss-scrim"><div class="ss-drawer" role="dialog" aria-label="Plantilla JSON">
              <div class="ss-row-btns" style="align-items:center"><h2 style="margin:0;font-size:17px">“${esc(activeEntry().name)}” en JSON</h2><div class="ss-grow"></div><button class="ss-btn sm" type="button" data-act="close-drawer">Cerrar</button></div>
              <p class="ss-hint">Copia este JSON para guardarlo o compartirlo, o pega uno y aplícalo. Se valida antes de usarlo.</p>
              <textarea id="ssTplText" spellcheck="false">${esc(JSON.stringify(tpl(), null, 2))}</textarea>
              <div class="ss-row-btns"><button class="ss-btn primary" type="button" data-act="apply-tpl">Aplicar</button><button class="ss-btn" type="button" data-act="copy-tpl">Copiar</button><button class="ss-btn danger" type="button" data-act="reset-tpl">Restaurar ejemplo</button></div>
              <div id="ssTplMsg"></div></div></div>`;
        };

        // ─── Eventos (delegados en el contenedor) ──────────────────────────
        const readInput = (el) => (el.type === 'checkbox' ? el.checked : el.dataset.type === 'number' ? (el.value === '' ? NaN : parseFloat(el.value)) : el.value);
        const setTrash = (on) => rootEl.classList.toggle('trashing', on);
        const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
        const clearOver = () => rootEl.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));

        /** Destino de una soltura según el elemento bajo el ratón. */
        const dropTarget = (el) => {
            if (!el || !el.closest) return null;
            const zone = el.closest('[data-zone]');
            if (zone) return { kind: 'cell', el: zone, zone: zone.dataset.zone };
            const ins = el.closest('[data-insert]');
            if (ins) return { kind: 'row', el: ins, at: ins.dataset.insert === 'end' ? endRowIndex() : +ins.dataset.insert };
            const th = el.closest('[data-coldrag]');
            if (th) return { kind: 'col', el: th, at: +th.dataset.coldrag };
            const strip = el.closest('[data-insert-col]');
            if (strip) return { kind: 'col', el: strip, at: endColIndex() };
            const tline = el.closest('[data-insert-title]');
            if (tline) return { kind: 'title', el: tline, at: tpl().title ? tpl().title.length : 0 };
            const card = el.closest('#ssCardEdit');
            if (card) return { kind: 'row', el: card.querySelector(`[data-insert="${tpl().rows.length}"]`), at: endRowIndex() };
            return null;
        };

        const bindEvents = () => {
            if (bound) return;
            bound = true;
            rootEl.addEventListener('click', (e) => {
                const t = e.target;
                if (t.classList && t.classList.contains('ss-scrim')) return actions['close-drawer']();
                const inPop = t.closest('#ssPop');
                const opener = t.closest('[data-pop]');
                if (opener) {
                    const type = opener.dataset.pop;
                    const v = opener.dataset.v != null ? +opener.dataset.v : undefined;
                    const same = state.pop && state.pop.type === type && state.pop.v === v;
                    state.confirmDelete = false;
                    state.pop = same ? null : { type, v };
                    state.showStarters = false;
                    if (type === 'row' && !same) select(`A:${v}:0`);
                    if (type === 'title' && !same) select(`B:title:${v}`);
                    return touch(type === 'row' || type === 'title' ? 'canvas insp layer' : 'layer');
                }
                const fold = t.closest('[data-fold]');
                if (fold) {
                    const key = fold.dataset.fold;
                    state.folded[key] = !state.folded[key];
                    fold.parentElement.classList.toggle('collapsed', state.folded[key]);
                    fold.setAttribute('aria-expanded', String(!state.folded[key]));
                    return;
                }
                const act = t.closest('[data-act]');
                if (act && act.tagName !== 'INPUT') { const fn = actions[act.dataset.act]; if (fn && !act.disabled) { e.preventDefault(); fn(act.dataset.v); } return; }
                const set = t.closest('[data-set]');
                if (set) return touch(setByBind(set.dataset.set, JSON.parse(set.dataset.v)));
                if (inPop) return;
                const pi = t.closest('[data-pi]');
                if (pi) {
                    const item = palette[+pi.dataset.pi];
                    if (!state.sel || !state.sel.zone) {
                        if (state.sheet === 'A') { smartInsert('row', endRowIndex(), item.chip); return touch(EDIT + ' palette'); }
                        return toast('Primero haz clic en una celda o columna');
                    }
                    insertChip(state.sel.zone, item.chip, state.sel.ci != null ? state.sel.ci + 1 : null);
                    return touch(EDIT + ' palette');
                }
                const ci = t.closest('[data-ci]');
                if (ci) { select(ci.dataset.czone, +ci.dataset.ci); state.pop = { type: 'chip' }; return touch('canvas insp layer'); }
                const zone = t.closest('[data-zone]');
                if (zone) { select(zone.dataset.zone); state.pop = null; return touch('canvas insp layer'); }
                const cp = t.closest('[data-colpick]');
                if (cp) { select(cp.dataset.colpick); state.pop = null; return touch('canvas insp layer'); }
                const det = t.closest('.ss-group summary');
                if (det) { const g = det.parentElement.dataset.group; state.open[g] = !det.parentElement.open; return; }
                if (state.pop) { state.pop = null; renderLayer(); }
                if (t.closest('#ssCanvas') && !t.closest('.ss-paper') && state.sel) { state.sel = null; touch('canvas insp'); }
            });
            // Asas de la vista previa: ancho de columnas y tamaño de la tarjeta.
            rootEl.addEventListener('pointerdown', (e) => {
                const h = e.target.closest && e.target.closest('[data-resize]');
                if (!h || e.button !== 0) return;
                e.preventDefault();
                const [kind, idx] = h.dataset.resize.split(':');
                const t = tpl();
                const host = kind === 'tcol' ? h.closest('table') : kind === 'ccol' ? h.closest('.ss-rzhost') : h.closest('.ss-card');
                if (!host) return;
                commit();
                const boxW = host.getBoundingClientRect().width;
                const lay = SB.computeLayout(t.layout);
                const k = boxW / lay.cardWidth;
                const redraw = () => (state.printing ? renderPrintDesk() : renderCanvas());
                const start = { x: e.clientX, y: e.clientY, widths: kind === 'tcol' ? t.columns.map((c) => c.width || 1) : t.columns.slice(), w: lay.cardWidth, h: lay.cardHeight };
                const sumW = start.widths.reduce((a, b) => a + b, 0);
                const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
                let raf = 0;
                const move = (ev) => {
                    const dx = ev.clientX - start.x;
                    const dy = ev.clientY - start.y;
                    if (kind === 'tcol') {
                        const w = resizeColumns(start.widths, +idx, (dx / boxW) * sumW);
                        t.columns.forEach((c, i) => { c.width = w[i]; });
                    } else if (kind === 'ccol') {
                        t.columns = resizeColumns(start.widths, +idx, (dx / Math.max(1, boxW)) * sumW);
                    } else {
                        t.layout.mode = 'size';
                        t.layout.cardWidth = clamp(start.w + dx / k, 20, 300);
                        t.layout.cardHeight = clamp(start.h + dy / k, 15, 300);
                    }
                    if (!raf) raf = requestAnimationFrame(() => { raf = 0; redraw(); });
                };
                const up = () => {
                    document.removeEventListener('pointermove', move);
                    document.removeEventListener('pointerup', up);
                    rz = false;
                    rootEl.classList.remove('ss-resizing');
                    rootEl.style.cursor = '';
                    cancelAnimationFrame(raf);
                    touch(state.printing ? 'bar print' : 'bar canvas insp');
                };
                rz = true;
                rootEl.classList.add('ss-resizing');
                rootEl.style.cursor = getComputedStyle(h).cursor;
                document.addEventListener('pointermove', move);
                document.addEventListener('pointerup', up);
            });
            // En el documento: al redibujar, el foco puede quedar fuera del editor.
            document.addEventListener('keydown', (e) => {
                if (rootEl.hidden) return;
                const typing = isTyping(e.target);
                if ((e.ctrlKey || e.metaKey) && !typing && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); return doUndo(e.shiftKey ? 1 : -1); }
                if ((e.ctrlKey || e.metaKey) && !typing && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); return doUndo(1); }
                if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && selChip()) { e.preventDefault(); return actions['chip-del'](); }
                if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-pi],[data-ci],[data-zone],[data-fold]')) { e.preventDefault(); e.target.click(); }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    if ($('#ssVarsDialog')) return closeVariablesDialog();
                    if (state.drawer) actions['close-drawer']();
                    else if (state.pop) { state.pop = null; renderLayer(); }
                    else if (state.printing) actions['print-back']();
                    else api.close();
                }
            });
            rootEl.addEventListener('input', (e) => {
                const el = e.target;
                if (!el.dataset || !el.dataset.bind || el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio') return;
                const v = readInput(el);
                if (el.dataset.bind === 'chip.value' && el.dataset.type === 'number' && !Number.isFinite(v)) return;
                const parts = setByBind(el.dataset.bind, v);
                if (el.closest('.ss-printside')) return touch(parts ? 'bar desk' : '');
                // El panel que contiene el campo no se vuelve a dibujar, para no perder el foco.
                const holder = el.closest('#ssPop') ? 'layer' : el.closest('#ssInspector') ? 'insp' : el.closest('#ssPalette') ? 'palette' : '';
                touch(parts.split(' ').filter((p) => p !== holder).join(' '));
            });
            rootEl.addEventListener('change', (e) => {
                const el = e.target;
                if (el.id === 'ssVarEmployee') {
                    const v = state.store.variables.find(x => x.id === (state.variableEdit || $('#ssVarId')?.value));
                    const raw = v?.overrides?.[el.value];
                    $('#ssVarOverride').value = raw === undefined ? '' : String(raw);
                    return;
                }
                if (el.dataset && el.dataset.actChange === 'logo') {
                    const f = el.files && el.files[0];
                    if (!f) return;
                    if (f.size > 1.5e6) return toast('La imagen debe pesar menos de 1.5 MB');
                    const r = new FileReader();
                    r.onload = () => { state.store.logo = String(r.result); touch('canvas layer'); };
                    r.readAsDataURL(f);
                    return;
                }
                if (el.dataset && el.dataset.pick !== undefined) {
                    const id = employees.find((x) => String(x.id) === el.dataset.pick)?.id;
                    const ids = new Set(state.printOpts.ids);
                    if (el.checked) ids.add(id); else ids.delete(id);
                    state.printOpts.ids = employees.map((x) => x.id).filter((x) => ids.has(x));
                    return touch('print');
                }
                if (el.dataset && el.dataset.bind && (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio')) touch(setByBind(el.dataset.bind, readInput(el)));
            });
            // Arrastrar y soltar con el ratón
            rootEl.addEventListener('dragstart', (e) => {
                const t = e.target;
                if (rz) { e.preventDefault(); return; }
                const pi = t.closest && t.closest('[data-pi]');
                const ci = t.closest && t.closest('[data-ci]');
                const rowH = t.closest && t.closest('[data-rowdrag]');
                const colH = t.closest && t.closest('[data-coldrag]');
                if (pi) drag = { src: 'palette', pi: +pi.dataset.pi };
                else if (ci) { drag = { src: 'cell', zone: ci.dataset.czone, ci: +ci.dataset.ci }; ci.classList.add('dragging'); }
                else if (rowH) drag = { src: 'row', r: +rowH.dataset.rowdrag };
                else if (colH) drag = { src: 'colmove', i: +colH.dataset.coldrag };
                else return;
                state.pop = null; renderLayer();
                e.dataTransfer.effectAllowed = 'copyMove';
                e.dataTransfer.setData('text/plain', 'ss');
            });
            rootEl.addEventListener('dragover', (e) => {
                if (!drag) return;
                const target = dropTarget(e.target);
                clearOver();
                const okFor = {
                    palette: ['cell', 'row', 'col', 'title'], cell: ['cell'], row: ['row'], colmove: ['col']
                }[drag.src];
                if (target && okFor.includes(target.kind) && target.el) {
                    e.preventDefault();
                    target.el.classList.add('over');
                    setTrash(false);
                    return;
                }
                // Un chip sacado de una celda y soltado fuera de todas se elimina.
                if (drag.src === 'cell') { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setTrash(true); }
                else setTrash(false);
            });
            rootEl.addEventListener('drop', (e) => {
                if (!drag) return;
                e.preventDefault();
                const target = dropTarget(e.target);
                const d = drag;
                drag = null;
                setTrash(false); clearOver();
                const t = tpl();
                if (d.src === 'palette') {
                    const chip = palette[d.pi].chip;
                    if (!target) return;
                    if (target.kind === 'cell') {
                        const over = e.target.closest('[data-ci]');
                        insertChip(target.zone, chip, over ? +over.dataset.ci : null);
                    } else smartInsert(target.kind, target.at, chip);
                    return touch(EDIT + ' palette');
                }
                if (d.src === 'cell') {
                    if (!target || target.kind !== 'cell') {
                        commit();
                        const [gone] = cellOf(d.zone).chips.splice(d.ci, 1);
                        select(d.zone);
                        toast(`Se quitó “${chipLabel(gone)}”`, true);
                        return touch(EDIT);
                    }
                    commit();
                    const over = e.target.closest('[data-ci]');
                    let at = over ? +over.dataset.ci : null;
                    const [chip] = cellOf(d.zone).chips.splice(d.ci, 1);
                    if (d.zone === target.zone && at != null && d.ci < at) at -= 1;
                    const cell = cellOf(target.zone);
                    const idx = at == null ? cell.chips.length : at;
                    cell.chips.splice(idx, 0, chip);
                    select(target.zone, idx);
                    return touch(EDIT);
                }
                if (d.src === 'row' && target && target.kind === 'row') {
                    commit();
                    const [row] = t.rows.splice(d.r, 1);
                    const at = target.at > d.r ? target.at - 1 : target.at;
                    t.rows.splice(at, 0, row);
                    select(`A:${at}:0`);
                    return touch(EDIT);
                }
                if (d.src === 'colmove' && target && target.kind === 'col') {
                    commit();
                    const [col] = t.columns.splice(d.i, 1);
                    const at = target.at > d.i ? target.at - 1 : target.at;
                    t.columns.splice(at, 0, col);
                    select(`B:col:${at}`);
                    return touch(EDIT);
                }
            });
            rootEl.addEventListener('dragend', () => {
                drag = null; setTrash(false); clearOver();
                rootEl.querySelectorAll('.ss-chip.dragging').forEach((x) => x.classList.remove('dragging'));
            });
            rootEl.addEventListener('scroll', () => { if (state.pop) renderLayer(); }, true);
            window.addEventListener('resize', () => {
                clearTimeout(bindEvents.t);
                bindEvents.t = setTimeout(() => { if (!rootEl.hidden) touch(state.printing ? 'print' : 'canvas layer'); }, 150);
            });
        };

        const api = {
            open: () => {
                injectCss();
                rootEl.classList.add('ss');
                employees = opts.getEmployees() || [];
                if (state.printOpts.mode === 'custom') state.printOpts.ids = state.printOpts.ids.filter((id) => employees.some((e) => e.id === id));
                rebuildEngine();
                bindEvents();
                rootEl.hidden = false;
                document.body.style.overflow = 'hidden';
                // Si esta hoja ya se imprimió antes, la plantilla está lista: se abre en "Imprimir".
                state.printing = !!state.store.ready[state.sheet];
                state.tour = !state.store.tourDone && !state.printing ? 0 : null;
                renderShell();
                const first = rootEl.querySelector('[data-act="close"]');
                if (first) first.focus();
            },
            close: () => {
                rootEl.hidden = true;
                document.body.style.overflow = '';
                state.drawer = null; state.pop = null; state.printing = false;
                if (opts.onClose) opts.onClose();
            }
        };
        load();
        return api;
    };

    return {
        createStudio,
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
        MONEY_COLORS,
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
