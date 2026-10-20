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
    const STORE_KEY = 'Split_sheets_v1';

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

    // ─── Estilos (se inyectan una vez) ─────────────────────────────────────
    const CSS = `
.ss { --bg:#f8fafc; --surface:#fff; --surface-2:#f1f5f9; --fg:#1e293b; --strong:#0f172a; --muted:#475569; --faint:#64748b;
  --border:#e2e8f0; --border-strong:#cbd5e1; --accent:#2563eb; --accent-fg:#fff; --accent-soft:#eff6ff;
  --indigo:#4f46e5; --indigo-soft:#eef2ff; --indigo-fg:#4338ca; --field-bg:#eff6ff; --field-fg:#1d4ed8; --field-bd:#bfdbfe;
  --text-bg:#f1f5f9; --text-fg:#334155; --text-bd:#94a3b8; --numchip-bg:#fffbeb; --numchip-fg:#92400e; --numchip-bd:#fcd34d;
  --run-bg:#f0fdf4; --run-fg:#166534; --run-bd:#bbf7d0; --sel:#2563eb; --warn-bg:#fffbeb; --warn-fg:#92400e; --warn-bd:#fde68a;
  --err:#e11d48; --desk:#e2e8f0;
  position:fixed; inset:0; z-index:60; overflow-y:auto; background:var(--bg); color:var(--fg); font-family:Inter,system-ui,sans-serif; font-size:14px; }
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
.ss :focus-visible { outline:2px solid var(--sel); outline-offset:2px; }
.ss-bar { position:sticky; top:0; z-index:5; background:var(--surface); border-bottom:1px solid var(--border); padding:10px 16px; display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px; }
.ss-title { font-weight:800; font-size:17px; color:var(--strong); display:flex; align-items:center; gap:8px; }
.ss-grow { flex-grow:1; }
.ss-seg { display:inline-flex; gap:3px; background:var(--surface-2); padding:3px; border-radius:9px; flex-wrap:wrap; }
.ss-seg button { border:0; background:transparent; color:var(--muted); font-weight:500; font-size:13px; padding:7px 12px; border-radius:7px; min-height:34px; }
.ss-seg button[aria-pressed="true"] { background:var(--surface); color:var(--strong); font-weight:600; box-shadow:0 1px 2px rgba(15,23,42,.12); }
.ss-seg.sm button { font-size:12px; padding:5px 9px; min-height:30px; }
.ss-btn { border:1px solid var(--border-strong); background:var(--surface); color:var(--fg); font-weight:600; font-size:13px; padding:8px 12px; border-radius:8px; min-height:38px; display:inline-flex; align-items:center; gap:6px; }
.ss-btn:hover { border-color:var(--accent); }
.ss-btn.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
.ss-btn.danger { color:var(--err); }
.ss-btn.sm { font-size:12px; padding:5px 9px; min-height:32px; }
.ss-wrap { padding:16px; max-width:1600px; margin:0 auto; }
.ss-cols { display:flex; flex-wrap:wrap; gap:16px; align-items:flex-start; }
.ss-panel { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:14px; display:flex; flex-direction:column; gap:12px; min-width:0; }
.ss-palette { flex:1 1 240px; max-width:290px; }
.ss-center { flex:999 1 520px; min-width:0; display:flex; flex-direction:column; gap:14px; }
.ss-side { flex:1 1 300px; max-width:380px; display:flex; flex-direction:column; gap:14px; min-width:0; }
@media (max-width:760px) { .ss-palette, .ss-side { max-width:none; } }
.ss-lbl { margin:0; font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
.ss-hint { margin:0; font-size:12px; line-height:1.5; color:var(--muted); }
.ss-note { font-size:12px; line-height:1.5; background:var(--warn-bg); color:var(--warn-fg); border:1px solid var(--warn-bd); border-radius:10px; padding:9px 11px; }
.ss-field { display:flex; flex-direction:column; gap:5px; font-size:12px; font-weight:600; color:var(--muted); }
.ss-inp { border:1px solid var(--border-strong); background:var(--surface); border-radius:8px; padding:7px 9px; font-weight:500; font-size:13px; color:var(--fg); min-height:36px; width:100%; }
.ss-num { font-family:'JetBrains Mono',ui-monospace,monospace; font-variant-numeric:tabular-nums; }
.ss-grid2 { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.ss-check { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--fg); }
.ss-check input { width:16px; height:16px; accent-color:var(--accent); }
.ss-group { display:flex; flex-direction:column; gap:6px; }
.ss-group-t { font-size:12px; font-weight:600; color:var(--fg); }
.ss-chips { display:flex; flex-wrap:wrap; gap:6px; }
.ss-chip { display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:600; line-height:1.2; padding:5px 9px; border-radius:999px; border:1px solid transparent; user-select:none; cursor:grab; white-space:nowrap; }
.ss-chip.k-field { background:var(--field-bg); color:var(--field-fg); border-color:var(--field-bd); }
.ss-chip.k-bonus { background:var(--bonus); color:var(--solid-fg); border-color:var(--bonus); font-weight:700; }
.ss-chip.k-deduction { background:var(--deduction); color:var(--solid-fg); border-color:var(--deduction); font-weight:700; }
.ss-chip.k-loan { background:var(--loan); color:var(--solid-fg); border-color:var(--loan); font-weight:700; }
.ss-chip.k-op { background:var(--indigo-soft); color:var(--indigo-fg); border-color:var(--indigo); border-radius:6px; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:13px; padding:4px 10px; }
.ss-chip.k-text { background:var(--text-bg); color:var(--text-fg); border:1px dashed var(--text-bd); border-radius:6px; font-weight:500; }
.ss-chip.k-number { background:var(--numchip-bg); color:var(--numchip-fg); border:1px dashed var(--numchip-bd); border-radius:6px; font-family:'JetBrains Mono',ui-monospace,monospace; }
.ss-chip.k-running { background:var(--run-bg); color:var(--run-fg); border-color:var(--run-bd); border-radius:6px; font-weight:700; }
.ss-chip .as { font-size:9px; font-weight:800; letter-spacing:.04em; padding:1px 4px; border-radius:4px; background:rgba(255,255,255,.28); }
.ss-chip.k-field .as { background:var(--field-bd); }
.ss-chip.is-sel { outline:2px solid var(--sel); outline-offset:2px; }
.ss-chip.bad { outline:2px dashed var(--err); }
.ss-chip.dragging { opacity:.35; }
.ss-gridbox { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:8px; overflow-x:auto; }
.ss-erow { display:flex; gap:8px; align-items:stretch; min-width:420px; }
.ss-erow.line { border-top:2px solid var(--border-strong); padding-top:8px; }
.ss-rowtag { width:26px; flex:none; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; color:var(--faint); }
.ss-ecell { flex:1; min-width:0; border:1.5px dashed var(--border-strong); border-radius:9px; padding:7px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; background:var(--bg); min-height:44px; cursor:pointer; }
.ss-ecell.is-sel { border-style:solid; border-color:var(--sel); background:var(--accent-soft); }
.ss-ecell.over { border-color:var(--sel); border-style:solid; }
.ss-mode { font-size:9.5px; font-weight:800; letter-spacing:.05em; color:var(--faint); background:var(--surface-2); padding:2px 6px; border-radius:4px; }
.ss-empty-tag { font-size:10.5px; font-weight:700; padding:3px 6px; border-radius:6px; align-self:center; white-space:nowrap; color:var(--warn-fg); background:var(--warn-bg); }
.ss-placeholder { font-size:12px; color:var(--faint); font-style:italic; }
.ss-toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.ss-toolbar h2 { margin:0; font-size:16px; font-weight:700; color:var(--strong); }
.ss-sec { display:flex; flex-direction:column; gap:10px; padding-top:10px; border-top:1px solid var(--border); }
.ss-sec:first-of-type { border-top:0; padding-top:0; }
.ss-row-btns { display:flex; flex-wrap:wrap; gap:6px; }
.ss-colcards { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; }
.ss-colcard { flex:0 0 auto; width:170px; border:1.5px solid var(--border); border-radius:10px; padding:8px; display:flex; flex-direction:column; gap:7px; background:var(--surface); cursor:pointer; }
.ss-colcard.is-sel { border-color:var(--sel); }
.ss-colcard .hdr { font-size:13px; font-weight:700; color:var(--strong); border-bottom:1px solid var(--border); padding-bottom:5px; overflow-wrap:anywhere; }
.ss-colcard .meta { font-size:11px; color:var(--muted); }
.ss-emp-nav { display:flex; gap:6px; align-items:center; }
.ss-emp-nav select { flex:1; min-width:0; }
.ss-desk { background:var(--desk); border-radius:12px; padding:16px; display:flex; flex-direction:column; align-items:center; gap:16px; overflow-x:auto; }
.ss-page-no { font-size:11px; color:var(--faint); }
.ss-overflow { font-size:12px; color:var(--err); font-weight:600; }
.ss-msg-err { color:var(--err); font-size:13px; font-weight:600; white-space:pre-line; }
.ss-msg-ok { color:var(--bonus); font-size:13px; font-weight:600; }
.ss-scrim { position:fixed; inset:0; background:rgba(15,23,42,.45); z-index:70; display:flex; justify-content:flex-end; }
.ss-drawer { background:var(--surface); width:min(560px,100%); height:100%; overflow-y:auto; display:flex; flex-direction:column; gap:12px; padding:18px; }
.ss-drawer textarea { width:100%; min-height:300px; border:1px solid var(--border-strong); background:var(--bg); border-radius:10px; padding:10px; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:12px; color:var(--fg); }
.ss-toast, .ss-trash { position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:80; padding:10px 14px; border-radius:10px; font-size:13px; font-weight:600; max-width:calc(100% - 32px); }
.ss-toast { background:var(--strong); color:var(--bg); }
.ss-trash { background:var(--deduction); color:var(--solid-fg); font-size:14px; padding:12px 18px; pointer-events:none; display:none; }
.ss.trashing .ss-trash { display:block; }
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
        ['Empleado', ['no', 'name', 'firstName', 'position', 'leader']],
        ['Días', ['days', 'daysRegular', 'daysOvertime', 'daysHoliday', 'daysRest']],
        ['Montos', ['gross', 'dailyRate', 'bonuses', 'discounts', 'afterDiscounts', 'net']],
        ['Préstamos y adelantos', ['loans', 'loanPrincipal', 'loanInterest', 'loanBalanceBefore', 'loanBalanceAfter']],
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
        const state = { sheet: 'A', view: 'edit', preview: 0, colors: true, A: defaultCardTemplate(), B: defaultTableTemplate(), sel: null, logo: null, drawer: null };
        let employees = [];
        let engine; let fieldSet; let palette = []; let drag = null; let bound = false;

        const $ = (sel) => rootEl.querySelector(sel);

        // Persistencia de plantillas
        const save = () => storage.set(STORE_KEY, JSON.stringify({ A: state.A, B: state.B, colors: state.colors, logo: state.logo }));
        const load = () => {
            try {
                const raw = storage.get(STORE_KEY);
                if (!raw) return;
                const d = JSON.parse(raw);
                if (d.A && !SB.validateTemplate(d.A).errors.length) state.A = d.A;
                if (d.B && !validateTableTemplate(d.B).length) state.B = d.B;
                if (typeof d.colors === 'boolean') state.colors = d.colors;
                if (typeof d.logo === 'string' && d.logo.startsWith('data:image/')) state.logo = d.logo;
            } catch (e) { /* plantillas dañadas: se usan las de ejemplo */ }
        };

        const rebuildEngine = () => {
            fieldSet = SF.createFieldSet({ records: employees, getNetAmount: opts.getNetAmount });
            engine = SB.createEngine({ fields: fieldSet.fields, resolveField: fieldSet.resolveField, locale: opts.locale || 'en-US', decimals: 2 });
            palette = [];
            const byKey = new Map(fieldSet.fields.map((f) => [f.key, f]));
            for (const [group, keys] of GROUPS) for (const k of keys) if (byKey.has(k)) palette.push({ group, label: byKey.get(k).label, chip: F(k) });
            for (const c of fieldSet.listConcepts()) palette.push({ group: 'Conceptos importados', label: c.label, chip: F(c.key) });
            for (const t of TOOLS) palette.push({ group: 'Herramientas', label: t.label, chip: t.chip });
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
        const chipHTML = (chip, attrs, selected) => {
            const bad = chip.kind === 'field' && !fieldDef(chip.key);
            const as = chip.kind === 'field' && chip.as === 'label' ? '<span class="as">NOMBRE</span>' : '';
            return `<span class="ss-chip ${chipClass(chip)}${selected ? ' is-sel' : ''}${bad ? ' bad' : ''}" draggable="true" tabindex="0" role="button" ${attrs}>${as}${esc(chipLabel(chip))}</span>`;
        };

        // Selección: zone = "A:r:c" | "B:col:i" | "B:title:i"
        const cellOf = (zone) => {
            const [s, a, b] = zone.split(':');
            if (s === 'A') return state.A.rows[+a] && state.A.rows[+a].cells[+b];
            if (a === 'col') return state.B.columns[+b] && state.B.columns[+b].cell;
            return state.B.title[+b];
        };
        const selCell = () => (state.sel && state.sel.zone ? cellOf(state.sel.zone) : null);
        const selChip = () => { const c = selCell(); return c && state.sel.ci != null ? c.chips[state.sel.ci] : null; };
        const select = (zone, ci) => { state.sel = { zone, ci: ci ?? null }; };
        const sorted = (sortBy) => { try { return engine.sortRecords(employees, sortBy); } catch (e) { return engine.sortRecords(employees, undefined); } };

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
        const cardInner = (rowResults, cols, k) => rowResults.filter((r) => !r.hidden).map((r) =>
            `<div class="ss-crow${r.row.lineAbove ? ' line' : ''}" style="grid-template-columns:${cols.map((w) => `${w}fr`).join(' ')}">${r.cells.map((c) => outHTML(c, c.cell, k)).join('')}</div>`).join('');
        const cardStyle = (w, h, k) => `width:${w * k}px;height:${h * k}px;padding:${2.5 * k}px ${3 * k}px;font-size:${8.5 * PT_MM * k}px;gap:${0.6 * k}px;`;

        const tableHTML = (items, k, withTotals, total) => {
            const t = state.B;
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
                const all = sorted(t.sortBy);
                const sums = columnTotals(engine, t, all);
                // La etiqueta ocupa las columnas iniciales que no suman.
                const firstSum = sums.findIndex((x) => x !== null);
                const span = firstSum > 0 ? firstSum : 1;
                foot = `<tr style="font-weight:700;background:#f8fafc">${t.columns.map((c, i) => {
                    if (i > 0 && i < span) return '';
                    if (sums[i] !== null) {
                        const single = c.cell.chips.length === 1 && c.cell.chips[0].kind === 'field' ? fieldDef(c.cell.chips[0].key) : null;
                        return `<td class="b-all ss-out n" style="text-align:right">${esc(engine.formatNumber(sums[i], single ? single.decimals : undefined))}</td>`;
                    }
                    if (i === 0) return `<td class="b-all" colspan="${span}">Totales (${total ?? all.length})</td>`;
                    return `<td class="${c.border === 'sign' ? 'b-none' : 'b-all'}"></td>`;
                }).join('')}</tr>`;
            }
            return `<table class="ss-sig${state.colors ? '' : ' mono-ink'}"><colgroup>${t.columns.map((c) => `<col style="width:${((c.width || 1) / sumW) * 100}%">`).join('')}</colgroup>${head}<tbody>${body}${foot}</tbody></table>`;
        };

        /** Páginas de la hoja actual a escala k (px por mm). */
        const pagesHTML = (k, forPrint) => {
            if (state.sheet === 'A') {
                const out = engine.renderCards(state.A, employees);
                const lay = out.layout;
                return out.pages.map((cards, p) => `
                    <div class="ss-page" style="width:${lay.pageWidth * k}px;height:${lay.pageHeight * k}px;padding:${lay.margin * k}px">
                      <div class="ss-cards" style="grid-template-columns:repeat(${lay.cols}, ${lay.cardWidth * k}px);grid-auto-rows:${lay.cardHeight * k}px;gap:${lay.gap * k}px">
                        ${cards.map((rows) => `<div class="ss-card${state.A.layout.cutMarks ? ' cut' : ''}${state.colors ? '' : ' mono-ink'}" style="${cardStyle(lay.cardWidth, lay.cardHeight, k)}">${cardInner(rows, state.A.columns, k)}</div>`).join('')}
                      </div></div>${forPrint ? '' : `<div class="ss-page-no">Hoja ${p + 1} de ${out.pages.length}</div>`}`).join('');
            }
            const t = state.B;
            const g = tablePageGeometry(t, !!state.logo);
            const items = sorted(t.sortBy);
            const pages = SB.paginate(items, g.rowsPerPage);
            if (!pages.length) pages.push([]);
            const first = items[0];
            const titleRes = first ? engine.evaluateRows(t.title.map((c) => ({ cells: [c] })), first.record, first.ctx) : [];
            return pages.map((rows, p) => `
                <div class="ss-page" style="width:${g.pageWidth * k}px;height:${g.pageHeight * k}px;padding:${g.margin * k}px;display:flex;flex-direction:column;font-size:${9 * PT_MM * k}px">
                  <div class="ss-sig-head">
                    ${state.logo ? `<img src="${state.logo}" alt="Logo" style="width:${18 * k}px;height:${18 * k}px">` : ''}
                    <div style="flex:1;display:flex;flex-direction:column;gap:${0.6 * k}px">${titleRes.map((r) => `<div style="display:grid">${outHTML(r.cells[0], r.cells[0].cell, k)}</div>`).join('')}</div>
                    <div style="color:#64748b;text-align:right">Hoja ${p + 1} de ${pages.length}</div>
                  </div>
                  ${tableHTML(rows, k, t.options.totals && p === pages.length - 1, items.length)}
                  ${t.options.signatures ? `<div class="ss-sig-foot" style="padding-top:${10 * k}px"><div>Entregado por</div><div>Revisado por</div></div>` : ''}
                </div>${forPrint ? '' : `<div class="ss-page-no">Hoja ${p + 1} de ${pages.length}</div>`}`).join('');
        };

        // ─── Estructura ────────────────────────────────────────────────────
        const segHTML = (bind, value, options) => `<div class="ss-seg sm" role="group">${options.map(([v, l]) =>
            `<button type="button" data-set="${bind}" data-v="${esc(JSON.stringify(v))}" aria-pressed="${JSON.stringify(value) === JSON.stringify(v)}">${esc(l)}</button>`).join('')}</div>`;
        const selectHTML = (id, bind, value, list) => `<select id="${id}" class="ss-inp" data-bind="${bind}">${list.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

        const renderShell = () => {
            rootEl.innerHTML = `
              <header class="ss-bar">
                <span class="ss-title"><i class="fa-solid fa-print" aria-hidden="true"></i> Hojas imprimibles</span>
                <div class="ss-seg" role="group" aria-label="Tipo de hoja">
                  <button type="button" data-act="sheet" data-v="A" aria-pressed="${state.sheet === 'A'}">Tipo A · Tarjeta del sobre</button>
                  <button type="button" data-act="sheet" data-v="B" aria-pressed="${state.sheet === 'B'}">Tipo B · Hoja de firmas</button>
                </div>
                <div class="ss-grow"></div>
                <div class="ss-seg" role="group" aria-label="Modo">
                  <button type="button" data-act="view" data-v="edit" aria-pressed="${state.view === 'edit'}">Editar</button>
                  <button type="button" data-act="view" data-v="sheet" aria-pressed="${state.view === 'sheet'}">Hoja completa</button>
                </div>
                <button class="ss-btn" type="button" data-act="open-tpl">Plantilla JSON</button>
                <button class="ss-btn primary" type="button" data-act="print"><i class="fa-solid fa-print" aria-hidden="true"></i> Imprimir / PDF</button>
                <button class="ss-btn" type="button" data-act="close" aria-label="Cerrar hojas imprimibles">Cerrar ✕</button>
              </header>
              <div class="ss-wrap" id="ssMain"></div>
              <div id="ssDrawer"></div><div id="ssToast"></div>
              <div class="ss-trash" aria-hidden="true">Suelta para quitar el chip</div>`;
            const main = $('#ssMain');
            if (state.view === 'edit') {
                main.innerHTML = `<div class="ss-cols"><aside class="ss-panel ss-palette" id="ssPalette"></aside>
                  <section class="ss-center"><div id="ssGrid"></div><div class="ss-panel" id="ssInspector"></div></section>
                  <aside class="ss-side" id="ssLive"></aside></div>`;
                renderPalette(); renderGrid(); renderInspector(); renderLive();
            } else {
                main.innerHTML = `<div class="ss-cols"><aside class="ss-panel ss-palette" id="ssSettings"></aside><section class="ss-center" id="ssPages"></section></div>`;
                renderSettings(); renderPages();
            }
        };

        const renderPalette = () => {
            const el = $('#ssPalette');
            if (!el) return;
            const groups = [];
            palette.forEach((p, i) => {
                let g = groups.find((x) => x.name === p.group);
                if (!g) groups.push((g = { name: p.group, items: [] }));
                g.items.push(`<span class="ss-chip ${chipClass(p.chip)}" draggable="true" tabindex="0" role="button" data-pi="${i}" title="Arrastra a una celda o toca para agregar a la celda seleccionada">${esc(p.label)}</span>`);
            });
            el.innerHTML = `<h3 class="ss-lbl">Chips</h3>
              <p class="ss-hint">Arrastra un chip a una celda, o selecciona una celda y toca el chip. Para quitar uno, arrástralo fuera de las celdas.</p>
              ${groups.map((g) => `<div class="ss-group"><div class="ss-group-t">${esc(g.name)}</div><div class="ss-chips">${g.items.join('')}</div></div>`).join('')}`;
        };

        const zoneHTML = (zone, cell) => {
            const isSel = state.sel && state.sel.zone === zone;
            const chips = cell.chips.map((c, i) => chipHTML(c, `data-ci="${i}"`, isSel && state.sel.ci === i)).join('');
            return `<div class="ss-ecell${isSel && state.sel.ci == null ? ' is-sel' : ''}" data-zone="${zone}" tabindex="0" role="button" aria-label="Celda">
              <span class="ss-mode">${cell.mode === 'number' ? 'NÚMERO' : 'TEXTO'}</span>${chips || '<span class="ss-placeholder">vacía</span>'}</div>`;
        };

        const renderGrid = () => {
            const el = $('#ssGrid');
            if (!el) return;
            if (state.sheet === 'A') {
                const t = state.A;
                const rows = t.rows.map((row, r) => `<div class="ss-erow${row.lineAbove ? ' line' : ''}"><div class="ss-rowtag">${r + 1}</div>
                    ${row.cells.map((cell, c) => `<div style="flex:${t.columns[c] || 1} 1 0;min-width:0;display:flex">${zoneHTML(`A:${r}:${c}`, cell)}</div>`).join('')}
                    ${row.whenEmpty === 'hide' ? '<span class="ss-empty-tag">Oculta si vacía</span>' : row.whenEmpty === 'dash' ? '<span class="ss-empty-tag">“-” si vacía</span>' : ''}</div>`).join('');
                el.innerHTML = `<div class="ss-toolbar" style="margin-bottom:10px"><h2>Diseño de la tarjeta</h2><div class="ss-grow"></div>
                    <button class="ss-btn sm" type="button" data-act="add-row">+ Fila</button></div>
                  <div class="ss-gridbox">${rows || '<p class="ss-hint">Sin filas. Agrega una.</p>'}</div>`;
            } else {
                const t = state.B;
                const titles = t.title.map((cell, i) => `<div class="ss-erow" style="min-width:0"><div class="ss-rowtag">T${i + 1}</div>${zoneHTML(`B:title:${i}`, cell)}</div>`).join('');
                const cols = t.columns.map((col, i) => {
                    const z = `B:col:${i}`;
                    return `<div class="ss-colcard${state.sel && state.sel.zone === z ? ' is-sel' : ''}" data-colpick="${z}">
                      <div class="hdr">${esc(col.header) || '<span class="ss-placeholder">sin encabezado</span>'}</div>
                      ${zoneHTML(z, col.cell)}
                      <div class="meta">Bordes: ${{ all: 'todos', sign: 'línea de firma', none: 'sin bordes' }[col.border]} · ${col.sum ? 'suma al pie' : 'sin suma'}</div></div>`;
                }).join('');
                el.innerHTML = `<div class="ss-toolbar" style="margin-bottom:10px"><h2>Encabezado de la hoja</h2><div class="ss-grow"></div>
                    <button class="ss-btn sm" type="button" data-act="add-title">+ Línea</button></div>
                  <div class="ss-gridbox">${titles || '<p class="ss-hint">Sin encabezado.</p>'}</div>
                  <div class="ss-toolbar" style="margin:16px 0 10px"><h2>Columnas: la fila se repite para cada empleado</h2><div class="ss-grow"></div>
                    <button class="ss-btn sm" type="button" data-act="add-col">+ Columna</button></div>
                  <div class="ss-gridbox"><div class="ss-colcards">${cols}</div></div>`;
            }
        };

        const cardSection = () => `<div class="ss-sec"><h3 class="ss-lbl">Tarjeta</h3>
            <div class="ss-field">Columnas ${segHTML('card.cols', state.A.columns.length, [[1, '1'], [2, '2'], [3, '3']])}</div>
            <div class="ss-grid2">${state.A.columns.map((w, i) => `<label class="ss-field">Ancho col. ${i + 1}<input id="ssColW${i}" class="ss-inp ss-num" type="number" min="0.2" max="10" step="0.1" data-bind="card.w${i}" data-type="number" value="${esc(w)}"></label>`).join('')}</div></div>`;
        const tableSection = () => {
            const o = state.B.options;
            return `<div class="ss-sec"><h3 class="ss-lbl">Tabla</h3>
              <label class="ss-check"><input id="ssTotals" type="checkbox" data-bind="opt.totals" ${o.totals ? 'checked' : ''}> Fila de totales al final</label>
              <label class="ss-check"><input id="ssSigs" type="checkbox" data-bind="opt.signatures" ${o.signatures ? 'checked' : ''}> “Entregado por / Revisado por” al pie</label>
              <label class="ss-field">Alto de fila (mm)<input id="ssRowH" class="ss-inp ss-num" type="number" min="6" max="30" step="0.5" data-bind="opt.rowHeight" data-type="number" value="${esc(o.rowHeight)}"></label></div>`;
        };

        const renderInspector = () => {
            const el = $('#ssInspector');
            if (!el) return;
            const cell = selCell();
            if (!cell) {
                el.innerHTML = `<h3 class="ss-lbl">Propiedades</h3><p class="ss-hint">Selecciona una celda${state.sheet === 'B' ? ', una columna o una línea del encabezado' : ''} para ver sus opciones.</p>${state.sheet === 'A' ? cardSection() : tableSection()}`;
                return;
            }
            const chip = selChip();
            let html = '';
            if (chip) {
                html += `<div class="ss-sec"><h3 class="ss-lbl">Chip: ${esc(chipLabel(chip))}</h3>`;
                if (chip.kind === 'field') {
                    html += fieldDef(chip.key) ? '' : `<div class="ss-msg-err">Campo desconocido: ${esc(chip.key)}</div>`;
                    html += `<div class="ss-field">Imprime ${segHTML('chip.as', chip.as === 'label' ? 'label' : 'value', [['value', 'Valor'], ['label', 'Nombre del campo']])}</div>`;
                } else if (chip.kind === 'text') {
                    html += `<label class="ss-field">Texto<input id="ssChipText" class="ss-inp" data-bind="chip.value" value="${esc(chip.value)}" maxlength="200"></label>`;
                } else if (chip.kind === 'number') {
                    html += `<div class="ss-grid2"><label class="ss-field">Valor<input id="ssChipNum" class="ss-inp ss-num" data-bind="chip.value" data-type="number" value="${esc(chip.value)}" inputmode="decimal"></label>
                      <label class="ss-check" style="align-self:end;min-height:36px"><input id="ssChipPct" type="checkbox" data-bind="chip.percent" ${chip.percent ? 'checked' : ''}> Es porcentaje</label></div>
                      <p class="ss-hint">Con %: <span class="ss-num">[Bruto] − 3%</span> resta el 3% del bruto.</p>`;
                } else if (chip.kind === 'op') {
                    html += `<div class="ss-field">Operador ${segHTML('chip.op', chip.op, [['+', '+'], ['-', '−'], ['*', '×'], ['/', '÷']])}</div>`;
                }
                html += `<div class="ss-row-btns"><button class="ss-btn sm" type="button" data-act="chip-move" data-v="-1">← Mover</button><button class="ss-btn sm" type="button" data-act="chip-move" data-v="1">Mover →</button><button class="ss-btn sm danger" type="button" data-act="chip-del">Quitar chip</button></div></div>`;
            }
            const isTitle = state.sel.zone.startsWith('B:title');
            html += `<div class="ss-sec"><h3 class="ss-lbl">${isTitle ? 'Línea del encabezado' : 'Celda'}</h3>`;
            if (!isTitle) html += `<div class="ss-field">Tipo ${segHTML('cell.mode', cell.mode, [['text', 'Texto'], ['number', 'Número (calcula)']])}</div>`;
            if (cell.mode === 'number') {
                html += `<div class="ss-field">Muestra ${segHTML('cell.show', cell.show || 'result', [['result', 'Resultado'], ['expression', 'Fórmula'], ['both', 'Ambos']])}</div>
                  <div class="ss-field">Total acumulado ${segHTML('cell.total', cell.total || 'auto', [['auto', 'Automático'], ['set', 'Fija el total'], ['apply', 'Se aplica'], ['ignore', 'No cuenta']])}</div>`;
            }
            html += `<div class="ss-field">Alineación ${segHTML('cell.align', cell.align || (cell.mode === 'number' ? 'right' : 'left'), [['left', 'Izquierda'], ['center', 'Centro'], ['right', 'Derecha']])}</div>
              <div class="ss-grid2"><label class="ss-check"><input id="ssBold" type="checkbox" data-bind="cell.bold" ${cell.bold ? 'checked' : ''}> Negrita</label>
              <label class="ss-field">Letra (pt)<input id="ssSize" class="ss-inp ss-num" type="number" min="5" max="40" step="0.5" data-bind="cell.size" data-type="number" value="${esc(cell.size || '')}" placeholder="${isTitle ? '10' : state.sheet === 'A' ? '8.5' : '9'}"></label></div>`;
            if (isTitle) html += `<div class="ss-row-btns"><button class="ss-btn sm" type="button" data-act="title-move" data-v="-1">↑ Subir</button><button class="ss-btn sm" type="button" data-act="title-move" data-v="1">↓ Bajar</button><button class="ss-btn sm danger" type="button" data-act="title-del">Eliminar línea</button></div>`;
            html += '</div>';
            if (state.sheet === 'A') {
                const r = +state.sel.zone.split(':')[1];
                const row = state.A.rows[r];
                html += `<div class="ss-sec"><h3 class="ss-lbl">Fila ${r + 1}</h3>
                  <div class="ss-field">Si sus campos están vacíos o en 0 ${segHTML('row.whenEmpty', row.whenEmpty || 'show', [['show', 'Mostrar'], ['dash', 'Guion “-”'], ['hide', 'Ocultar fila']])}</div>
                  <label class="ss-check"><input id="ssLine" type="checkbox" data-bind="row.lineAbove" ${row.lineAbove ? 'checked' : ''}> Línea separadora encima</label>
                  <div class="ss-row-btns"><button class="ss-btn sm" type="button" data-act="row-move" data-v="-1">↑ Subir</button><button class="ss-btn sm" type="button" data-act="row-move" data-v="1">↓ Bajar</button>
                  <button class="ss-btn sm" type="button" data-act="row-dup">Duplicar</button><button class="ss-btn sm danger" type="button" data-act="row-del">Eliminar fila</button></div></div>${cardSection()}`;
            } else if (!isTitle) {
                const i = +state.sel.zone.split(':')[2];
                const col = state.B.columns[i];
                html += `<div class="ss-sec"><h3 class="ss-lbl">Columna ${i + 1}</h3>
                  <label class="ss-field">Encabezado<input id="ssHeader" class="ss-inp" data-bind="col.header" value="${esc(col.header)}" maxlength="60"></label>
                  <div class="ss-grid2"><label class="ss-field">Ancho relativo<input id="ssWidth" class="ss-inp ss-num" type="number" min="0.2" max="10" step="0.1" data-bind="col.width" data-type="number" value="${esc(col.width)}"></label>
                  <label class="ss-check" style="align-self:end;min-height:36px"><input id="ssSum" type="checkbox" data-bind="col.sum" ${col.sum ? 'checked' : ''}> Sumar al pie</label></div>
                  <div class="ss-field">Bordes ${segHTML('col.border', col.border, [['all', 'Todos'], ['sign', 'Línea de firma'], ['none', 'Sin bordes']])}</div>
                  <div class="ss-row-btns"><button class="ss-btn sm" type="button" data-act="col-move" data-v="-1">← Mover</button><button class="ss-btn sm" type="button" data-act="col-move" data-v="1">Mover →</button><button class="ss-btn sm danger" type="button" data-act="col-del">Eliminar columna</button></div></div>${tableSection()}`;
            } else {
                html += tableSection();
            }
            el.innerHTML = `<h3 class="ss-lbl" style="font-size:12px">Propiedades</h3>${html}`;
        };

        const renderLive = () => {
            const el = $('#ssLive');
            if (!el) return;
            if (!employees.length) { el.innerHTML = '<div class="ss-panel"><p class="ss-hint">No hay empleados. Agrega o importa empleados en SplitX.</p></div>'; return; }
            state.preview = Math.min(state.preview, employees.length - 1);
            const rec = employees[state.preview];
            const colorsBox = `<label class="ss-check"><input id="ssColors" type="checkbox" data-bind="colors" ${state.colors ? 'checked' : ''}> Montos a color</label>`;
            if (state.sheet === 'A') {
                const lay = SB.computeLayout(state.A.layout);
                const k = Math.min(3.4, 330 / lay.cardWidth);
                const res = engine.evaluateRows(state.A.rows, rec, { index: state.preview });
                const errs = res.flatMap((r) => r.cells.filter((c) => c.error).map((c) => c.error));
                const opts2 = employees.map((e, i) => `<option value="${i}" ${i === state.preview ? 'selected' : ''}>${esc(e.employeeNumber || i + 1)} · ${esc(e.employeeName || e.name)}</option>`).join('');
                el.innerHTML = `<div class="ss-panel"><h3 class="ss-lbl">Vista en vivo</h3>
                  <div class="ss-emp-nav"><button class="ss-btn sm" type="button" data-act="emp" data-v="-1" aria-label="Empleado anterior">‹</button>
                    <select id="ssEmp" class="ss-inp" data-bind="preview" aria-label="Empleado">${opts2}</select>
                    <button class="ss-btn sm" type="button" data-act="emp" data-v="1" aria-label="Empleado siguiente">›</button></div>
                  <div style="display:flex;justify-content:center"><div id="ssLiveCard" class="ss-card${state.colors ? '' : ' mono-ink'}" style="${cardStyle(lay.cardWidth, lay.cardHeight, k)};box-shadow:0 6px 20px rgba(15,23,42,.12)">${cardInner(res, state.A.columns, k)}</div></div>
                  <p class="ss-hint ss-num" style="text-align:center">Tarjeta de ${lay.cardWidth.toFixed(0)} × ${lay.cardHeight.toFixed(0)} mm</p>
                  <div id="ssLiveWarn"></div>${errs.length ? `<div class="ss-msg-err">${errs.map(esc).join('\n')}</div>` : ''}${colorsBox}</div>
                  <div class="ss-note">Las filas “Oculta si vacía” desaparecen solo para los empleados sin ese monto.</div>`;
                requestAnimationFrame(() => {
                    const card = $('#ssLiveCard'); const warn = $('#ssLiveWarn');
                    if (card && warn) warn.innerHTML = card.scrollHeight > card.clientHeight + 1 ? '<p class="ss-overflow">El contenido no cabe en la tarjeta. Reduce filas o letra, o agranda la tarjeta en “Hoja completa”.</p>' : '';
                });
            } else {
                el.innerHTML = `<div class="ss-panel"><h3 class="ss-lbl">Vista en vivo (primeras filas)</h3>
                  <div style="overflow-x:auto;background:#fff;border-radius:8px;padding:8px"><div style="min-width:520px;font-size:${9 * PT_MM * 2.56}px">${tableHTML(sorted(state.B.sortBy).slice(0, 4), 2.56, false)}</div></div>${colorsBox}</div>
                  <div class="ss-note">Esta hoja es independiente de la tarjeta: aquí “Monto entregado” incluye el adelanto ya entregado; la tarjeta del sobre lo resta.</div>`;
            }
        };

        const renderSettings = () => {
            const el = $('#ssSettings');
            if (!el) return;
            const isA = state.sheet === 'A';
            const t = isA ? state.A : state.B;
            const L = t.layout;
            let html = `<h3 class="ss-lbl">Hoja</h3>
              <label class="ss-field">Papel${selectHTML('ssPaper', 'lay.paper', L.paper, PAPERS)}</label>
              <div class="ss-field">Orientación ${segHTML('lay.orientation', L.orientation, [['portrait', 'Vertical'], ['landscape', 'Horizontal']])}</div>
              <label class="ss-field">Margen (mm)<input id="ssMargin" class="ss-inp ss-num" type="number" min="0" max="40" step="1" data-bind="lay.margin" data-type="number" value="${esc(L.margin)}"></label>`;
            if (isA) {
                html += `<h3 class="ss-lbl" style="margin-top:6px">Tarjetas</h3>
                  <div class="ss-field">Definir por ${segHTML('lay.mode', L.mode, [['grid', 'Cuántas por hoja'], ['size', 'Tamaño en mm']])}</div>
                  <div class="ss-grid2">${L.mode === 'grid'
                    ? `<label class="ss-field">Columnas<input id="ssCols" class="ss-inp ss-num" type="number" min="1" max="6" data-bind="lay.cols" data-type="number" value="${esc(L.cols)}"></label>
                       <label class="ss-field">Filas<input id="ssRows" class="ss-inp ss-num" type="number" min="1" max="12" data-bind="lay.rows" data-type="number" value="${esc(L.rows)}"></label>`
                    : `<label class="ss-field">Ancho (mm)<input id="ssCW" class="ss-inp ss-num" type="number" min="20" max="300" data-bind="lay.cardWidth" data-type="number" value="${esc(L.cardWidth || 90)}"></label>
                       <label class="ss-field">Alto (mm)<input id="ssCH" class="ss-inp ss-num" type="number" min="15" max="300" data-bind="lay.cardHeight" data-type="number" value="${esc(L.cardHeight || 55)}"></label>`}
                    <label class="ss-field">Separación (mm)<input id="ssGap" class="ss-inp ss-num" type="number" min="0" max="20" data-bind="lay.gap" data-type="number" value="${esc(L.gap)}"></label></div>
                  <label class="ss-check"><input id="ssCut" type="checkbox" data-bind="lay.cutMarks" ${L.cutMarks ? 'checked' : ''}> Líneas de corte punteadas</label>
                  <div class="ss-note ss-num" id="ssSummary"></div>`;
            } else {
                html += `<label class="ss-field">Alto de fila (mm)<input id="ssRowH2" class="ss-inp ss-num" type="number" min="6" max="30" step="0.5" data-bind="opt.rowHeight" data-type="number" value="${esc(state.B.options.rowHeight)}"></label>
                  <label class="ss-check"><input id="ssTotals2" type="checkbox" data-bind="opt.totals" ${state.B.options.totals ? 'checked' : ''}> Fila de totales</label>
                  <label class="ss-check"><input id="ssSigs2" type="checkbox" data-bind="opt.signatures" ${state.B.options.signatures ? 'checked' : ''}> “Entregado por / Revisado por”</label>
                  <label class="ss-field">Logo (imagen)<input id="ssLogo" class="ss-inp" type="file" accept="image/*" data-act-change="logo"></label>
                  ${state.logo ? '<button class="ss-btn sm" type="button" data-act="logo-del">Quitar logo</button>' : ''}`;
            }
            html += `<h3 class="ss-lbl" style="margin-top:6px">Orden</h3>
              <div class="ss-grid2"><label class="ss-field">Ordenar por${selectHTML('ssSort', 'sort.field', (t.sortBy || {}).field || 'no', SORTS)}</label>
              <div class="ss-field">Sentido ${segHTML('sort.dir', (t.sortBy || {}).dir || 'asc', [['asc', '↑'], ['desc', '↓']])}</div></div>
              <label class="ss-check"><input id="ssColors2" type="checkbox" data-bind="colors" ${state.colors ? 'checked' : ''}> Montos a color</label>
              <p class="ss-hint">“Imprimir / PDF” abre el diálogo de impresión: elige tu impresora o “Guardar como PDF”, con márgenes “Ninguno” y escala 100%.</p>`;
            el.innerHTML = html;
        };

        const renderPages = () => {
            const el = $('#ssPages');
            if (!el) return;
            const avail = Math.max(280, el.clientWidth - 36);
            let pageW;
            if (state.sheet === 'A') {
                const lay = SB.computeLayout(state.A.layout);
                pageW = lay.pageWidth;
                const sum = $('#ssSummary');
                const pages = Math.ceil(employees.length / lay.perPage);
                if (sum) sum.textContent = `Cada tarjeta: ${lay.cardWidth.toFixed(0)} × ${lay.cardHeight.toFixed(0)} mm · ${lay.perPage} por hoja · ${employees.length} empleados → ${pages} hoja${pages === 1 ? '' : 's'}`;
            } else {
                pageW = tablePageGeometry(state.B, !!state.logo).pageWidth;
            }
            el.innerHTML = `<div class="ss-desk">${pagesHTML(Math.min(2.6, avail / pageW), false)}</div>`;
        };

        // ─── Cambios de estado ─────────────────────────────────────────────
        const touch = (parts) => {
            save();
            const p = parts === undefined ? 'all' : parts;
            if (p === 'all') return renderShell();
            if (p.includes('grid')) renderGrid();
            if (p.includes('insp')) renderInspector();
            if (p.includes('live')) renderLive();
            if (p.includes('settings')) renderSettings();
            if (p.includes('pages')) renderPages();
        };

        const insertChip = (zone, chip, at) => {
            const cell = cellOf(zone);
            if (!cell) return;
            const idx = at == null ? cell.chips.length : at;
            cell.chips.splice(idx, 0, clone(chip));
            select(zone, idx);
        };

        const toast = (msg) => {
            const host = $('#ssToast');
            if (!host) return;
            host.innerHTML = `<div class="ss-toast" role="status">${esc(msg)}</div>`;
            clearTimeout(toast.t);
            toast.t = setTimeout(() => { host.innerHTML = ''; }, 2600);
        };

        const setByBind = (bind, value) => {
            const [scope, key] = bind.split('.');
            const cell = selCell();
            switch (scope) {
                case 'chip': { const c = selChip(); if (c) { if (key === 'as') { if (value === 'label') c.as = 'label'; else delete c.as; } else c[key] = value; } return 'grid insp live'; }
                case 'cell':
                    if (!cell) return '';
                    if (key === 'size' && !Number.isFinite(value)) delete cell.size;
                    else if (key === 'show' && value === 'result') delete cell.show;
                    else if (key === 'total' && value === 'auto') delete cell.total;
                    else cell[key] = value;
                    return 'grid live insp';
                case 'row': {
                    const row = state.A.rows[+state.sel.zone.split(':')[1]];
                    if (key === 'whenEmpty' && value === 'show') delete row.whenEmpty;
                    else if (key === 'lineAbove' && !value) delete row.lineAbove;
                    else row[key] = value;
                    return 'grid live insp';
                }
                case 'col': { const col = state.B.columns[+state.sel.zone.split(':')[2]]; col[key] = key === 'width' ? Math.max(0.2, value || 1) : value; return 'grid live'; }
                case 'opt': state.B.options[key] = key === 'rowHeight' ? Math.max(6, value || 11) : value; return 'live pages';
                case 'card': {
                    const cols = state.A.columns;
                    if (key === 'cols') {
                        while (cols.length < value) { cols.push(1); state.A.rows.forEach((r) => r.cells.push(cT([]))); }
                        while (cols.length > value) {
                            cols.pop();
                            state.A.rows.forEach((r) => { const gone = r.cells.pop(); r.cells[r.cells.length - 1].chips.push(...gone.chips); });
                        }
                        state.sel = null;
                        return 'grid insp live';
                    }
                    cols[+key.slice(1)] = Math.max(0.2, value || 1);
                    return 'grid live';
                }
                case 'lay': {
                    const L = (state.sheet === 'A' ? state.A : state.B).layout;
                    if (typeof value === 'number' && !Number.isFinite(value)) return '';
                    L[key] = value;
                    if (key === 'mode') { if (value === 'size') { L.cardWidth = L.cardWidth || 90; L.cardHeight = L.cardHeight || 55; } return 'settings pages'; }
                    return key === 'orientation' || key === 'paper' ? 'settings pages' : 'pages';
                }
                case 'sort': { const t = state.sheet === 'A' ? state.A : state.B; t.sortBy = Object.assign({ field: 'no', dir: 'asc' }, t.sortBy, { [key]: value }); return 'settings pages live'; }
                case 'colors': state.colors = value; return state.view === 'edit' ? 'live' : 'settings pages';
                case 'preview': state.preview = +value; return 'live';
            }
            return '';
        };

        const moveIn = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return i; [arr[i], arr[j]] = [arr[j], arr[i]]; return j; };
        const selIndex = (n) => +state.sel.zone.split(':')[n];

        const print = () => {
            if (!employees.length) return toast('No hay empleados para imprimir');
            let host = document.getElementById('ss-print');
            if (!host) { host = document.createElement('div'); host.id = 'ss-print'; document.body.appendChild(host); }
            host.innerHTML = pagesHTML(PRINT_K, true);
            let rule = document.getElementById('ss-page-rule');
            if (!rule) { rule = document.createElement('style'); rule.id = 'ss-page-rule'; document.head.appendChild(rule); }
            const L = (state.sheet === 'A' ? state.A : state.B).layout;
            rule.textContent = `@media print { ${printPageRule(L.paper, L.orientation)} }`;
            const done = () => { document.body.classList.remove('ss-printing'); host.innerHTML = ''; window.removeEventListener('afterprint', done); };
            window.addEventListener('afterprint', done);
            document.body.classList.add('ss-printing');
            window.print();
        };

        const actions = {
            sheet: (v) => { state.sheet = v; state.sel = null; touch(); },
            view: (v) => { state.view = v; touch(); },
            close: () => api.close(),
            print,
            emp: (v) => { const n = employees.length; state.preview = (state.preview + +v + n) % n; touch('live'); },
            'add-row': () => { state.A.rows.push({ cells: state.A.columns.map((_, i) => (i === state.A.columns.length - 1 && i > 0 ? cN([]) : cT([]))) }); select(`A:${state.A.rows.length - 1}:0`); touch('grid insp live'); },
            'row-move': (v) => { const j = moveIn(state.A.rows, selIndex(1), +v); select(`A:${j}:${selIndex(2)}`); touch('grid insp live'); },
            'row-dup': () => { const r = selIndex(1); state.A.rows.splice(r + 1, 0, clone(state.A.rows[r])); touch('grid live'); },
            'row-del': () => { state.A.rows.splice(selIndex(1), 1); state.sel = null; touch('grid insp live'); },
            'add-col': () => { state.B.columns.push({ header: 'Nueva', width: 1, border: 'all', sum: false, cell: cT([]) }); select(`B:col:${state.B.columns.length - 1}`); touch('grid insp live'); },
            'col-move': (v) => { const j = moveIn(state.B.columns, selIndex(2), +v); select(`B:col:${j}`); touch('grid insp live'); },
            'col-del': () => { state.B.columns.splice(selIndex(2), 1); state.sel = null; touch('grid insp live'); },
            'add-title': () => { state.B.title.push(cT([], { size: 10 })); select(`B:title:${state.B.title.length - 1}`); touch('grid insp live'); },
            'title-move': (v) => { const j = moveIn(state.B.title, selIndex(2), +v); select(`B:title:${j}`); touch('grid insp live'); },
            'title-del': () => { state.B.title.splice(selIndex(2), 1); state.sel = null; touch('grid insp live'); },
            'chip-move': (v) => { state.sel.ci = moveIn(selCell().chips, state.sel.ci, +v); touch('grid live'); },
            'chip-del': () => { selCell().chips.splice(state.sel.ci, 1); state.sel.ci = null; touch('grid insp live'); },
            'logo-del': () => { state.logo = null; touch('settings pages'); },
            'open-tpl': () => { state.drawer = 'tpl'; renderDrawer(); },
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
                    if (state.sheet === 'A') state.A = SB.parseTemplate(text);
                    else { const t = JSON.parse(text); const errs = validateTableTemplate(t); if (errs.length) throw new Error(`Plantilla inválida:\n${errs.join('\n')}`); state.B = t; }
                    state.sel = null;
                    state.drawer = null;
                    touch();
                    toast('Plantilla aplicada');
                } catch (e) { out.innerHTML = `<span class="ss-msg-err">${esc(e.message)}</span>`; }
            },
            'reset-tpl': () => {
                if (state.sheet === 'A') state.A = defaultCardTemplate(); else state.B = defaultTableTemplate();
                state.sel = null; state.drawer = null;
                touch();
                toast('Se restauró la plantilla de ejemplo');
            }
        };

        const renderDrawer = () => {
            const host = $('#ssDrawer');
            if (!host) return;
            if (!state.drawer) { host.innerHTML = ''; return; }
            const tpl = state.sheet === 'A' ? state.A : state.B;
            host.innerHTML = `<div class="ss-scrim"><div class="ss-drawer" role="dialog" aria-label="Plantilla JSON">
              <div class="ss-toolbar"><h2>Plantilla ${state.sheet === 'A' ? 'Tipo A' : 'Tipo B'} (JSON)</h2><div class="ss-grow"></div><button class="ss-btn sm" type="button" data-act="close-drawer">Cerrar</button></div>
              <p class="ss-hint">Copia este JSON para guardarlo o compartirlo, o pega uno y aplícalo. Se valida antes de usarlo.</p>
              <textarea id="ssTplText" spellcheck="false">${esc(JSON.stringify(tpl, null, 2))}</textarea>
              <div class="ss-row-btns"><button class="ss-btn primary" type="button" data-act="apply-tpl">Aplicar</button><button class="ss-btn" type="button" data-act="copy-tpl">Copiar</button><button class="ss-btn danger" type="button" data-act="reset-tpl">Restaurar ejemplo</button></div>
              <div id="ssTplMsg"></div></div></div>`;
        };

        // ─── Eventos (delegados en el contenedor) ──────────────────────────
        const readInput = (el) => (el.type === 'checkbox' ? el.checked : el.dataset.type === 'number' ? (el.value === '' ? NaN : parseFloat(el.value)) : el.value);
        const setTrash = (on) => rootEl.classList.toggle('trashing', on);

        const bindEvents = () => {
            if (bound) return;
            bound = true;
            rootEl.addEventListener('click', (e) => {
                if (e.target.classList && e.target.classList.contains('ss-scrim')) return actions['close-drawer']();
                const act = e.target.closest('[data-act]');
                if (act && act.tagName !== 'INPUT') { const fn = actions[act.dataset.act]; if (fn) { e.preventDefault(); fn(act.dataset.v); } return; }
                const set = e.target.closest('[data-set]');
                if (set) return touch(setByBind(set.dataset.set, JSON.parse(set.dataset.v)));
                const pi = e.target.closest('[data-pi]');
                if (pi) {
                    if (!state.sel || !state.sel.zone) return toast('Primero selecciona una celda');
                    insertChip(state.sel.zone, palette[+pi.dataset.pi].chip, state.sel.ci != null ? state.sel.ci + 1 : null);
                    return touch('grid insp live');
                }
                const ci = e.target.closest('[data-ci]');
                const zone = e.target.closest('[data-zone]');
                if (zone) { select(zone.dataset.zone, ci ? +ci.dataset.ci : null); return touch('grid insp'); }
                const cp = e.target.closest('[data-colpick]');
                if (cp) { select(cp.dataset.colpick); touch('grid insp'); }
            });
            rootEl.addEventListener('keydown', (e) => {
                if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-pi],[data-ci],[data-zone]')) { e.preventDefault(); e.target.click(); }
                if (e.key === 'Escape') { if (state.drawer) actions['close-drawer'](); else api.close(); }
            });
            rootEl.addEventListener('input', (e) => {
                const el = e.target;
                if (!el.dataset || !el.dataset.bind || el.tagName === 'SELECT' || el.type === 'checkbox') return;
                const v = readInput(el);
                if (el.dataset.bind === 'chip.value' && el.dataset.type === 'number' && !Number.isFinite(v)) return;
                const parts = setByBind(el.dataset.bind, v);
                // No se vuelve a dibujar el panel que contiene el campo, para no perder el foco.
                const holder = el.closest('#ssInspector') ? 'insp' : el.closest('#ssSettings') ? 'settings' : '';
                touch(parts.split(' ').filter((p) => p !== holder).join(' '));
            });
            rootEl.addEventListener('change', (e) => {
                const el = e.target;
                if (el.dataset && el.dataset.actChange === 'logo') {
                    const f = el.files && el.files[0];
                    if (!f) return;
                    if (f.size > 1.5e6) return toast('La imagen debe pesar menos de 1.5 MB');
                    const r = new FileReader();
                    r.onload = () => { state.logo = String(r.result); touch('settings pages'); };
                    r.readAsDataURL(f);
                    return;
                }
                if (el.dataset && el.dataset.bind && (el.tagName === 'SELECT' || el.type === 'checkbox')) touch(setByBind(el.dataset.bind, readInput(el)));
            });
            // Arrastrar y soltar (ratón). En pantallas táctiles: tocar la celda y luego el chip.
            rootEl.addEventListener('dragstart', (e) => {
                const pi = e.target.closest && e.target.closest('[data-pi]');
                const ci = e.target.closest && e.target.closest('[data-ci]');
                if (pi) drag = { src: 'palette', pi: +pi.dataset.pi };
                else if (ci) { drag = { src: 'cell', zone: ci.closest('[data-zone]').dataset.zone, ci: +ci.dataset.ci }; ci.classList.add('dragging'); }
                else return;
                e.dataTransfer.effectAllowed = 'copyMove';
                e.dataTransfer.setData('text/plain', 'chip');
            });
            rootEl.addEventListener('dragover', (e) => {
                if (!drag) return;
                const z = e.target.closest && e.target.closest('[data-zone]');
                rootEl.querySelectorAll('.ss-ecell.over').forEach((x) => x !== z && x.classList.remove('over'));
                if (z) { e.preventDefault(); z.classList.add('over'); setTrash(false); return; }
                // Un chip sacado de una celda y soltado fuera de todas se elimina.
                if (drag.src === 'cell') { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setTrash(true); }
            });
            rootEl.addEventListener('drop', (e) => {
                if (!drag) return;
                const z = e.target.closest && e.target.closest('[data-zone]');
                setTrash(false);
                e.preventDefault();
                if (!z) {
                    if (drag.src !== 'cell') { drag = null; return; }
                    const [gone] = cellOf(drag.zone).chips.splice(drag.ci, 1);
                    select(drag.zone);
                    drag = null;
                    toast(`Se quitó “${chipLabel(gone)}”`);
                    return touch('grid insp live');
                }
                const zone = z.dataset.zone;
                const over = e.target.closest('[data-ci]');
                let at = over ? +over.dataset.ci : null;
                if (drag.src === 'palette') insertChip(zone, palette[drag.pi].chip, at);
                else {
                    const [chip] = cellOf(drag.zone).chips.splice(drag.ci, 1);
                    if (drag.zone === zone && at != null && drag.ci < at) at -= 1;
                    insertChip(zone, chip, at);
                }
                drag = null;
                touch('grid insp live');
            });
            rootEl.addEventListener('dragend', () => {
                drag = null; setTrash(false);
                rootEl.querySelectorAll('.ss-ecell.over').forEach((x) => x.classList.remove('over'));
                rootEl.querySelectorAll('.ss-chip.dragging').forEach((x) => x.classList.remove('dragging'));
            });
            window.addEventListener('resize', () => {
                clearTimeout(bindEvents.t);
                bindEvents.t = setTimeout(() => { if (!rootEl.hidden && state.view === 'sheet') renderPages(); }, 150);
            });
        };

        const api = {
            open: () => {
                injectCss();
                rootEl.classList.add('ss');
                employees = opts.getEmployees() || [];
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
                state.drawer = null;
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
        catOf
    };
});
