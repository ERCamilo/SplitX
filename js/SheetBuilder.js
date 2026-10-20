// @ts-check
/**
 * SheetBuilder.js
 * Motor genérico de plantillas imprimibles basado en "chips" (campos, textos, números,
 * operadores y total acumulado). Independiente de SplitX: la app anfitriona declara
 * sus campos y le pasa registros planos.
 *
 * Tipo A ('cards'): una tarjeta por registro, repetida en una hoja para recortar.
 * Tipo B ('table'): reservado para la hoja de firmas (una fila por registro).
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else {
        root.SheetBuilder = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /**
     * @typedef {'+' | '-' | '*' | '/'} Operator
     * @typedef {{ kind: 'field', key: string, as?: 'value' | 'label' }} FieldChip
     * @typedef {{ kind: 'text', value: string }} TextChip
     * @typedef {{ kind: 'number', value: number, percent?: boolean }} NumberChip
     * @typedef {{ kind: 'op', op: Operator }} OpChip
     * @typedef {{ kind: 'paren', paren: '(' | ')' }} ParenChip
     * @typedef {{ kind: 'running' }} RunningChip
     * @typedef {FieldChip | TextChip | NumberChip | OpChip | ParenChip | RunningChip} Chip
     *
     * @typedef {Object} Cell
     * @property {'text' | 'number'} mode
     * @property {Chip[]} chips
     * @property {'auto' | 'set' | 'apply' | 'ignore'} [total] Cómo afecta al total acumulado.
     * @property {'result' | 'expression' | 'both'} [show] Qué imprime una celda numérica.
     * @property {number} [span] Columnas que ocupa (1 por defecto).
     * @property {'left' | 'center' | 'right'} [align]
     * @property {boolean} [bold]
     * @property {number} [size] Tamaño de letra en pt.
     *
     * @typedef {Object} Row
     * @property {Cell[]} cells
     * @property {'show' | 'dash' | 'hide'} [whenEmpty] Qué hacer si todos sus campos-valor están vacíos o en 0.
     * @property {boolean} [hidden] Se calcula pero no se imprime.
     *
     * @typedef {Object} CellResult
     * @property {string} text
     * @property {number | null} value
     * @property {number | null} total Total acumulado después de esta celda.
     * @property {string | null} error
     * @property {Cell} cell
     *
     * @typedef {Object} RowResult
     * @property {CellResult[]} cells
     * @property {boolean} empty Todos sus campos-valor están vacíos o en 0.
     * @property {boolean} hidden No se imprime.
     * @property {Row} row
     *
     * @typedef {Object} RenderContext
     * @property {number} index Posición del registro en la lista original.
     *
     * @typedef {Object} FieldDef
     * @property {string} key
     * @property {string} label
     * @property {'text' | 'number'} type
     * @property {number} [decimals]
     * @property {(record: any, ctx: RenderContext) => unknown} get
     *
     * @typedef {'letter' | 'a4' | 'legal' | 'half-letter'} PaperName
     *
     * @typedef {Object} LayoutSpec
     * @property {PaperName} paper
     * @property {'portrait' | 'landscape'} orientation
     * @property {number} margin mm
     * @property {number} gap mm
     * @property {'grid' | 'size'} mode
     * @property {number} [cols]
     * @property {number} [rows]
     * @property {number} [cardWidth] mm
     * @property {number} [cardHeight] mm
     * @property {boolean} [cutMarks]
     *
     * @typedef {Object} ComputedLayout
     * @property {number} pageWidth
     * @property {number} pageHeight
     * @property {number} margin
     * @property {number} gap
     * @property {number} cols
     * @property {number} rows
     * @property {number} perPage
     * @property {number} cardWidth
     * @property {number} cardHeight
     *
     * @typedef {Object} CardTemplate
     * @property {1} version
     * @property {'cards'} type
     * @property {string} name
     * @property {number[]} columns Anchos relativos de las columnas de la tarjeta (p. ej. [2, 1]).
     * @property {Row[]} rows
     * @property {LayoutSpec} layout
     * @property {{ field: string, dir: 'asc' | 'desc' }} [sortBy]
     *
     * @typedef {Object} EngineOptions
     * @property {FieldDef[]} fields
     * @property {string} [locale]
     * @property {number} [decimals]
     * @property {(key: string) => FieldDef | undefined} [resolveField]
     *   Campos dinámicos no declarados de antemano (p. ej. 'discount:perdida_de_equipo').
     */

    /** @type {Record<PaperName, [number, number]>} Tamaños en mm (ancho, alto) en vertical. */
    const PAPER_SIZES = {
        letter: [215.9, 279.4],
        a4: [210, 297],
        legal: [215.9, 355.6],
        'half-letter': [139.7, 215.9]
    };

    /** @type {Record<Operator, string>} */
    const OP_SYMBOLS = { '+': '+', '-': '-', '*': '×', '/': '÷' };
    const OPERATORS = Object.keys(OP_SYMBOLS);
    const CHIP_KINDS = ['field', 'text', 'number', 'op', 'paren', 'running'];
    const ERROR_TEXT = '—';

    const LIMITS = { rows: 60, columns: 6, chips: 40, text: 200, name: 100 };
    const EMPTY_TEXT = '-';

    /** Elimina el ruido de coma flotante (0.1 + 0.2 = 0.3). */
    const clean = (/** @type {number} */ n) => Number(n.toFixed(10));

    class FormulaError extends Error {}

    // ─── Parser de expresiones (sin eval) ────────────────────────────────────

    /**
     * @typedef {{ t: 'num', v: number, percent: boolean } | { t: 'op', op: Operator } | { t: '(' } | { t: ')' }} Token
     */

    /**
     * Gramática:
     *   expr  := term (('+' | '-') term)*
     *   term  := unary (('*' | '/') unary)*
     *   unary := ('+' | '-') unary | primary
     *   primary := num | '(' expr ')'
     * Porcentaje estilo calculadora: en `a - 3%` el 3% es de `a`; en `a * 3%` vale 0.03.
     * @param {Token[]} tokens
     * @returns {number}
     */
    const evaluateTokens = (tokens) => {
        let pos = 0;
        const peek = () => tokens[pos];

        /** @returns {{ value: number, barePercent: number | null }} */
        const parseTerm = () => {
            const start = pos;
            let value = parseUnary();
            while (true) {
                const tok = peek();
                if (!tok || tok.t !== 'op' || (tok.op !== '*' && tok.op !== '/')) break;
                pos++;
                const right = parseUnary();
                if (tok.op === '/') {
                    if (right === 0) throw new FormulaError('División entre cero');
                    value /= right;
                } else {
                    value *= right;
                }
            }
            const first = tokens[start];
            const isBarePercent = pos === start + 1 && first.t === 'num' && first.percent;
            return { value, barePercent: isBarePercent && first.t === 'num' ? first.v : null };
        };

        /** @returns {number} */
        const parseExpr = () => {
            let value = parseTerm().value;
            while (true) {
                const tok = peek();
                if (!tok || tok.t !== 'op' || (tok.op !== '+' && tok.op !== '-')) break;
                pos++;
                const right = parseTerm();
                const amount = right.barePercent !== null ? (value * right.barePercent) / 100 : right.value;
                value = tok.op === '+' ? value + amount : value - amount;
            }
            return value;
        };

        /** @returns {number} */
        const parseUnary = () => {
            const tok = peek();
            if (tok && tok.t === 'op' && (tok.op === '-' || tok.op === '+')) {
                pos++;
                const v = parseUnary();
                return tok.op === '-' ? -v : v;
            }
            return parsePrimary();
        };

        /** @returns {number} */
        const parsePrimary = () => {
            const tok = peek();
            if (!tok) throw new FormulaError('Fórmula incompleta');
            if (tok.t === 'num') {
                pos++;
                return tok.percent ? tok.v / 100 : tok.v;
            }
            if (tok.t === '(') {
                pos++;
                const v = parseExpr();
                const close = peek();
                if (!close || close.t !== ')') throw new FormulaError('Falta cerrar paréntesis');
                pos++;
                return v;
            }
            throw new FormulaError('Operador fuera de lugar');
        };

        if (tokens.length === 0) throw new FormulaError('Fórmula vacía');
        const result = parseExpr();
        if (pos < tokens.length) throw new FormulaError('Sobran elementos en la fórmula');
        if (!Number.isFinite(result)) throw new FormulaError('Resultado inválido');
        return clean(result);
    };

    // ─── Motor ───────────────────────────────────────────────────────────────

    /**
     * @param {EngineOptions} options
     */
    const createEngine = (options) => {
        const locale = options.locale || 'es-DO';
        const defaultDecimals = options.decimals ?? 2;
        /** @type {Map<string, FieldDef>} */
        const fieldMap = new Map(options.fields.map((fd) => [fd.key, fd]));
        /** @type {Map<number, Intl.NumberFormat>} */
        const formatters = new Map();

        /** @param {number} n @param {number} [decimals] */
        const formatNumber = (n, decimals = defaultDecimals) => {
            let fmt = formatters.get(decimals);
            if (!fmt) {
                fmt = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
                formatters.set(decimals, fmt);
            }
            return fmt.format(n);
        };

        /** @type {Map<string, FieldDef>} Campos dinámicos ya resueltos. */
        const resolvedFields = new Map();

        /** @param {string} key */
        const requireField = (key) => {
            const fd = fieldMap.get(key) || resolvedFields.get(key);
            if (fd) return fd;
            const dynamic = options.resolveField ? options.resolveField(key) : undefined;
            if (!dynamic) throw new FormulaError(`Campo desconocido: ${key}`);
            resolvedFields.set(key, dynamic);
            return dynamic;
        };

        /** @param {unknown} raw */
        const toNumber = (raw) => {
            if (raw === null || raw === undefined || raw === '') return 0;
            const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
            return Number.isFinite(n) ? n : 0;
        };

        /** @param {Chip} chip @returns {chip is FieldChip} */
        const isValueField = (chip) => chip.kind === 'field' && chip.as !== 'label';

        /** Textos y etiquetas de campo: se imprimen pero no se calculan. @param {Chip} chip */
        const isTextLike = (chip) => chip.kind === 'text' || (chip.kind === 'field' && chip.as === 'label');

        /** @param {FieldChip} chip @param {any} record @param {RenderContext} ctx */
        const readNumber = (chip, record, ctx) => {
            const fd = requireField(chip.key);
            const raw = fd.get(record, ctx);
            if (fd.type === 'text') {
                const n = parseFloat(String(raw));
                if (!Number.isFinite(n)) throw new FormulaError(`"${fd.label}" es texto, no número`);
                return n;
            }
            return toNumber(raw);
        };

        /** @param {FieldChip} chip @param {any} record @param {RenderContext} ctx */
        const isFieldEmpty = (chip, record, ctx) => {
            const fd = requireField(chip.key);
            const raw = fd.get(record, ctx);
            if (fd.type === 'number') return toNumber(raw) === 0;
            return raw === null || raw === undefined || String(raw).trim() === '';
        };

        /**
         * Texto que se imprime para un chip.
         * @param {Chip} chip @param {any} record @param {RenderContext} ctx @param {number | null} running
         * @returns {string}
         */
        const chipText = (chip, record, ctx, running) => {
            switch (chip.kind) {
                case 'text': return chip.value;
                case 'number': return chip.percent ? `${chip.value}%` : formatNumber(chip.value);
                case 'op': return OP_SYMBOLS[chip.op];
                case 'paren': return chip.paren;
                case 'running': return formatNumber(running ?? 0);
                case 'field': {
                    const fd = requireField(chip.key);
                    if (chip.as === 'label') return fd.label;
                    const raw = fd.get(record, ctx);
                    if (fd.type === 'number') return formatNumber(toNumber(raw), fd.decimals);
                    return raw === null || raw === undefined ? '' : String(raw);
                }
            }
            return '';
        };

        /** @param {string[]} parts */
        const joinParts = (parts) => parts.filter((p) => p !== '').join(' ');

        /**
         * @param {Chip[]} chips @param {any} record @param {RenderContext} ctx @param {number | null} running
         * @returns {Token[]}
         */
        const tokenize = (chips, record, ctx, running) => {
            /** @type {Token[]} */
            const tokens = [];
            for (const chip of chips) {
                if (isTextLike(chip)) continue;
                switch (chip.kind) {
                    case 'number': tokens.push({ t: 'num', v: chip.value, percent: !!chip.percent }); break;
                    case 'field': tokens.push({ t: 'num', v: readNumber(chip, record, ctx), percent: false }); break;
                    case 'running': tokens.push({ t: 'num', v: running ?? 0, percent: false }); break;
                    case 'op': tokens.push({ t: 'op', op: chip.op }); break;
                    case 'paren': tokens.push(chip.paren === '(' ? { t: '(' } : { t: ')' }); break;
                }
            }
            return tokens;
        };

        /**
         * Evalúa una celda. `running` es el total acumulado de las celdas anteriores (null si aún no hay).
         * @param {Cell} cell @param {any} record @param {RenderContext} ctx @param {number | null} running
         * @returns {CellResult}
         */
        const evaluateCell = (cell, record, ctx, running) => {
            try {
                if (cell.mode === 'text') {
                    const text = joinParts(cell.chips.map((c) => chipText(c, record, ctx, running)));
                    return { text, value: null, total: running, error: null, cell };
                }

                const chips = cell.chips;
                let labelEnd = 0;
                while (labelEnd < chips.length && isTextLike(chips[labelEnd])) labelEnd++;
                let suffixStart = chips.length;
                while (suffixStart > labelEnd && isTextLike(chips[suffixStart - 1])) suffixStart--;
                const label = joinParts(chips.slice(0, labelEnd).map((c) => chipText(c, record, ctx, running)));
                const suffix = joinParts(chips.slice(suffixStart).map((c) => chipText(c, record, ctx, running)));
                const core = chips.slice(labelEnd, suffixStart);

                const leading = core[0];
                const leadingOp = leading && leading.kind === 'op' ? leading.op : null;
                const mode = cell.total || 'auto';
                const applies = mode === 'apply' || (mode === 'auto' && leadingOp !== null);

                let value;
                let newTotal;
                let resultText;
                if (leadingOp) {
                    // "- [comida]": se aplica sobre el total acumulado.
                    const base = running ?? 0;
                    const after = evaluateTokens([{ t: 'num', v: base, percent: false }, ...tokenize(core, record, ctx, running)]);
                    value = leadingOp === '+' || leadingOp === '-'
                        ? clean(Math.abs(after - base))
                        : evaluateTokens(tokenize(core.slice(1), record, ctx, running));
                    newTotal = applies ? after : running;
                    resultText = `${OP_SYMBOLS[leadingOp]} ${formatNumber(value)}`;
                } else {
                    value = evaluateTokens(tokenize(core, record, ctx, running));
                    const sets = mode === 'set' || (mode === 'auto' && running === null);
                    newTotal = sets ? value : running;
                    resultText = formatNumber(value);
                }

                const show = cell.show || 'result';
                const expression = joinParts(chips.map((c) => chipText(c, record, ctx, running)));
                let text;
                if (show === 'expression') text = expression;
                else if (show === 'both') text = `${expression} = ${formatNumber(leadingOp ? (newTotal ?? value) : value)}`;
                else text = joinParts([label, resultText, suffix]);

                return { text, value, total: newTotal, error: null, cell };
            } catch (err) {
                if (!(err instanceof FormulaError)) throw err;
                return { text: ERROR_TEXT, value: null, total: running, error: err.message, cell };
            }
        };

        /**
         * Una fila está vacía si tiene al menos un campo-valor y todos están vacíos o en 0.
         * Las filas con solo textos o etiquetas nunca se consideran vacías.
         * @param {Row} row @param {any} record @param {RenderContext} ctx
         */
        const isRowEmpty = (row, record, ctx) => {
            const fieldsInRow = row.cells.flatMap((c) => c.chips.filter(isValueField));
            if (fieldsInRow.length === 0) return false;
            try {
                return fieldsInRow.every((chip) => isFieldEmpty(chip, record, ctx));
            } catch (err) {
                if (!(err instanceof FormulaError)) throw err;
                return false; // Que el error se vea en la celda en lugar de ocultar la fila.
            }
        };

        /**
         * Evalúa las filas en orden, encadenando el total acumulado de izquierda a derecha
         * y de arriba abajo. Las filas vacías ocultas o con guion no cambian el total.
         * @param {Row[]} rows @param {any} record @param {RenderContext} ctx
         * @returns {RowResult[]}
         */
        const evaluateRows = (rows, record, ctx) => {
            /** @type {number | null} */
            let running = null;
            return rows.map((row) => {
                const empty = isRowEmpty(row, record, ctx);
                const whenEmpty = row.whenEmpty || 'show';
                const frozen = empty && whenEmpty !== 'show';
                let rowRunning = running;
                const cells = row.cells.map((cell) => {
                    if (frozen && whenEmpty === 'dash' && cell.chips.some(isValueField)) {
                        return { text: EMPTY_TEXT, value: null, total: rowRunning, error: null, cell };
                    }
                    const result = evaluateCell(cell, record, ctx, rowRunning);
                    rowRunning = result.total;
                    return result;
                });
                if (!frozen) running = rowRunning;
                return { cells, empty, hidden: !!row.hidden || (empty && whenEmpty === 'hide'), row };
            });
        };

        /**
         * @template T
         * @param {T[]} records @param {{ field: string, dir: 'asc' | 'desc' } | undefined} sortBy
         * @returns {{ record: T, ctx: RenderContext }[]}
         */
        const sortRecords = (records, sortBy) => {
            const items = records.map((record, index) => ({ record, ctx: { index } }));
            if (!sortBy) return items;
            const fd = requireField(sortBy.field);
            const dir = sortBy.dir === 'desc' ? -1 : 1;
            const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
            return items.sort((a, b) => {
                const va = fd.get(a.record, a.ctx);
                const vb = fd.get(b.record, b.ctx);
                const cmp = fd.type === 'number' ? toNumber(va) - toNumber(vb) : collator.compare(String(va ?? ''), String(vb ?? ''));
                return cmp * dir;
            });
        };

        /**
         * Tipo A: evalúa todas las tarjetas y las reparte en páginas.
         * @param {CardTemplate} template @param {any[]} records
         */
        const renderCards = (template, records) => {
            const layout = computeLayout(template.layout);
            const cards = sortRecords(records, template.sortBy).map(({ record, ctx }) => evaluateRows(template.rows, record, ctx));
            return { layout, pages: paginate(cards, layout.perPage) };
        };

        return {
            fields: options.fields,
            formatNumber,
            requireField,
            evaluateCell,
            evaluateRows,
            sortRecords,
            renderCards
        };
    };

    // ─── Diseño de página ────────────────────────────────────────────────────

    /**
     * @param {LayoutSpec} spec
     * @returns {ComputedLayout}
     */
    const computeLayout = (spec) => {
        const [w, h] = PAPER_SIZES[spec.paper] || PAPER_SIZES.letter;
        const landscape = spec.orientation === 'landscape';
        const pageWidth = landscape ? h : w;
        const pageHeight = landscape ? w : h;
        const margin = Math.max(0, spec.margin || 0);
        const gap = Math.max(0, spec.gap || 0);
        const availW = pageWidth - margin * 2;
        const availH = pageHeight - margin * 2;

        let cols, rows, cardWidth, cardHeight;
        if (spec.mode === 'size') {
            cardWidth = Math.min(Math.max(1, spec.cardWidth || 1), availW);
            cardHeight = Math.min(Math.max(1, spec.cardHeight || 1), availH);
            cols = Math.max(1, Math.floor((availW + gap) / (cardWidth + gap)));
            rows = Math.max(1, Math.floor((availH + gap) / (cardHeight + gap)));
        } else {
            cols = Math.max(1, Math.floor(spec.cols || 1));
            rows = Math.max(1, Math.floor(spec.rows || 1));
            cardWidth = (availW - gap * (cols - 1)) / cols;
            cardHeight = (availH - gap * (rows - 1)) / rows;
        }
        return { pageWidth, pageHeight, margin, gap, cols, rows, perPage: cols * rows, cardWidth, cardHeight };
    };

    /**
     * @template T
     * @param {T[]} items @param {number} perPage
     * @returns {T[][]}
     */
    const paginate = (items, perPage) => {
        const size = Math.max(1, Math.floor(perPage));
        /** @type {T[][]} */
        const pages = [];
        for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
        return pages;
    };

    // ─── Validación y (de)serialización ──────────────────────────────────────

    /** @param {unknown} v */
    const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
    /** @param {unknown} v */
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

    /**
     * @param {any} chip @param {string} where
     * @returns {string | null}
     */
    const validateChip = (chip, where) => {
        if (!isObj(chip) || !CHIP_KINDS.includes(chip.kind)) return `${where}: tipo de chip inválido`;
        switch (chip.kind) {
            case 'field':
                if (typeof chip.key !== 'string' || !chip.key || chip.key.length > LIMITS.name) return `${where}: campo sin clave`;
                return chip.as === undefined || chip.as === 'value' || chip.as === 'label' ? null : `${where}: modo de campo inválido`;
            case 'text': return typeof chip.value === 'string' && chip.value.length <= LIMITS.text ? null : `${where}: texto inválido`;
            case 'number': return isNum(chip.value) ? null : `${where}: número inválido`;
            case 'op': return OPERATORS.includes(chip.op) ? null : `${where}: operador inválido`;
            case 'paren': return chip.paren === '(' || chip.paren === ')' ? null : `${where}: paréntesis inválido`;
        }
        return null;
    };

    /**
     * Valida una plantilla importada (p. ej. desde JSON) antes de usarla.
     * @param {unknown} input
     * @returns {{ errors: string[] }}
     */
    const validateTemplate = (input) => {
        /** @type {string[]} */
        const errors = [];
        if (!isObj(input)) return { errors: ['La plantilla debe ser un objeto'] };
        const t = /** @type {any} */ (input);
        if (t.version !== 1) errors.push('Versión de plantilla no soportada');
        if (t.type !== 'cards') errors.push(t.type === 'table' ? 'Las plantillas tipo tabla aún no están disponibles' : 'Tipo de plantilla inválido');
        if (typeof t.name !== 'string' || t.name.length > LIMITS.name) errors.push('Nombre inválido');

        const columnsOk = Array.isArray(t.columns) && t.columns.length >= 1 && t.columns.length <= LIMITS.columns
            && t.columns.every((/** @type {unknown} */ w) => isNum(w) && /** @type {number} */ (w) > 0);
        if (!columnsOk) errors.push('Columnas inválidas');

        if (!Array.isArray(t.rows) || t.rows.length > LIMITS.rows) {
            errors.push('Filas inválidas');
        } else {
            t.rows.forEach((/** @type {any} */ row, /** @type {number} */ i) => {
                const rowWhere = `Fila ${i + 1}`;
                if (!isObj(row) || !Array.isArray(row.cells)) return errors.push(`${rowWhere}: celdas inválidas`);
                if (row.whenEmpty !== undefined && !['show', 'dash', 'hide'].includes(row.whenEmpty)) errors.push(`${rowWhere}: opción de fila vacía inválida`);
                let spanSum = 0;
                row.cells.forEach((/** @type {any} */ cell, /** @type {number} */ k) => {
                    const where = `${rowWhere}, celda ${k + 1}`;
                    if (!isObj(cell) || (cell.mode !== 'text' && cell.mode !== 'number')) return errors.push(`${where}: modo inválido`);
                    if (!Array.isArray(cell.chips) || cell.chips.length > LIMITS.chips) return errors.push(`${where}: chips inválidos`);
                    if (cell.span !== undefined && !(Number.isInteger(cell.span) && cell.span >= 1)) errors.push(`${where}: span inválido`);
                    spanSum += Number.isInteger(cell.span) ? cell.span : 1;
                    if (cell.total !== undefined && !['auto', 'set', 'apply', 'ignore'].includes(cell.total)) errors.push(`${where}: total inválido`);
                    if (cell.show !== undefined && !['result', 'expression', 'both'].includes(cell.show)) errors.push(`${where}: modo de vista inválido`);
                    if (cell.align !== undefined && !['left', 'center', 'right'].includes(cell.align)) errors.push(`${where}: alineación inválida`);
                    if (cell.size !== undefined && !(isNum(cell.size) && cell.size > 0 && cell.size <= 72)) errors.push(`${where}: tamaño inválido`);
                    cell.chips.forEach((/** @type {any} */ chip, /** @type {number} */ j) => {
                        const err = validateChip(chip, `${where}, chip ${j + 1}`);
                        if (err) errors.push(err);
                    });
                });
                if (columnsOk && spanSum > t.columns.length) errors.push(`${rowWhere}: ocupa más columnas de las que tiene la tarjeta`);
            });
        }

        const l = t.layout;
        if (!isObj(l)) {
            errors.push('Diseño de página inválido');
        } else {
            if (!(l.paper in PAPER_SIZES)) errors.push('Tamaño de papel inválido');
            if (l.orientation !== 'portrait' && l.orientation !== 'landscape') errors.push('Orientación inválida');
            if (!isNum(l.margin) || l.margin < 0 || !isNum(l.gap) || l.gap < 0) errors.push('Margen o separación inválidos');
            if (l.mode === 'grid') {
                if (!isNum(l.cols) || l.cols < 1 || !isNum(l.rows) || l.rows < 1) errors.push('Columnas o filas inválidas');
            } else if (l.mode === 'size') {
                if (!isNum(l.cardWidth) || l.cardWidth <= 0 || !isNum(l.cardHeight) || l.cardHeight <= 0) errors.push('Tamaño de tarjeta inválido');
            } else {
                errors.push('Modo de diseño inválido');
            }
        }

        if (t.sortBy !== undefined && !(isObj(t.sortBy) && typeof t.sortBy.field === 'string' && (t.sortBy.dir === 'asc' || t.sortBy.dir === 'desc'))) {
            errors.push('Orden inválido');
        }
        return { errors };
    };

    /** @param {CardTemplate} template */
    const serializeTemplate = (template) => JSON.stringify(template, null, 2);

    /**
     * @param {string} json
     * @returns {CardTemplate}
     */
    const parseTemplate = (json) => {
        const data = JSON.parse(json);
        const { errors } = validateTemplate(data);
        if (errors.length) throw new Error(`Plantilla inválida:\n${errors.join('\n')}`);
        return data;
    };

    return {
        PAPER_SIZES,
        OP_SYMBOLS,
        createEngine,
        computeLayout,
        paginate,
        validateTemplate,
        serializeTemplate,
        parseTemplate
    };
});
