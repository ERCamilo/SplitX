// @ts-check
/**
 * SplitXConfigUI.js
 * Modal de configuración: presets de moneda, denominaciones, apariencia y personalización de billetes (Issue #28).
 */
(function (/** @type {any} */ root, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory(require('./SplitXCurrencies.js'));
    } else {
        root.SplitXConfigUI = factory(root.SplitXCurrencies);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, /** @param {any} SplitXCurrencies */ function (SplitXCurrencies) {
    'use strict';

    /**
     * @param {{
     *   getState: () => any,
     *   saveData: () => void,
     *   CURRENCY_PRESETS: Record<string, any>,
     *   BILL_COLORS: Record<number, any>,
     *   isCoin: (d: number) => boolean,
     *   escapeHTML: (s: unknown) => string,
     *   sanitizeHexColor: (c: unknown) => string,
     *   getBillImage: (d: number) => string | null,
     *   getBillStyle: (d: number) => string,
     *   getCurrencySymbol: () => string,
     *   createCardEl: (emp: any, idx: number, isPreview?: boolean) => any,
     *   showToast: (msg: string, type?: string) => void,
     *   showCustomConfirm: (opts: any) => Promise<boolean>
     * }} deps
     */
    const createConfigUI = (deps) => {
        const hasDom = () => typeof document !== 'undefined';

        const renderConfigModal = () => {
            if (!hasDom()) return;
            const state = deps.getState();

            const presetGrid = document.getElementById('currencyPresetGrid');
            if (presetGrid) {
                const activeCurr = state.currency || 'DOP';
                let presetsHTML = '';
                Object.keys(deps.CURRENCY_PRESETS).forEach(key => {
                    const p = deps.CURRENCY_PRESETS[key];
                    const isSelected = activeCurr === p.code;
                    presetsHTML += `
                        <button type="button" data-sx-click="setCurrencyPreset" data-sx-arg="${key}"
                            class="p-2 rounded-xl border text-left transition-all flex items-center justify-between gap-1.5 ${isSelected ? 'bg-blue-50/90 dark:bg-blue-950/70 border-blue-500 dark:border-blue-500 shadow-xs ring-1 ring-blue-500/20' : 'bg-white dark:bg-slate-900 border-slate-200/90 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-850'}">
                            <div class="min-w-0 flex-grow">
                                <div class="flex items-center gap-1.5 flex-wrap">
                                    <span class="text-base leading-none">${p.flag}</span>
                                    <span class="text-xs font-bold text-slate-800 dark:text-slate-100">${p.code}</span>
                                    <span class="text-[10px] font-mono px-1 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-bold border border-slate-200 dark:border-slate-700">${p.symbol}</span>
                                </div>
                                <div class="text-[10px] text-slate-500 dark:text-slate-400 truncate mt-0.5" title="${p.name}">${p.name}</div>
                            </div>
                            ${isSelected ? '<i class="fa-solid fa-circle-check text-blue-600 dark:text-blue-400 text-sm shrink-0"></i>' : ''}
                        </button>
                    `;
                });
                presetGrid.innerHTML = presetsHTML;
            }

            const symInput = /** @type {HTMLInputElement | null} */ (document.getElementById('currencySymbolInput'));
            if (symInput) symInput.value = state.currencySymbol || 'RD$';
            const addPrefix = document.getElementById('addDenomSymbolPrefix');
            if (addPrefix) addPrefix.innerText = state.currencySymbol || 'RD$';

            const container = document.getElementById('denomListConfig');
            if (container) {
                container.replaceChildren();
                state.denominations.forEach((/** @type {number} */ d) => {
                    const chip = document.createElement('div');
                    const isCoinDenom = deps.isCoin(d);
                    chip.className = `px-3 py-1.5 rounded-lg text-xs font-bold font-mono flex items-center gap-2 border shadow-2xs ${isCoinDenom ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800/80' : 'bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-300 border-blue-200 dark:border-blue-800/80'}`;
                    chip.innerHTML = `
                        <span>${deps.escapeHTML(state.currencySymbol || '')} ${d} ${isCoinDenom ? '<span class="text-[9px] font-sans font-normal opacity-70">🪙</span>' : '<span class="text-[9px] font-sans font-normal opacity-70">💵</span>'}</span>
                        <button type="button" data-sx-click="removeDenom" data-sx-arg="${d}" class="text-slate-400 hover:text-rose-500 transition-colors -mr-1" title="Eliminar denominación" aria-label="Eliminar denominación ${d}"><i class="fa-solid fa-xmark text-xs"></i></button>
                    `;
                    container.appendChild(chip);
                });
            }
        };

        const renderAppearancePreviewCard = () => {
            if (!hasDom()) return;
            const state = deps.getState();
            const previewContainer = document.getElementById('appearanceLivePreviewCard');
            if (!previewContainer) return;
            previewContainer.replaceChildren();

            let sampleEmp;
            if (state.employees && state.employees.length > 0) {
                const first = state.employees[0];
                sampleEmp = JSON.parse(JSON.stringify(first));
                if (!sampleEmp.distribution || Object.keys(sampleEmp.distribution).length === 0) {
                    sampleEmp.distribution = { 2000: 7, 1000: 1, 500: 1, 50: 1, 25: 1, 1: 3 };
                }
            } else {
                sampleEmp = {
                    id: 'preview-sample',
                    name: 'Juan Pérez',
                    amount: 15578,
                    paid: false,
                    status: 'ok',
                    distribution: { 2000: 7, 1000: 1, 500: 1, 50: 1, 25: 1, 1: 3 },
                    payroll: {
                        gross: 16778,
                        bonuses: 0,
                        discounts: 0,
                        loans: 1200,
                        afterDiscounts: 16778,
                        calculatedNet: 15578,
                        net: 15578
                    }
                };
            }

            const card = deps.createCardEl(sampleEmp, 0, true);
            if (card) previewContainer.appendChild(card);
        };

        const renderAppearanceConfig = () => {
            if (!hasDom()) return;
            const state = deps.getState();
            renderAppearancePreviewCard();

            const switchImg = /** @type {HTMLInputElement | null} */ (document.getElementById('switchUseImages'));
            if (switchImg) switchImg.checked = state.useDefaultImages !== false;
            const switchRound = /** @type {HTMLInputElement | null} */ (document.getElementById('switchRoundCoins'));
            if (switchRound) switchRound.checked = state.roundCoins !== false;
            const switchDark = /** @type {HTMLInputElement | null} */ (document.getElementById('switchDarkMode'));
            if (switchDark) switchDark.checked = state.theme === 'dark';

            const currentTextMode = state.chipTextColor || 'dark_tone';
            ['dark_tone', 'black', 'white'].forEach(m => {
                const btn = document.getElementById(`chipTextMode-${m}`);
                if (btn) {
                    const isActive = currentTextMode === m;
                    btn.className = isActive
                        ? 'py-1.5 px-2 text-xs font-bold rounded-md transition-all bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-xs flex items-center justify-center gap-1.5'
                        : 'py-1.5 px-2 text-xs font-medium rounded-md transition-all text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center justify-center gap-1.5';
                }
            });

            const currentFmt = state.breakdownFormat || 'badge';
            ['badge', 'qty_x_denom', 'denom_x_qty'].forEach(f => {
                const btn = document.getElementById(`fmtBtn-${f}`);
                if (btn) {
                    const isActive = currentFmt === f;
                    btn.className = isActive
                        ? 'px-2.5 py-1 rounded-md transition-all bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-xs font-bold'
                        : 'px-2.5 py-1 rounded-md transition-all text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200';
                }
            });

            const currentSz = state.breakdownSize || 'normal';
            ['compact', 'normal', 'large'].forEach(s => {
                const btn = document.getElementById(`sizeBtn-${s}`);
                if (btn) {
                    const isActive = currentSz === s;
                    btn.className = isActive
                        ? 'px-2.5 py-1 rounded-md transition-all bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-xs font-bold'
                        : 'px-2.5 py-1 rounded-md transition-all text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200';
                }
            });

            const currentCols = state.breakdownColumns || 5;
            [3, 4, 5, 6, 'auto'].forEach(c => {
                const btn = document.getElementById(`colBtn-${c}`);
                if (btn) {
                    const isActive = String(currentCols) === String(c);
                    btn.className = isActive
                        ? 'px-2.5 py-1 rounded-md transition-all bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-xs font-bold'
                        : 'px-2.5 py-1 rounded-md transition-all text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200';
                }
            });

            const switchGroup = /** @type {HTMLInputElement | null} */ (document.getElementById('switchGroupByType'));
            if (switchGroup) switchGroup.checked = state.breakdownGroupByType === true;

            const switchZeros = /** @type {HTMLInputElement | null} */ (document.getElementById('switchShowZeros'));
            if (switchZeros) switchZeros.checked = state.breakdownShowZeros === true;
        };

        const renderCustomBillsConfig = () => {
            if (!hasDom()) return;
            const state = deps.getState();
            const container = document.getElementById('appearanceList');
            if (!container) return;

            const curr = state.currency || 'DOP';
            const currPreset = deps.CURRENCY_PRESETS[curr] || deps.CURRENCY_PRESETS.DOP;
            const badgeInfo = document.getElementById('customBillsCurrencyBadge');
            if (badgeInfo && currPreset) {
                badgeInfo.innerHTML = `
                    <div class="flex items-center justify-between gap-2 w-full flex-wrap">
                        <span class="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100">
                            <span>${currPreset.flag}</span> <span>${currPreset.name} (${currPreset.code})</span>
                        </span>
                        <span class="text-[10px] font-mono text-slate-500 dark:text-slate-400 bg-white/80 dark:bg-slate-900/80 px-2 py-0.5 rounded border border-blue-200 dark:border-blue-800">
                            📁 imagenes/${currPreset.code}/
                        </span>
                    </div>
                `;
            }

            container.replaceChildren();
            state.denominations.forEach((/** @type {number} */ denom) => {
                const customImage = state.billImages && state.billImages[denom];
                const activeImage = deps.getBillImage(denom);
                const isCoinDenom = deps.isCoin(denom);
                const isRound = state.roundCoins !== false && isCoinDenom;
                const customColor = state.billColors && state.billColors[denom];
                const defaultColor = currPreset?.colors?.[denom] || (deps.BILL_COLORS[denom] ? deps.BILL_COLORS[denom].bg : '#e2e8f0');
                const currentColor = customColor || defaultColor;
                const shapeClass = isRound ? 'chip-vector-coin' : 'chip-vector-banknote';
                const shapeStyle = isRound ? 'width:32px;height:32px;' : 'width:52px;height:28px;';
                const billStyle = deps.getBillStyle(denom);
                const innerHTML = activeImage ? '' : (isRound ? `<div class="coin-inner"></div><span class="coin-text">${denom}</span>` : `<div class="banknote-inner"></div><span class="banknote-text">${denom}</span>`);
                const sym = deps.escapeHTML(state.currencySymbol || '');

                const row = document.createElement('div');
                row.className = 'flex items-center gap-3 p-2 bg-slate-50 dark:bg-slate-950/60 rounded-xl border border-slate-200/80 dark:border-slate-800';
                row.innerHTML = `
                    <div class="shrink-0 flex items-center justify-center" style="width:54px">
                        <div class="bill-chip ${shapeClass}" style="${billStyle};${shapeStyle}">
                            ${innerHTML}
                        </div>
                    </div>
                    <div class="font-bold text-slate-800 dark:text-slate-200 text-xs w-16 shrink-0 font-mono">
                        ${sym} ${denom}
                        ${isCoinDenom ? ' <span class="text-[9px] text-amber-600 dark:text-amber-400 block font-normal font-sans">🪙 moneda</span>' : ' <span class="text-[9px] text-blue-600 dark:text-blue-400 block font-normal font-sans">💵 billete</span>'}
                    </div>
                    <div class="flex items-center gap-2 flex-grow min-w-0">
                        <label class="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide shrink-0">Color</label>
                        <input type="color"
                            value="${currentColor}"
                            data-sx-input="updateBillColor" data-sx-arg="${denom}"
                            class="w-8 h-7 rounded cursor-pointer border border-slate-200 dark:border-slate-700 p-0.5 bg-white dark:bg-slate-800 shrink-0"
                            title="Cambiar color del billete ${sym} ${denom}">
                        ${customColor ? `<button type="button" data-sx-click="resetBillColor" data-sx-arg="${denom}" class="text-xs text-slate-400 hover:text-red-500 px-1" title="Restaurar color original" aria-label="Restaurar color original de ${denom}"><i class="fa-solid fa-rotate-left"></i></button>` : ''}
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <label class="cursor-pointer bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/60 dark:hover:bg-blue-900 text-blue-700 dark:text-blue-300 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-blue-200 dark:border-blue-800 transition-colors inline-flex items-center gap-1" title="Cargar imagen personalizada">
                            <i class="fa-solid fa-upload"></i> ${customImage ? 'Cambiar' : 'Subir'}
                            <input type="file" accept="image/*" class="hidden" data-sx-change="uploadBillImage" data-sx-arg="${denom}">
                        </label>
                        ${customImage ? `<button type="button" data-sx-click="clearBillImage" data-sx-arg="${denom}" class="text-xs text-rose-500 hover:text-rose-700 px-2 py-1.5 rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/60" title="Quitar imagen personalizada" aria-label="Quitar imagen personalizada de ${denom}"><i class="fa-solid fa-trash"></i></button>` : ''}
                    </div>
                `;
                container.appendChild(row);
            });
        };

        /** @param {string} tab */
        const switchConfigTab = (tab) => {
            if (!hasDom()) return;
            ['appearance', 'customBills', 'denoms'].forEach(t => {
                const btn = document.getElementById(`cfgTab-${t}`);
                if (btn) {
                    btn.className = (t === tab)
                        ? 'flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all bg-white dark:bg-slate-800 text-blue-700 dark:text-blue-300 shadow-xs'
                        : 'flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200';
                }
                const view = document.getElementById(`cfgView-${t}`);
                if (view) {
                    if (t === tab) view.classList.remove('hidden');
                    else view.classList.add('hidden');
                }
            });
            const resetBtn = document.getElementById('cfgResetBtn');
            if (resetBtn) {
                if (tab === 'denoms') resetBtn.classList.remove('hidden');
                else resetBtn.classList.add('hidden');
            }
            if (tab === 'appearance') renderAppearanceConfig();
            if (tab === 'customBills') renderCustomBillsConfig();
            if (tab === 'denoms') renderConfigModal();
        };

        /** @param {string} [tab] */
        const openConfigModal = (tab = 'appearance') => {
            if (!hasDom()) return;
            const modal = document.getElementById('configModal');
            if (modal) modal.classList.remove('hidden');
            switchConfigTab(tab);
        };

        /** @param {boolean} enabled */
        const toggleUseDefaultImages = (enabled) => {
            deps.getState().useDefaultImages = enabled;
            deps.saveData();
            renderAppearanceConfig();
        };

        /** @param {boolean} enabled */
        const toggleRoundCoins = (enabled) => {
            deps.getState().roundCoins = enabled;
            deps.saveData();
            renderAppearanceConfig();
        };

        /** @param {string} fmt */
        const setBreakdownFormat = (fmt) => {
            deps.getState().breakdownFormat = fmt;
            deps.saveData();
            renderAppearanceConfig();
        };

        /** @param {string} mode */
        const setChipTextColor = (mode) => {
            deps.getState().chipTextColor = mode;
            deps.saveData();
            renderAppearanceConfig();
            renderCustomBillsConfig();
            deps.showToast(`Color de texto: ${mode === 'dark_tone' ? 'Tono oscuro de la moneda' : (mode === 'black' ? 'Negro' : 'Blanco')}`, 'success');
        };

        /** @param {string} size */
        const setBreakdownSize = (size) => {
            deps.getState().breakdownSize = size;
            deps.saveData();
            renderAppearanceConfig();
        };

        /** @param {number | string} cols */
        const setBreakdownColumns = (cols) => {
            deps.getState().breakdownColumns = cols;
            deps.saveData();
            renderAppearanceConfig();
        };

        /** @param {boolean} enabled */
        const toggleBreakdownGroupByType = (enabled) => {
            deps.getState().breakdownGroupByType = enabled;
            deps.saveData();
            renderAppearanceConfig();
        };

        /** @param {boolean} enabled */
        const toggleBreakdownShowZeros = (enabled) => {
            deps.getState().breakdownShowZeros = enabled;
            deps.saveData();
            renderAppearanceConfig();
        };

        /** @param {number} denom @param {string} color */
        const updateBillColor = (denom, color) => {
            const safe = deps.sanitizeHexColor(color);
            if (!safe) return;
            const state = deps.getState();
            if (!state.billColors) state.billColors = {};
            state.billColors[denom] = safe;
            deps.saveData();
            renderCustomBillsConfig();
        };

        /** @param {number} denom */
        const resetBillColor = (denom) => {
            const state = deps.getState();
            if (state.billColors) delete state.billColors[denom];
            deps.saveData();
            renderCustomBillsConfig();
        };

        /** @param {number} denom @param {HTMLInputElement} input */
        const uploadBillImage = async (denom, input) => {
            const file = input?.files?.[0];
            if (!file) return;
            try {
                const dataUrl = await SplitXCurrencies.compressBillImageFile(file);
                const state = deps.getState();
                if (!state.billImages) state.billImages = {};
                state.billImages[denom] = dataUrl;
                deps.saveData();
                renderCustomBillsConfig();
                deps.showToast(`Imagen actualizada para ${deps.getCurrencySymbol()} ${denom}.`, 'success');
            } catch (err) {
                deps.showToast(err instanceof Error ? err.message : 'No se pudo cargar la imagen.', 'error');
            } finally {
                if (input) input.value = '';
            }
        };

        /** @param {number} denom */
        const clearBillImage = (denom) => {
            const state = deps.getState();
            if (state.billImages) delete state.billImages[denom];
            deps.saveData();
            renderCustomBillsConfig();
        };

        const resetAllAppearance = async () => {
            const ok = await deps.showCustomConfirm({
                title: '¿Restaurar colores?',
                message: '¿Deseas restaurar los colores de todos los billetes y monedas a los valores por defecto de la moneda activa?',
                icon: 'fa-palette',
                type: 'warning',
                confirmText: 'Restaurar',
                cancelText: 'Cancelar'
            });
            if (!ok) return;
            deps.getState().billColors = {};
            deps.saveData();
            renderCustomBillsConfig();
            deps.showToast('Colores restaurados por defecto.', 'success');
        };

        const clearAllImages = async () => {
            const ok = await deps.showCustomConfirm({
                title: '¿Quitar imágenes personalizadas?',
                message: 'Se removerán todas las fotos personalizadas subidas y se volverán a utilizar las imágenes del sistema o chips vectoriales.',
                icon: 'fa-image',
                type: 'warning',
                confirmText: 'Quitar imágenes',
                cancelText: 'Cancelar'
            });
            if (!ok) return;
            deps.getState().billImages = {};
            deps.saveData();
            renderCustomBillsConfig();
            deps.showToast('Imágenes personalizadas removidas.', 'success');
        };

        return {
            renderConfigModal,
            openConfigModal,
            switchConfigTab,
            toggleUseDefaultImages,
            toggleRoundCoins,
            setBreakdownFormat,
            setChipTextColor,
            setBreakdownSize,
            setBreakdownColumns,
            toggleBreakdownGroupByType,
            toggleBreakdownShowZeros,
            renderAppearancePreviewCard,
            renderAppearanceConfig,
            renderCustomBillsConfig,
            updateBillColor,
            resetBillColor,
            uploadBillImage,
            clearBillImage,
            resetAllAppearance,
            clearAllImages
        };
    };

    return { createConfigUI };
});
