const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SplitXActionDelegation = require('../js/SplitXActionDelegation.js');

const makeFakeRoot = () => {
    const listeners = new Map();
    return {
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: (type) => listeners.delete(type),
        dispatch: (type, event) => {
            const fn = listeners.get(type);
            if (fn) fn(event);
        }
    };
};

const makeTarget = (dataset = {}, props = {}) => {
    const el = {
        dataset,
        ...props,
        closest: (sel) => {
            const attr = sel.slice(1, -1); // e.g. data-sx-click
            const camel = attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            return dataset[camel] !== undefined ? el : null;
        }
    };
    return el;
};

describe('SplitXActionDelegation: allowlisted declarative event delegation (strict CSP)', () => {
    test('dispatches click, change, input, focusout (blur) and Enter keydown actions with dataset args', () => {
        const root = makeFakeRoot();
        const calls = [];
        const detach = SplitXActionDelegation.installActionDelegation(root, {
            setMode: (el, _e, arg) => calls.push(['setMode', arg]),
            setAdjust: (_el, _e, arg, arg2) => calls.push(['setAdjust', arg, arg2]),
            updateInv: (el, _e, arg) => calls.push(['updateInv', arg, el.value]),
            updateColor: (el, _e, arg) => calls.push(['updateColor', arg, el.value]),
            updateLoanFund: (el) => calls.push(['updateLoanFund', el.value]),
            addDenom: () => calls.push(['addDenom'])
        });

        // Click on nested icon resolves to button via closest()
        const btn = makeTarget({ sxClick: 'setMode', sxArg: 'normal' });
        const iconChild = { closest: (sel) => btn.closest(sel) };
        root.dispatch('click', { target: iconChild });

        root.dispatch('click', { target: makeTarget({ sxClick: 'setAdjust', sxArg: 'bonus', sxArg2: 'percent' }) });
        root.dispatch('change', { target: makeTarget({ sxChange: 'updateInv', sxArg: '1000' }, { value: '5' }) });
        root.dispatch('input', { target: makeTarget({ sxInput: 'updateColor', sxArg: '500' }, { value: '#10b981' }) });
        root.dispatch('focusout', { target: makeTarget({ sxBlur: 'updateLoanFund' }, { value: '250' }) });
        root.dispatch('keydown', { key: 'a', target: makeTarget({ sxEnter: 'addDenom' }) });
        root.dispatch('keydown', { key: 'Enter', target: makeTarget({ sxEnter: 'addDenom' }) });

        assert.deepEqual(calls, [
            ['setMode', 'normal'],
            ['setAdjust', 'bonus', 'percent'],
            ['updateInv', '1000', '5'],
            ['updateColor', '500', '#10b981'],
            ['updateLoanFund', '250'],
            ['addDenom']
        ]);

        detach();
    });

    test('unknown or prototype-chain action names are ignored safely (allowlist enforcement)', () => {
        const root = makeFakeRoot();
        const calls = [];
        SplitXActionDelegation.installActionDelegation(root, {
            safe: () => calls.push('safe')
        });

        assert.doesNotThrow(() => {
            root.dispatch('click', { target: makeTarget({ sxClick: 'constructor' }) });
            root.dispatch('click', { target: makeTarget({ sxClick: 'toString' }) });
            root.dispatch('click', { target: makeTarget({ sxClick: 'alert(1)' }) });
        });
        assert.deepEqual(calls, []);
    });
});
