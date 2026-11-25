// @ts-check
/**
 * SplitXActionDelegation.js
 * Despachador declarativo de eventos por lista blanca (data-sx-click, data-sx-change,
 * data-sx-input, data-sx-blur, data-sx-enter). Elimina handlers inline para habilitar CSP estricto.
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        root.SplitXActionDelegation = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /**
     * @typedef {(el: any, event: any, arg?: string, arg2?: string) => any} ActionHandler
     */

    /**
     * Instala listeners delegados sobre `root` despachando únicamente acciones presentes en `handlers`.
     * @param {{ addEventListener: Function, removeEventListener?: Function }} root
     * @param {Record<string, ActionHandler>} handlers
     * @returns {() => void}
     */
    const installActionDelegation = (root, handlers) => {
        if (!root || typeof root.addEventListener !== 'function') return () => {};
        const own = Object.prototype.hasOwnProperty;

        /** @param {string} attr @param {string} datasetKey */
        const makeListener = (attr, datasetKey) => (/** @type {any} */ event) => {
            const target = event?.target;
            if (!target || typeof target.closest !== 'function') return;
            const el = target.closest(`[${attr}]`);
            if (!el || !el.dataset) return;
            const action = el.dataset[datasetKey];
            if (!action || !own.call(handlers, action)) return;
            const fn = handlers[action];
            if (typeof fn === 'function') {
                fn(el, event, el.dataset.sxArg, el.dataset.sxArg2);
            }
        };

        const onClick = makeListener('data-sx-click', 'sxClick');
        const onChange = makeListener('data-sx-change', 'sxChange');
        const onInput = makeListener('data-sx-input', 'sxInput');
        const onFocusOut = makeListener('data-sx-blur', 'sxBlur');
        const enterDelegate = makeListener('data-sx-enter', 'sxEnter');
        const onKeyDown = (/** @type {any} */ event) => {
            if (event?.key === 'Enter') enterDelegate(event);
        };

        root.addEventListener('click', onClick);
        root.addEventListener('change', onChange);
        root.addEventListener('input', onInput);
        root.addEventListener('focusout', onFocusOut);
        root.addEventListener('keydown', onKeyDown);

        return () => {
            if (typeof root.removeEventListener !== 'function') return;
            root.removeEventListener('click', onClick);
            root.removeEventListener('change', onChange);
            root.removeEventListener('input', onInput);
            root.removeEventListener('focusout', onFocusOut);
            root.removeEventListener('keydown', onKeyDown);
        };
    };

    return { installActionDelegation };
});
