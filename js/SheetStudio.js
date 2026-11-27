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
        module.exports = factory(
            require('./SheetBuilder.js'),
            require('./SplitXSheetFields.js'),
            require('./SplitXVariables.js'),
            require('./SplitXFormulaBuilder.js'),
            require('./SheetStudioModel.js')
        );
    } else {
        root.SheetStudio = factory(
            root.SheetBuilder,
            root.SplitXSheetFields,
            root.SplitXVariables,
            root.SplitXFormulaBuilder,
            root.SheetStudioModel
        );
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SB, SF, CV, FB, M) {
    'use strict';

    const {
        PT_MM, PRINT_K, STORE_KEY, LEGACY_STORE_KEY, TOTAL_PREFIX, MONEY_COLORS,
        F, T, O, RUN, cT, cN, esc, clone, fold, newId,
        defaultCardTemplate, defaultTableTemplate, validateTableTemplate,
        tablePageGeometry, tablePageSizes, tableOptions, logoFilter, footerOnPage,
        resizeColumns, columnTotals, cardTotals, starterTemplates,
        cardFontPt, cellFontPt, fitFontSize, doubleCounted, breakDownRow,
        printSignatures, snapshotDiff, printPageRule, catOf,
        smartRowFor, smartColumnFor, pageSummary, selectEmployees,
        createHistory, paletteMatches, migrateStore
    } = M;

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
        const save = () => {
            const res = storage.set(STORE_KEY, JSON.stringify(state.store));
            if (res && res.ok === false) {
                toast('No se pudo guardar la plantilla (almacenamiento lleno o bloqueado).');
            }
        };
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
        const closeVariablesDialog = () => { $('#ssVarsDialog')?.remove(); formulaBuilder = null; variableSeedChips = null; state.variableEdit = null; state.variableDeleteConfirm = null; };
        const variableError = message => { const el = $('#ssVarsMsg'); if (el) el.textContent = message; };
        const saveVariable = () => {
            try {
                const enteredId = $('#ssVarId').value.trim();
                const label = $('#ssVarLabel').value.trim();
                const suggested = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
                const id = enteredId || (suggested.match(/^[a-z]/) ? suggested : 'variable_' + suggested).slice(0, 32);
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

        const moveIn = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return i;[arr[i], arr[j]] = [arr[j], arr[i]]; return j; };
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
                if (!cell || !cell.chips.length || cell.chips.some(c => !['field', 'number', 'op', 'paren'].includes(c.kind)))
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
                load();
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
