/**
 * User-defined print-only numeric variables. No eval(), no payroll mutation.
 * Expressions use built-in field keys (gross, days, loan:adelanto), a custom
 * variable id (transporte), operators + - * /, parentheses and postfix %.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SplitXVariables = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const ID = /^[a-z][a-z0-9_]{0,31}$/;
    const MAX_DEFINITIONS = 50;
    const MAX_FORMULA = 180;
    const TOKEN = /\s*(\d+(?:\.\d+)?|[a-zA-Z_][a-zA-Z_0-9:]*|[()+\-*/%])\s*/y;
    const isNumber = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e12;

    const tokenize = (formula) => {
        if (typeof formula !== 'string' || formula.length > MAX_FORMULA) throw new Error('Fórmula demasiado larga o inválida.');
        const out = []; let position = 0;
        while (position < formula.length) {
            TOKEN.lastIndex = position;
            const match = TOKEN.exec(formula);
            if (!match) throw new Error('Símbolo inválido en la fórmula, posición ' + (position + 1));
            position = TOKEN.lastIndex;
            out.push(match[1]);
            if (out.length > 100) throw new Error('La fórmula contiene demasiados elementos.');
        }
        if (!out.length) throw new Error('La fórmula está vacía.');
        return out;
    };

    const references = formula => tokenize(formula).filter(t => /^[a-zA-Z_]/.test(t));

    const evaluate = (formula, lookup) => {
        const tokens = Array.isArray(formula) ? formula : tokenize(formula);
        let at = 0;
        const peek = () => tokens[at];
        const take = () => tokens[at++];
        const primary = () => {
            const t = take();
            if (t === undefined) throw new Error('La fórmula termina antes de completar el cálculo.');
            if (t === '(') {
                const v = expression();
                if (take() !== ')') throw new Error('Falta cerrar un paréntesis.');
                return v;
            }
            if (/^\d/.test(t)) return Number(t);
            if (/^[a-zA-Z_]/.test(t)) return lookup(t);
            throw new Error('Valor inesperado: ' + t);
        };
        const unary = () => {
            if (peek() === '+') { take(); return unary(); }
            if (peek() === '-') { take(); return -unary(); }
            let result = primary();
            if (peek() === '%') { take(); result /= 100; }
            return result;
        };
        const term = () => {
            let x = unary();
            while (peek() === '*' || peek() === '/') {
                const op = take(), rhs = unary();
                if (op === '/' && rhs === 0) throw new Error('División entre cero.');
                x = op === '*' ? x * rhs : x / rhs;
                if (!isNumber(x)) throw new Error('Resultado fuera de rango.');
            }
            return x;
        };
        const expression = () => {
            let x = term();
            while (peek() === '+' || peek() === '-') {
                const op = take(), rhs = term();
                x = op === '+' ? x + rhs : x - rhs;
                if (!isNumber(x)) throw new Error('Resultado fuera de rango.');
            }
            return x;
        };
        const result = expression();
        if (at !== tokens.length || !isNumber(result)) throw new Error('Fórmula incompleta o resultado inválido.');
        return Number(result.toFixed(8));
    };

    const validateDefinitions = (definitions, base) => {
        if (!Array.isArray(definitions) || definitions.length > MAX_DEFINITIONS)
            throw new Error('Máximo de 50 variables personalizadas.');
        const ids = new Set();
        const builtin = new Set((base?.fields || []).map(f => f.key));
        for (const def of definitions) {
            if (!def || !ID.test(def.id) || typeof def.label !== 'string' ||
                !def.label.trim() || def.label.length > 60) throw new Error('ID o nombre de variable inválido.');
            if (ids.has(def.id)) throw new Error('Variable duplicada: ' + def.id);
            ids.add(def.id);
            if (def.kind === 'fixed') {
                if (!isNumber(def.value)) throw new Error('Valor numérico inválido en ' + def.id);
                if (def.overrides !== undefined) {
                    if (!def.overrides || typeof def.overrides !== 'object' || Array.isArray(def.overrides) ||
                        Object.keys(def.overrides).length > 2000 ||
                        Object.values(def.overrides).some(v => !isNumber(v))) {
                        throw new Error('Valores por empleado inválidos en ' + def.id);
                    }
                }
            } else if (def.kind === 'formula') {
                evaluate(def.formula, () => 1); // Formula grammar, no code execution.
            } else throw new Error('Tipo de variable inválido en ' + def.id);
        }
        const byId = new Map(definitions.map(d => [d.id, d]));
        const dep = new Map();
        for (const def of definitions) {
            if (def.kind !== 'formula') continue;
            const refs = references(def.formula);
            const related = [];
            for (const ref of refs) {
                const id = ref.startsWith('custom:') ? ref.slice(7) : ref;
                if (byId.has(id)) related.push(id);
                else if (!builtin.has(ref) && !(base?.resolveField?.(ref))) {
                    throw new Error('Campo no encontrado: ' + ref);
                }
            }
            dep.set(def.id, related);
        }
        const visited = new Set(), active = new Set();
        const visit = id => {
            if (active.has(id)) throw new Error('Dependencia circular entre variables: ' + id);
            if (visited.has(id)) return;
            active.add(id);
            for (const child of dep.get(id) || []) visit(child);
            active.delete(id); visited.add(id);
        };
        for (const id of byId.keys()) visit(id);
        return true;
    };

    const createFieldSet = (definitions, base, SB) => {
        validateDefinitions(definitions, base);
        const byId = new Map(definitions.map(d => [d.id, d]));
        const builtin = new Map(base.fields.map(f => [f.key, f]));
        const employeeKey = record => record?.employeeNumber != null
            ? String(record.employeeNumber) : record?.id != null ? 'id:' + record.id : null;
        const lookup = (name, record, ctx, visiting) => {
            const id = name.startsWith('custom:') ? name.slice(7) : name;
            const own = byId.get(id);
            if (own) {
                if (visiting.has(id)) throw new Error('Variable circular: ' + id);
                if (own.kind === 'fixed') {
                    const who = employeeKey(record);
                    return who && Object.prototype.hasOwnProperty.call(own.overrides || {}, who)
                        ? own.overrides[who] : own.value;
                }
                visiting.add(id);
                try {
                    return evaluate(own.formula, ref => lookup(ref, record, ctx, visiting));
                } finally { visiting.delete(id); }
            }
            const field = builtin.get(name) || base.resolveField(name);
            if (!field) throw new Error('Campo no encontrado: ' + name);
            const raw = field.get(record, ctx);
            if (raw === '' || raw === null || raw === undefined) return 0;
            const value = typeof raw === 'number' ? raw : Number(raw);
            if (!isNumber(value)) throw new Error('Campo no numérico: ' + name);
            return value;
        };
        const fields = definitions.map(d => ({
            key: 'custom:' + d.id, label: d.label, type: 'number',
            get: (record, ctx) => {
                try { return lookup('custom:' + d.id, record, ctx, new Set()); }
                catch (e) { throw new SB.FormulaError(e.message); }
            }
        }));
        return { fields, listVariables: () => definitions.map(d => ({ key: 'custom:' + d.id, label: d.label })) };
    };

    return { tokenize, references, evaluate, validateDefinitions, createFieldSet };
});
