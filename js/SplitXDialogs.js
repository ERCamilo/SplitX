// @ts-check
/**
 * SplitXDialogs.js
 * Sistema de notificaciones toast y diálogos modales personalizados (Alert / Confirm / Choice).
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else {
        root.SplitXDialogs = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /** @param {unknown} v */
    const defaultEscape = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => (/** @type {Record<string, string>} */ ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }))[ch]);

    /** @type {Record<string, { container: string, defaultIcon: string, btnPrimary: string }>} */
    const TYPE_STYLES = {
        danger: {
            container: 'bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800',
            defaultIcon: 'fa-triangle-exclamation',
            btnPrimary: 'bg-rose-600 hover:bg-rose-700 text-white'
        },
        warning: {
            container: 'bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800',
            defaultIcon: 'fa-triangle-exclamation',
            btnPrimary: 'bg-amber-600 hover:bg-amber-700 text-white'
        },
        success: {
            container: 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800',
            defaultIcon: 'fa-circle-check',
            btnPrimary: 'bg-emerald-600 hover:bg-emerald-700 text-white'
        },
        info: {
            container: 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800',
            defaultIcon: 'fa-circle-info',
            btnPrimary: 'bg-blue-600 hover:bg-blue-700 text-white'
        },
        question: {
            container: 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800',
            defaultIcon: 'fa-circle-question',
            btnPrimary: 'bg-blue-600 hover:bg-blue-700 text-white'
        }
    };

    /**
     * @param {{
     *   documentRef?: any,
     *   escapeHTML?: (v: unknown) => string,
     *   toastMs?: number
     * }} [options]
     */
    const createDialogs = (options = {}) => {
        const doc = options.documentRef || (typeof document !== 'undefined' ? document : null);
        const escapeHTML = typeof options.escapeHTML === 'function' ? options.escapeHTML : defaultEscape;
        const toastMs = options.toastMs !== undefined ? options.toastMs : 3500;

        /** @type {((val: any) => void) | null} */
        let activeDialogResolver = null;

        /** @param {string} message @param {string} [type] */
        const showToast = (message, type = 'success') => {
            if (!doc) return;
            const previous = doc.getElementById('appToast');
            if (previous) previous.remove();
            const toast = doc.createElement('div');
            toast.id = 'appToast';
            toast.className = `fixed right-4 bottom-20 sm:bottom-4 z-[100] max-w-sm px-4 py-3 rounded-lg shadow-lg border text-sm font-medium ${type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`;
            toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : 'fa-circle-info'} mr-2"></i>${escapeHTML(message)}`;
            doc.body.appendChild(toast);
            if (toastMs > 0) setTimeout(() => toast.remove(), toastMs);
        };

        /** @param {any} result */
        const closeCustomDialog = (result) => {
            const modal = doc ? doc.getElementById('customDialogModal') : null;
            if (modal) modal.classList.add('hidden');
            if (activeDialogResolver) {
                const resolve = activeDialogResolver;
                activeDialogResolver = null;
                resolve(result);
            }
        };

        /**
         * @param {{
         *   title?: string,
         *   message?: string,
         *   icon?: string,
         *   type?: string,
         *   buttons?: Array<{ label: string, value: any, icon?: string, isPrimary?: boolean, class?: string }>
         * }} opts
         */
        const showCustomDialog = ({
            title = 'Atención',
            message = '',
            icon = 'fa-circle-info',
            type = 'info',
            buttons = []
        }) => new Promise((resolve) => {
            activeDialogResolver = resolve;

            const modal = doc ? doc.getElementById('customDialogModal') : null;
            if (!modal) {
                activeDialogResolver = null;
                resolve(false);
                return;
            }
            const iconCont = doc.getElementById('dialogIconContainer');
            const iconEl = doc.getElementById('dialogIcon');
            const titleEl = doc.getElementById('dialogTitle');
            const msgEl = doc.getElementById('dialogMessage');
            const actionsEl = doc.getElementById('dialogActions');

            const currentStyle = TYPE_STYLES[type] || TYPE_STYLES.info;
            if (iconCont) iconCont.className = `w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 text-xl shadow-xs ${currentStyle.container}`;
            if (iconEl) iconEl.className = `fa-solid ${icon || currentStyle.defaultIcon}`;
            if (titleEl) titleEl.textContent = title;
            if (msgEl) msgEl.innerHTML = typeof message === 'string' ? escapeHTML(message).replace(/\n/g, '<br>') : '';

            if (actionsEl) {
                actionsEl.innerHTML = '';
                buttons.forEach(btn => {
                    const b = doc.createElement('button');
                    b.type = 'button';
                    const baseClass = 'px-4 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-2xs cursor-pointer';
                    const customClass = btn.class || (btn.isPrimary
                        ? currentStyle.btnPrimary
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 border border-slate-200/80 dark:border-slate-700 bg-white dark:bg-slate-800');
                    b.className = `${baseClass} ${customClass}`;
                    b.innerHTML = `${btn.icon ? `<i class="fa-solid ${escapeHTML(btn.icon)}"></i> ` : ''}${escapeHTML(btn.label)}`;
                    b.onclick = () => closeCustomDialog(btn.value);
                    actionsEl.appendChild(b);
                });
            }

            modal.classList.remove('hidden');
        });

        /** @param {any} msgOrOpts @param {string} [optionalTitle] */
        const showCustomAlert = (msgOrOpts, optionalTitle = 'Atención') => {
            const opts = typeof msgOrOpts === 'string'
                ? { title: optionalTitle, message: msgOrOpts, type: 'info', icon: 'fa-circle-info' }
                : (msgOrOpts || {});
            return showCustomDialog({
                title: opts.title || 'Atención',
                message: opts.message || '',
                icon: opts.icon || 'fa-circle-info',
                type: opts.type || 'info',
                buttons: [{ label: opts.confirmText || 'Entendido', value: true, isPrimary: true, icon: 'fa-check' }]
            });
        };

        /** @param {any} msgOrOpts @param {string} [optionalTitle] */
        const showCustomConfirm = (msgOrOpts, optionalTitle = '¿Confirmar acción?') => {
            const opts = typeof msgOrOpts === 'string'
                ? { title: optionalTitle, message: msgOrOpts, type: 'warning', icon: 'fa-triangle-exclamation', confirmText: 'Aceptar', cancelText: 'Cancelar' }
                : (msgOrOpts || {});
            return showCustomDialog({
                title: opts.title || '¿Confirmar acción?',
                message: opts.message || '',
                icon: opts.icon || (opts.type === 'danger' ? 'fa-triangle-exclamation' : 'fa-circle-question'),
                type: opts.type || 'warning',
                buttons: [
                    { label: opts.cancelText || 'Cancelar', value: false, isPrimary: false },
                    {
                        label: opts.confirmText || 'Aceptar',
                        value: true,
                        isPrimary: true,
                        class: opts.confirmClass,
                        icon: opts.confirmIcon || (opts.type === 'danger' ? 'fa-trash' : 'fa-check')
                    }
                ]
            });
        };

        /** @param {{ title?: string, message?: string, icon?: string, type?: string, choices?: any[] }} opts */
        const showCustomChoice = ({
            title = 'Elige una opción',
            message = '',
            icon = 'fa-circle-question',
            type = 'question',
            choices = []
        }) => showCustomDialog({
            title,
            message,
            icon,
            type,
            buttons: choices.map(c => ({
                label: c.label,
                value: c.value,
                icon: c.icon,
                isPrimary: c.isPrimary,
                class: c.class
            }))
        });

        return { showToast, closeCustomDialog, showCustomDialog, showCustomAlert, showCustomConfirm, showCustomChoice };
    };

    return { createDialogs };
});
