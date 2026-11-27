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
        /** @type {Array<{ opts: any, resolve: (val: any) => void }>} */
        const dialogQueue = [];

        /** @type {any} */
        let toastTimer = null;

        /**
         * @param {string} message
         * @param {string} [type]
         * @param {{ actionLabel?: string, onAction?: () => void, durationMs?: number } | null} [opts]
         */
        const showToast = (message, type = 'success', opts = null) => {
            if (!doc) return;
            if (toastTimer) {
                clearTimeout(toastTimer);
                toastTimer = null;
            }
            const previous = doc.getElementById('appToast');
            if (previous) previous.remove();
            const priorFocus = doc.activeElement || null;
            const toast = doc.createElement('div');
            toast.id = 'appToast';
            if (typeof toast.setAttribute === 'function') {
                toast.setAttribute('role', 'status');
            }
            const toneClass = type === 'success'
                ? 'bg-emerald-50 dark:bg-emerald-950/95 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                : type === 'error'
                    ? 'bg-rose-50 dark:bg-rose-950/95 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
                    : type === 'info'
                        ? 'bg-blue-50 dark:bg-blue-950/95 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200'
                        : 'bg-amber-50 dark:bg-amber-950/95 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200';
            const iconName = type === 'success'
                ? 'fa-circle-check'
                : type === 'error'
                    ? 'fa-circle-exclamation'
                    : type === 'warning'
                        ? 'fa-triangle-exclamation'
                        : 'fa-circle-info';
            const host = doc.getElementById('toastRegion');
            const posClass = host
                ? 'pointer-events-auto max-w-sm'
                : 'fixed right-4 bottom-20 sm:bottom-4 z-[100] max-w-sm';
            toast.className = `${posClass} px-3.5 py-2.5 rounded-lg shadow-lg border text-sm font-medium flex items-center gap-2 ${toneClass}`;
            toast.innerHTML = `<span class="flex-1 min-w-0"><i class="fa-solid ${iconName} mr-2" aria-hidden="true"></i>${escapeHTML(message)}</span>`;

            const dismissToast = (restoreFocus = false) => {
                if (toastTimer) {
                    clearTimeout(toastTimer);
                    toastTimer = null;
                }
                const hadFocus = restoreFocus && doc.activeElement && typeof toast.contains === 'function' && toast.contains(doc.activeElement);
                toast.remove();
                if (hadFocus && priorFocus && typeof priorFocus.focus === 'function') {
                    try { priorFocus.focus(); } catch (_) { /* ignore */ }
                }
            };

            const effectiveMs = opts && opts.durationMs !== undefined ? opts.durationMs : toastMs;
            const scheduleDismiss = () => {
                if (toastTimer) {
                    clearTimeout(toastTimer);
                    toastTimer = null;
                }
                if (effectiveMs > 0) {
                    toastTimer = setTimeout(() => {
                        toastTimer = null;
                        // Pause dismissal while a control inside the toast holds keyboard focus
                        if (doc.activeElement && typeof toast.contains === 'function' && toast.contains(doc.activeElement)) {
                            return;
                        }
                        toast.remove();
                    }, effectiveMs);
                }
            };

            if (opts && opts.actionLabel && typeof opts.onAction === 'function') {
                const actionBtn = doc.createElement('button');
                actionBtn.type = 'button';
                actionBtn.textContent = String(opts.actionLabel);
                actionBtn.className = 'shrink-0 min-h-[24px] px-2.5 py-1 rounded-md text-xs font-bold bg-slate-900/10 hover:bg-slate-900/20 dark:bg-white/15 dark:hover:bg-white/25 transition-colors cursor-pointer';
                let fired = false;
                actionBtn.onclick = () => {
                    if (fired) return;
                    fired = true;
                    dismissToast(true);
                    opts.onAction && opts.onAction();
                };
                toast.appendChild(actionBtn);
            }

            const closeBtn = doc.createElement('button');
            closeBtn.type = 'button';
            if (typeof closeBtn.setAttribute === 'function') {
                closeBtn.setAttribute('aria-label', 'Cerrar notificación');
                closeBtn.setAttribute('title', 'Cerrar notificación');
            }
            closeBtn.className = 'shrink-0 min-w-[24px] min-h-[24px] w-6 h-6 rounded-md flex items-center justify-center opacity-70 hover:opacity-100 hover:bg-slate-900/10 dark:hover:bg-white/15 transition-all cursor-pointer';
            closeBtn.innerHTML = '<i class="fa-solid fa-xmark text-xs" aria-hidden="true"></i>';
            closeBtn.onclick = () => dismissToast(true);
            toast.appendChild(closeBtn);

            if (typeof toast.addEventListener === 'function') {
                toast.addEventListener('focusin', () => {
                    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
                });
                toast.addEventListener('focusout', () => scheduleDismiss());
            }

            (host || doc.body).appendChild(toast);
            if (typeof doc.ariaNotify === 'function') {
                try {
                    const announcement = opts && opts.actionLabel ? `${message}. Acciones disponibles.` : String(message);
                    doc.ariaNotify(announcement);
                } catch (_) { /* ignore */ }
            }
            scheduleDismiss();
        };

        /** @param {{ title?: string, message?: string, icon?: string, type?: string, buttons?: Array<{ label: string, value: any, icon?: string, isPrimary?: boolean, class?: string }> }} opts @param {(val: any) => void} resolve */
        const presentDialog = ({
            title = 'Atención',
            message = '',
            icon = 'fa-circle-info',
            type = 'info',
            buttons = []
        }, resolve) => {
            activeDialogResolver = resolve;

            const modal = doc ? doc.getElementById('customDialogModal') : null;
            if (!modal) {
                activeDialogResolver = null;
                resolve(false);
                pumpQueue();
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
        };

        const pumpQueue = () => {
            if (activeDialogResolver || !dialogQueue.length) return;
            const next = dialogQueue.shift();
            if (next) presentDialog(next.opts, next.resolve);
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
            if (dialogQueue.length) {
                Promise.resolve().then(pumpQueue);
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
        const showCustomDialog = (opts) => new Promise((resolve) => {
            if (activeDialogResolver) {
                dialogQueue.push({ opts, resolve });
                return;
            }
            presentDialog(opts, resolve);
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
