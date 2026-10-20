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
        module.exports = factory(require('./SheetBuilder.js'), require('./SplitXSheetFields.js'));
    } else {
        root.SheetStudio = factory(root.SheetBuilder, root.SplitXSheetFields);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SB, SF) {
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
            { whenEmpty: 'hide', cells: [cT([F('loanBalanceAfter', 'label')], { size: 7.5 }), cN([F('loanBalanceAfter')], { size: 7.5 })] }
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
            { header: 'No.', width: 0.6, border: 'all', sum: false, cell: cT([F('no')]) },
            { header: 'Nombre', width: 2.2, border: 'all', sum: false, cell: cT([F('name')]) },
            { header: 'Días', width: 0.7, border: 'all', sum: true, cell: cN([F('days')]) },
            { header: 'Sueldo/día', width: 1, border: 'all', sum: false, cell: cN([F('dailyRate')]) },
            { header: 'Bruto + bonos', width: 1.2, border: 'all', sum: true, cell: cN([F('gross'), O('+'), F('bonuses')]) },
            { header: 'Monto entregado', width: 1.3, border: 'all', sum: true, cell: cN([F('afterDiscounts')], { bold: true }) },
            { header: 'Firma', width: 2.4, border: 'sign', sum: false, cell: cT([]) }
        ],
        options: { totals: true, signatures: true, rowHeight: 11 },
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

    /** Medidas de la hoja de firmas y cuántas filas caben por página (mm). */
    const tablePageGeometry = (t, hasLogo) => {
        const [w, h] = SB.PAPER_SIZES[t.layout.paper] || SB.PAPER_SIZES.letter;
        const landscape = t.layout.orientation === 'landscape';
        const pageWidth = landscape ? h : w;
        const pageHeight = landscape ? w : h;
        const margin = t.layout.margin || 0;
        const titleH = t.title.reduce((s, c) => s + (c.size || 10) * PT_MM * 1.45, 0);
        const headerH = Math.max(titleH, hasLogo ? 18 : 0) + 6;
        const avail = pageHeight - 2 * margin - headerH - 8 - (t.options.totals ? 8 : 0) - (t.options.signatures ? 18 : 0);
        const rowsPerPage = Math.max(1, Math.floor(avail / (t.options.rowHeight || 11)));
        return { pageWidth, pageHeight, margin, rowsPerPage };
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
        return out;
    };

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
.ss, #ss-print { --bonus:#059669; --deduction:#e11d48; --loan:#d97706; --solid-fg:#fff; --paper:#fff; --ink:#334155; --ink-strong:#0f172a; --paper-line:#94a3b8; }
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
.ss-stage { position:relative; padding:8px 44px 8px 40px; }
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
        ['Empleado', ['no', 'name', 'firstName', 'position', 'leader']],
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
    const DEFAULT_OPEN = { 'Usados recientemente': true, 'Conceptos importados': true, Montos: true, 'Préstamos y adelantos': true, Herramientas: true };

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
            printing: false, printOpts: { mode: 'all', ids: [], copies: 1 }, query: '', open: Object.assign({}, DEFAULT_OPEN), confirmDelete: false
        };
        const histories = new Map();
        let employees = []; let engine; let fieldSet; let palette = []; let drag = null; let bound = false; let lastCommit = { key: '', at: 0 };

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
            engine = SB.createEngine({ fields: fieldSet.fields, resolveField: fieldSet.resolveField, locale: opts.locale || 'en-US', decimals: 2 });
            palette = [];
            const byKey = new Map(fieldSet.fields.map((f) => [f.key, f]));
            for (const c of fieldSet.listConcepts()) palette.push({ group: 'Conceptos importados', label: c.label, chip: F(c.key) });
            for (const [group, keys] of GROUPS) for (const k of keys) if (byKey.has(k)) palette.push({ group, label: byKey.get(k).label, chip: F(k) });
            for (const t of TOOLS) palette.push({ group: 'Herramientas', label: t.label, chip: t.chip });
            palette.forEach((p) => { p.sig = JSON.stringify(p.chip); });
        };

        const fieldDef = (key) => { try { return engine.requireField(key); } catch (e) { return null; } };
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
        const outHTML = (res, cell, k) => {
            const cat = cellCat(cell);
            const align = cell.align || (cell.mode === 'number' ? 'right' : 'left');
            const style = `text-align:${align};font-weight:${cell.bold ? 700 : 400};${cell.size ? `font-size:${cell.size * PT_MM * k}px;` : ''}`;
            if (res.error) return `<span class="ss-out err" title="${esc(res.error)}" style="${style}">—</span>`;
            const cls = ['ss-out', cell.mode === 'number' ? 'n' : '', cat && cat !== 'field' ? 'c-' + cat : ''].join(' ');
            return `<span class="${cls}" style="${style}">${esc(res.text)}</span>`;
        };
        const gridCols = (cols) => cols.map((w) => `${w}fr`).join(' ');
        const cardInner = (rowResults, cols, k) => rowResults.filter((r) => !r.hidden).map((r) =>
            `<div class="ss-crow${r.row.lineAbove ? ' line' : ''}" style="grid-template-columns:${gridCols(cols)}">${r.cells.map((c) => outHTML(c, c.cell, k)).join('')}</div>`).join('');
        const cardStyle = (w, h, k) => `width:${w * k}px;height:${h * k}px;padding:${2.5 * k}px ${3 * k}px;font-size:${8.5 * PT_MM * k}px;gap:${0.6 * k}px;`;

        const tableHTML = (t, items, k, withTotals, total) => {
            const sumW = t.columns.reduce((s, c) => s + (c.width || 1), 0);
            const rowH = (t.options.rowHeight || 11) * k;
            const cells = t.columns.map((c) => c.cell);
            const head = `<thead><tr>${t.columns.map((c) => `<th class="${c.border === 'none' ? 'b-none' : 'b-all'}" style="text-align:${c.cell.align || (c.cell.mode === 'number' ? 'right' : 'left')}">${esc(c.header)}</th>`).join('')}</tr></thead>`;
            const body = items.map(({ record, ctx }) => {
                const res = engine.evaluateRows([{ cells }], record, ctx)[0].cells;
                return `<tr style="height:${rowH}px">${t.columns.map((c, i) => (c.border === 'sign'
                    ? `<td class="b-sign">${c.cell.chips.length ? outHTML(res[i], c.cell, k) : ''}<div class="sline"></div></td>`
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
                        ${cards.map((rows) => `<div class="ss-card${tpl().layout.cutMarks ? ' cut' : ''}${state.store.colors ? '' : ' mono-ink'}" style="${cardStyle(lay.cardWidth, lay.cardHeight, k)}">${cardInner(rows, tpl().columns, k)}</div>`).join('')}
                      </div></div>${forPrint ? '' : `<div class="ss-page-no">Hoja ${p + 1} de ${out.pages.length}</div>`}`).join('');
            }
            const t = tpl();
            const g = tablePageGeometry(t, !!state.store.logo);
            const items = sorted(list, t.sortBy);
            const pages = SB.paginate(items, g.rowsPerPage);
            if (!pages.length) pages.push([]);
            const first = items[0];
            const titleRes = first ? engine.evaluateRows(t.title.map((c) => ({ cells: [c] })), first.record, first.ctx) : [];
            return pages.map((rows, p) => `
                <div class="ss-page" style="width:${g.pageWidth * k}px;height:${g.pageHeight * k}px;padding:${g.margin * k}px;display:flex;flex-direction:column;font-size:${9 * PT_MM * k}px">
                  <div class="ss-sig-head">
                    ${state.store.logo ? `<img src="${state.store.logo}" alt="Logo" style="width:${18 * k}px;height:${18 * k}px">` : ''}
                    <div style="flex:1;display:flex;flex-direction:column;gap:${0.6 * k}px">${titleRes.map((r) => `<div style="display:grid">${outHTML(r.cells[0], r.cells[0].cell, k)}</div>`).join('')}</div>
                    <div style="color:#64748b;text-align:right">Hoja ${p + 1} de ${pages.length}</div>
                  </div>
                  ${tableHTML(t, rows, k, t.options.totals && p === pages.length - 1 ? items : null, items.length)}
                  ${t.options.signatures ? `<div class="ss-sig-foot" style="padding-top:${10 * k}px"><div>Entregado por</div><div>Revisado por</div></div>` : ''}
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
              <div id="ssLayer"></div><div id="ssDrawer"></div><div id="ssToast"></div>
              <div class="ss-trash" aria-hidden="true">Suelta para quitar el chip</div>`;
            renderBar();
            if (state.printing) renderPrintStep();
            else { renderPageBar(); renderPalette(); renderCanvas(); renderInspector(); }
            renderLayer();
        };

        const renderBar = () => {
            const el = $('#ssBar');
            if (!el) return;
            const h = history();
            el.innerHTML = state.printing
                ? `<button class="ss-btn" type="button" data-act="print-back">← Volver a editar</button>
                   <span class="ss-title">Imprimir · ${esc(activeEntry().name)}</span><div class="ss-grow"></div>
                   <button class="ss-btn ghost" type="button" data-act="close">Cerrar ✕</button>`
                : `<span class="ss-title">Hojas imprimibles</span>
                   <div class="ss-seg" role="group" aria-label="Tipo de hoja">
                     <button type="button" data-act="sheet" data-v="A" aria-pressed="${state.sheet === 'A'}">Tarjeta del sobre</button>
                     <button type="button" data-act="sheet" data-v="B" aria-pressed="${state.sheet === 'B'}">Hoja de firmas</button>
                   </div>
                   <button class="ss-btn ss-tplbtn" type="button" data-pop="tpl" id="ssTplBtn" title="Plantillas guardadas">📄 ${esc(activeEntry().name)} ▾</button>
                   <div class="ss-grow"></div>
                   <button class="ss-btn ghost" type="button" data-act="undo" ${h.canUndo() ? '' : 'disabled'} title="Deshacer (Ctrl+Z)">↶ Deshacer</button>
                   <button class="ss-btn ghost" type="button" data-act="redo" ${h.canRedo() ? '' : 'disabled'} title="Rehacer (Ctrl+Y)">↷ Rehacer</button>
                   <button class="ss-btn primary" type="button" data-act="print-step">Imprimir…</button>
                   <button class="ss-btn ghost" type="button" data-act="close" aria-label="Cerrar hojas imprimibles">Cerrar ✕</button>`;
        };

        const renderPageBar = () => {
            const el = $('#ssPageBar');
            if (!el) return;
            el.innerHTML = `<span>Hoja:</span><button class="ss-btn sm" type="button" data-pop="page" id="ssPageBtn">${esc(pageSummary(tpl()))} ▾</button>
              <label class="ss-check" style="font-size:12px"><input id="ssColors" type="checkbox" data-bind="colors" ${state.store.colors ? 'checked' : ''}> Montos a color</label>
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
            el.innerHTML = `<div class="ss-search"><input id="ssSearch" class="ss-inp" type="search" placeholder="Buscar chip…" value="${esc(q)}" data-bind="query" aria-label="Buscar chip"></div>
              ${groups.length ? groups.map((g) => `<details class="ss-group" data-group="${esc(g.name)}" ${q || state.open[g.name] ? 'open' : ''}>
                <summary>${esc(g.name)} <span class="count">${g.items.length}</span></summary><div class="ss-chips">${g.items.join('')}</div></details>`).join('')
                : '<p class="ss-hint">Ningún chip coincide.</p>'}
              <p class="ss-hint" style="margin-top:auto">Suelta un campo <strong>sobre la tarjeta</strong> para crear su fila completa, o <strong>dentro de una celda</strong> para armar una fórmula.</p>`;
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
                : (cell.chips.length ? outHTML(res, cell, k) : empty);
            return `<div class="ss-cell${isSel && state.sel.ci == null ? ' sel' : ''}${showChips ? ' chipview' : ''}" data-zone="${zone}" tabindex="0" role="button" aria-label="Celda">${inner}</div>`;
        };

        const renderCanvas = () => {
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
                    <div class="ss-insert" data-insert="${r}"></div>
                    <div class="ss-erow${row.lineAbove ? ' line' : ''}${res[r].hidden && !state.formulas ? ' ghost' : ''}${rowSel === r ? ' row-sel' : ''}" data-row="${r}" style="grid-template-columns:${gridCols(t.columns)}">
                      <span class="ss-handle" draggable="true" data-rowdrag="${r}" title="Arrastra para mover la fila" aria-hidden="true">⋮⋮</span>
                      ${row.cells.map((cell, c) => cellHTML(`A:${r}:${c}`, cell, res[r].cells[c], k)).join('')}
                      <button class="ss-rowmenu" type="button" data-pop="row" data-v="${r}" id="ssRowMenu${r}" aria-label="Opciones de la fila ${r + 1}">⋯</button>
                      ${res[r].hidden && !state.formulas ? '<span class="ss-ghost-tag">oculta para este empleado</span>' : ''}
                    </div>`).join('');
                el.innerHTML = `${tools}
                  <div class="ss-stage" data-stage="end">
                    <div class="ss-paper ss-cardedit${state.store.colors ? '' : ' mono-ink'}" id="ssCardEdit" style="width:${lay.cardWidth * k}px;min-height:${lay.cardHeight * k}px;padding:${2.5 * k}px ${3 * k}px;font-size:${8.5 * PT_MM * k}px;gap:${0.6 * k}px">
                      ${rows}<div class="ss-insert" data-insert="${t.rows.length}"></div>
                      <div class="ss-limit" style="top:${lay.cardHeight * k}px"><span>límite de la tarjeta</span></div>
                    </div>
                    <div class="ss-dropzone" data-insert="end">
                      <span>Suelta aquí un campo para agregar su fila “Concepto | Monto”</span>
                      <button class="ss-btn sm" type="button" data-act="add-row">+ Fila vacía</button>
                    </div>
                  </div><div id="ssCanvasWarn"></div>`;
                const info = $('#ssCanvasInfo');
                if (info) info.textContent = `Tarjeta de ${Math.round(lay.cardWidth)} × ${Math.round(lay.cardHeight)} mm`;
                requestAnimationFrame(() => {
                    const card = $('#ssCardEdit'); const warn = $('#ssCanvasWarn');
                    const rowEls = card ? card.querySelectorAll('.ss-erow:not(.ghost)') : [];
                    const last = rowEls[rowEls.length - 1];
                    const overflow = !!last && last.offsetTop + last.offsetHeight > (lay.cardHeight - 2.5) * k + 1;
                    if (card && warn) warn.innerHTML = overflow ? '<p class="ss-warn">El contenido pasa del límite de la tarjeta: quita filas, reduce la letra o agranda la tarjeta en la barra “Hoja”.</p>' : '';
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
                const head = `<thead><tr>${t.columns.map((c, i) => `<th class="${c.border === 'none' ? 'b-none' : 'b-all'}${colSel === i ? ' col-sel' : ''}" draggable="true" data-coldrag="${i}" data-colpick="B:col:${i}" style="text-align:${c.cell.align || (c.cell.mode === 'number' ? 'right' : 'left')}" title="Clic para editar · arrastra para mover">${esc(c.header) || '<span style="opacity:.5">(sin título)</span>'}</th>`).join('')}</tr></thead>`;
                const sample = state.formulas ? first.slice(0, 1) : first.slice(0, 5);
                const body = sample.map(({ record, ctx: cx }, ri) => {
                    const res = engine.evaluateRows([{ cells }], record, cx)[0].cells;
                    return `<tr style="height:${(t.options.rowHeight || 11) * k}px">${t.columns.map((c, i) => {
                        const cls = `${c.border === 'sign' ? 'b-sign' : c.border === 'none' ? 'b-none' : 'b-all'}${colSel === i ? ' col-sel' : ''}`;
                        const zone = `B:col:${i}`;
                        const content = ri === 0 || state.formulas ? cellHTML(zone, c.cell, res[i], k) : `<div data-colpick="${zone}" style="cursor:pointer">${c.cell.chips.length ? outHTML(res[i], c.cell, k) : '&nbsp;'}</div>`;
                        return `<td class="${cls}">${content}${c.border === 'sign' ? '<div class="sline"></div>' : ''}</td>`;
                    }).join('')}</tr>`;
                }).join('');
                el.innerHTML = `${tools}
                  <div class="ss-stage">
                    <div class="ss-paper ss-sheetedit${state.store.colors ? '' : ' mono-ink'}" style="width:${g.pageWidth * k}px;font-size:${9 * PT_MM * k}px">
                      <div class="ss-titles">${titles}
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

        const renderInspector = () => {
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
                        <p class="ss-hint">• Haz clic en un encabezado o una celda para editar esa columna.</p>
                        <p class="ss-hint">• Arrastra los encabezados para reordenar columnas.</p></div>
                       <div class="ss-sec"><h3 class="ss-lbl">Tabla</h3>
                        <label class="ss-check"><input id="ssTotals" type="checkbox" data-bind="opt.totals" ${tpl().options.totals ? 'checked' : ''}> Fila de totales al final</label>
                        <label class="ss-check"><input id="ssSigs" type="checkbox" data-bind="opt.signatures" ${tpl().options.signatures ? 'checked' : ''}> “Entregado por / Revisado por” al pie</label></div>`;
                return;
            }
            const zone = state.sel.zone;
            const isTitle = zone.startsWith('B:title');
            let html = '';
            if (state.sheet === 'A') {
                const r = zoneIndex(zone, 1);
                const c = zoneIndex(zone, 2);
                const row = tpl().rows[r];
                html += `<div class="ss-sec"><h3 class="ss-lbl">Fila ${r + 1} · celda ${c + 1}</h3>${chipStripHTML(zone, cell)}${cellProps(cell, false)}</div>
                  <div class="ss-sec"><h3 class="ss-lbl">Fila ${r + 1}</h3>
                    <div class="ss-field">Si sus montos están vacíos o en 0 ${segHTML('row.whenEmpty', row.whenEmpty || 'show', [['show', 'Mostrar'], ['dash', 'Guion “-”'], ['hide', 'Ocultar fila']])}</div>
                    <label class="ss-check"><input id="ssLine" type="checkbox" data-bind="row.lineAbove" ${row.lineAbove ? 'checked' : ''}> Línea separadora encima</label></div>${cardSection()}`;
            } else if (isTitle) {
                html += `<div class="ss-sec"><h3 class="ss-lbl">Línea ${zoneIndex(zone, 2) + 1} del encabezado</h3>${chipStripHTML(zone, cell)}${cellProps(cell, true)}</div>`;
            } else {
                const i = zoneIndex(zone, 2);
                const col = tpl().columns[i];
                html += `<div class="ss-sec"><h3 class="ss-lbl">Columna ${i + 1}</h3>
                    <label class="ss-field">Encabezado<input id="ssHeader" class="ss-inp" data-bind="col.header" value="${esc(col.header)}" maxlength="60"></label>
                    ${chipStripHTML(zone, cell)}
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
                  <label class="ss-check"><input id="ssCut" type="checkbox" data-bind="lay.cutMarks" ${L.cutMarks ? 'checked' : ''}> Líneas de corte punteadas</label>`;
            } else {
                html += `<div class="ss-grid2"><label class="ss-field">Margen (mm)<input id="ssMargin" class="ss-inp ss-num" type="number" min="0" max="40" data-bind="lay.margin" data-type="number" value="${esc(L.margin)}"></label>
                  <label class="ss-field">Alto de fila (mm)<input id="ssRowH" class="ss-inp ss-num" type="number" min="6" max="30" step="0.5" data-bind="opt.rowHeight" data-type="number" value="${esc(t.options.rowHeight)}"></label></div>
                  <label class="ss-field">Logo (imagen)<input id="ssLogo" class="ss-inp" type="file" accept="image/*" data-act-change="logo"></label>
                  ${state.store.logo ? '<button class="ss-btn sm" type="button" data-act="logo-del">Quitar logo</button>' : ''}`;
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
        const renderPrintStep = () => {
            const el = $('#ssPrint');
            if (!el) return;
            const o = state.printOpts;
            const count = (mode) => selectEmployees(employees, { mode, ids: o.ids }).length;
            const radio = (mode, label) => `<label class="ss-radio${o.mode === mode ? ' on' : ''}"><input type="radio" name="ssWho" data-bind="print.mode" value="${mode}" ${o.mode === mode ? 'checked' : ''}> ${label}<span class="n">${count(mode)}</span></label>`;
            const list = printList();
            let summary;
            if (state.sheet === 'A') {
                const lay = SB.computeLayout(tpl().layout);
                const pages = Math.ceil(list.length / lay.perPage);
                summary = `${list.length} tarjeta${list.length === 1 ? '' : 's'} · ${lay.perPage} por hoja → <strong>${pages} hoja${pages === 1 ? '' : 's'}</strong>`;
            } else {
                const pages = Math.max(1, Math.ceil(list.length / tablePageGeometry(tpl(), !!state.store.logo).rowsPerPage));
                summary = `${list.length} empleado${list.length === 1 ? '' : 's'} → <strong>${pages} hoja${pages === 1 ? '' : 's'}</strong>`;
            }
            el.innerHTML = `<aside class="ss-printside">
                <div class="ss-sec"><h3 class="ss-lbl">¿A quién?</h3>
                  ${radio('all', 'Todos los empleados')}${radio('unpaid', 'Solo los no pagados')}${radio('loan', 'Solo con préstamo o adelanto')}${radio('custom', 'Elegir…')}
                  ${o.mode === 'custom' ? `<div class="ss-row-btns"><button class="ss-btn sm" type="button" data-act="pick-all">Todos</button><button class="ss-btn sm" type="button" data-act="pick-none">Ninguno</button></div>
                    <div class="ss-emplist">${employees.map((e) => `<label><input type="checkbox" data-pick="${esc(e.id)}" ${o.ids.includes(e.id) ? 'checked' : ''}> ${esc(e.employeeNumber || '')} ${esc(e.employeeName || e.name)}</label>`).join('')}</div>` : ''}</div>
                ${state.sheet === 'A' ? `<div class="ss-sec"><h3 class="ss-lbl">Copias</h3><div class="ss-field">Tarjetas por empleado ${segHTML('print.copies', o.copies, [[1, '1'], [2, '2'], [3, '3']])}</div></div>` : ''}
                <div class="ss-sec"><h3 class="ss-lbl">Hoja</h3><p class="ss-hint">${esc(pageSummary(tpl()))}</p><p class="ss-hint">${summary}</p></div>
                <button class="ss-btn primary ss-big" type="button" data-act="print" ${list.length ? '' : 'disabled'}>🖨 Imprimir</button>
                <p class="ss-hint">Se abre el diálogo de impresión: elige tu impresora o “Guardar como PDF”, con márgenes “Ninguno” y escala 100%.</p>
              </aside>
              <section class="ss-printpages" id="ssPrintPages"><div class="ss-desk" id="ssDesk"></div></section>`;
            const desk = $('#ssDesk');
            const L = tpl().layout;
            const [w, h] = SB.PAPER_SIZES[L.paper] || SB.PAPER_SIZES.letter;
            const pw = L.orientation === 'landscape' ? h : w;
            const avail = Math.max(280, ($('#ssPrintPages').clientWidth || 800) - 60);
            desk.innerHTML = list.length ? pagesHTML(Math.min(2.4, avail / pw), false) : '<p class="ss-hint">No hay empleados seleccionados.</p>';
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
            if (p.includes('insp')) renderInspector();
            if (p.includes('print')) renderPrintStep();
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
                    t.options[key] = key === 'rowHeight' ? Math.max(6, value || 11) : value;
                    return 'bar canvas pagebar';
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
            const done = () => { document.body.classList.remove('ss-printing'); host.innerHTML = ''; window.removeEventListener('afterprint', done); };
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
            sheet: (v) => { state.sheet = v; state.sel = null; state.pop = null; touch(); },
            close: () => api.close(),
            undo: () => doUndo(-1),
            redo: () => doUndo(1),
            'print-step': () => { state.printing = true; state.pop = null; touch(); },
            'print-back': () => { state.printing = false; touch(); },
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
            'tpl-new': () => {
                const entry = { id: newId(), name: state.sheet === 'A' ? 'Nueva tarjeta' : 'Nueva hoja de firmas', template: state.sheet === 'A' ? defaultCardTemplate() : defaultTableTemplate() };
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
                    if (type === 'row' && !same) select(`A:${v}:0`);
                    if (type === 'title' && !same) select(`B:title:${v}`);
                    return touch(type === 'row' || type === 'title' ? 'canvas insp layer' : 'layer');
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
            // En el documento: al redibujar, el foco puede quedar fuera del editor.
            document.addEventListener('keydown', (e) => {
                if (rootEl.hidden) return;
                const typing = isTyping(e.target);
                if ((e.ctrlKey || e.metaKey) && !typing && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); return doUndo(e.shiftKey ? 1 : -1); }
                if ((e.ctrlKey || e.metaKey) && !typing && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); return doUndo(1); }
                if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && selChip()) { e.preventDefault(); return actions['chip-del'](); }
                if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-pi],[data-ci],[data-zone]')) { e.preventDefault(); e.target.click(); }
                if (e.key === 'Escape') {
                    e.preventDefault();
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
                // El panel que contiene el campo no se vuelve a dibujar, para no perder el foco.
                const holder = el.closest('#ssPop') ? 'layer' : el.closest('#ssInspector') ? 'insp' : el.closest('#ssPalette') ? 'palette' : '';
                touch(parts.split(' ').filter((p) => p !== holder).join(' '));
            });
            rootEl.addEventListener('change', (e) => {
                const el = e.target;
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
        columnTotals,
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
