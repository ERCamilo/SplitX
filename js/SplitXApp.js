// SplitXApp.js — Orquestador principal de la interfaz de SplitX (sin JS inline).
const app = (() => {
    const {
        DEFAULT_BILL_IMAGES,
        CURRENCY_PRESETS,
        BILL_COLORS,
        escapeHTML,
        sanitizeCurrencySymbol,
        sanitizeHexColor
    } = SplitXCurrencies;
    const escHtml = escapeHTML;

    const isCoin = (denom) => {
        const d = Number(denom);
        if (state.coinDenoms && Array.isArray(state.coinDenoms)) {
            return state.coinDenoms.includes(d);
        }
        return [25, 10, 5, 1].includes(d);
    };

    // --- STATE ---
    let state = {
        currency: 'DOP',
        currencySymbol: 'RD$',
        coinDenoms: [25, 10, 5, 1],
        denominations: [2000, 1000, 500, 200, 100, 50, 25, 10, 5, 1],
        inventory: {}, 
        employees: [], 
        bankLimits: {},
        billColors: {},   // { 1000: '#c0392b' } — overrides default
        billImages: {},   // { 1000: 'data:image/...' } — custom base64 images
        useDefaultImages: true,
        roundCoins: true,
        breakdownColumns: 5,        // 3 | 4 | 5 | 6 | 'auto'
        breakdownGroupByType: false, // true = Billetes arriba / Monedas abajo
        breakdownShowZeros: false,   // true = Modo bandeja fija con ceros atenuados
        breakdownSize: 'normal',     // 'compact' | 'normal' | 'large'
        breakdownFormat: 'badge',    // 'badge' | 'qty_x_denom' | 'denom_x_qty'
        chipTextColor: 'dark_tone',  // 'dark_tone' | 'black' | 'white'
        statusColorScheme: 'traffic', // 'traffic' (Ámbar->Azul->Verde) | 'classic' (Verde->Azul->Gris)
        cardNumberMode: 'ref',        // 'ref' (SA employeeNumber si existe) | 'order' (orden estable SplitX)
        payrollMode: 'normal',
        payrollLoanFund: 0,
        importSnapshot: null,
        mode: 'inventory',
        theme: 'light'
    };

    // Sort mode: 'status' (Prioridad) | 'ref' (Lista fija)
    let sortMode = 'status';
    // Session physical count checkboxes for the Cuadre tab
    const cuadreCheckedDenoms = new Set();

    // Set of expanded employee card IDs for detailed math view
    let expandedEmpCards = new Set();

    const toggleCardDetails = (empId, evt) => {
        if (evt) evt.stopPropagation();
        if (expandedEmpCards.has(empId)) {
            expandedEmpCards.delete(empId);
        } else {
            expandedEmpCards.add(empId);
        }
        renderAll();
    };

    // --- THEME ---
    const applyTheme = () => {
        const isDark = state.theme === 'dark';
        document.documentElement.classList.toggle('dark', isDark);
        const btn = document.getElementById('themeToggleBtn');
        if (btn) {
            btn.innerHTML = `<i class="fa-solid ${isDark ? 'fa-sun text-amber-400' : 'fa-moon text-slate-400'} text-sm"></i>`;
            btn.title = isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
        }
        const switchDark = document.getElementById('switchDarkMode');
        if (switchDark) switchDark.checked = isDark;
    };

    const toggleTheme = () => {
        state.theme = state.theme === 'dark' ? 'light' : 'dark';
        applyTheme();
        saveData();
        showToast(`Modo ${state.theme === 'dark' ? 'oscuro' : 'claro'} activado`, 'success');
    };

    // --- INIT ---
    const init = () => {
        loadData();
        renderAll();
        setupEventListeners();

        // Cross-window postMessage bridge (e.g. from Sistema de Asistencia)
        if (typeof SplitXBridge !== 'undefined') {
            const bridge = SplitXBridge.createSplitXBridge({
                getState: () => state,
                setState: (newState) => { state = newState; },
                saveData,
                setCurrencyPreset,
                normalizeEmployee: normalizeImportedEmployee,
                showCustomChoice,
                showToast,
                onImported: (info) => {
                    recordImport({ employees: info.employees, source: 'sa', context: info.exportContext, period: info.period, currency: info.currency });
                    try { sessionStorage.setItem('splitx_sa_received', '1'); } catch (e) {}
                    hideStaleBanner();
                },
                windowRef: window
            });
            saBridge = bridge;
            bridge.attach();
            // Abierto desde SA pero sin nómina nueva: avisar que se ve la guardada (antes pasaba en silencio).
            if (bridge.openedFromSA()) {
                setTimeout(() => {
                    let receivedBefore = false;
                    try { receivedBefore = sessionStorage.getItem('splitx_sa_received') === '1'; } catch (e) {}
                    if (!bridge.receivedPayload() && !receivedBefore) showStaleBanner();
                }, 5000);
            }
        }
    };

    // --- IMPORT HISTORY (últimas nóminas importadas) ---
    let saBridge = null;
    const historyStorage = {
        getItem: (k) => appStorage.get(k),
        setItem: (k, v) => appStorage.set(k, v)
    };
    const loadHistory = () => (typeof SplitXImportHistory === 'undefined' ? [] : SplitXImportHistory.load(historyStorage));

    // Guarda la importación en el historial y la marca como la nómina cargada.
    const recordImport = ({ employees, source, context = null, period = null, currency = null }) => {
        state.importSnapshot = JSON.parse(JSON.stringify(state.employees));
        if (typeof SplitXImportHistory !== 'undefined' && Array.isArray(employees) && employees.length) {
            try {
                const entry = SplitXImportHistory.createEntry({ employees, source, context, period, currency: currency || context?.currency || state.currency });
                SplitXImportHistory.save(historyStorage, SplitXImportHistory.addEntry(loadHistory(), entry));
                state.currentImport = { id: entry.id, title: entry.title, importedAt: entry.importedAt, source: entry.source, period: entry.period };
            } catch (e) {
                console.warn('SplitX: no se pudo guardar el historial de importaciones', e);
            }
        }
        saveData();
    };

    const currentImportLabel = () => {
        const cur = state.currentImport;
        if (!cur || typeof SplitXImportHistory === 'undefined') return '';
        const d = SplitXImportHistory.describeEntry({ ...cur, count: 0 });
        return `${cur.title}${d.periodLabel ? ' (' + d.periodLabel + ')' : ''}, importada ${d.whenLabel.toLowerCase()}`;
    };

    const showStaleBanner = () => {
        const el = document.getElementById('saStaleBanner');
        if (!el) return;
        const label = currentImportLabel();
        document.getElementById('saStaleText').innerHTML = state.employees.length
            ? `<strong>No llegó una nómina nueva desde Sistema de Asistencia.</strong> Estás viendo la guardada${label ? ': ' + escHtml(label) : ''}.`
            : '<strong>No llegó la nómina desde Sistema de Asistencia.</strong>';
        el.classList.remove('hidden');
    };
    const hideStaleBanner = () => document.getElementById('saStaleBanner')?.classList.add('hidden');

    const retrySaImport = () => {
        if (saBridge) saBridge.emitReady();
        showToast('Pedido enviado a Sistema de Asistencia. Si no llega en unos segundos, pulsa otra vez "Enviar a SplitX" allí.', 'info');
    };

    const renderHistoryList = () => {
        const box = document.getElementById('historyList');
        if (!box) return;
        const list = loadHistory();
        if (!list.length) {
            box.innerHTML = `<div class="text-center py-10 text-slate-400 dark:text-slate-500">
                <i class="fa-solid fa-clock-rotate-left text-3xl mb-3"></i>
                <p class="text-sm font-medium">Todavía no hay nóminas en el historial.</p>
                <p class="text-xs mt-1">Cada importación (desde Asistencia, JSON o Excel) se guarda aquí.</p>
            </div>`;
            return;
        }
        const sourceIcon = { sa: 'fa-right-left', json: 'fa-code', excel: 'fa-table' };
        box.innerHTML = list.map(entry => {
            const d = SplitXImportHistory.describeEntry(entry);
            const current = SplitXImportHistory.isCurrent(entry, state.employees);
            return `<div class="history-item rounded-xl border ${current ? 'border-blue-300 bg-blue-50/60 dark:border-blue-800 dark:bg-blue-950/40' : 'border-slate-200 dark:border-slate-800'} p-3 flex items-start gap-3" data-history-id="${escHtml(entry.id)}">
                <div class="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-500 dark:text-slate-300 shrink-0">
                    <i class="fa-solid ${sourceIcon[entry.source] || 'fa-file-import'} text-sm"></i>
                </div>
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="font-semibold text-sm text-slate-800 dark:text-slate-100 leading-snug break-words">${escHtml(entry.title)}</span>
                        ${current ? '<span class="text-[10px] font-bold uppercase tracking-wide text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-900/60 rounded px-1.5 py-0.5">Cargada</span>' : ''}
                    </div>
                    ${entry.subtitle ? `<p class="text-xs text-slate-500 dark:text-slate-400 truncate">${escHtml(entry.subtitle)}</p>` : ''}
                    <p class="text-xs text-slate-600 dark:text-slate-300 mt-1">
                        ${d.periodLabel ? `<i class="fa-regular fa-calendar mr-1 text-slate-400"></i>${escHtml(d.periodLabel)} · ` : ''}${escHtml(d.countLabel)} · <span class="font-mono font-semibold">${escHtml(fmt(entry.total))}</span>
                    </p>
                    <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">${escHtml(d.sourceLabel)} · ${escHtml(d.whenLabel)}</p>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" data-history-action="load" data-history-id="${escHtml(entry.id)}" class="toolbar-btn blue" title="Cargar esta nómina">
                        <i class="fa-solid fa-upload text-xs"></i> Cargar
                    </button>
                    <button type="button" data-history-action="delete" data-history-id="${escHtml(entry.id)}" class="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-slate-800" title="Quitar del historial" aria-label="Quitar del historial">
                        <i class="fa-solid fa-trash-can text-xs"></i>
                    </button>
                </div>
            </div>`;
        }).join('');
    };

    const openHistoryModal = () => {
        renderHistoryList();
        document.getElementById('historyModal').classList.remove('hidden');
    };
    const closeHistoryModal = () => document.getElementById('historyModal').classList.add('hidden');

    const loadHistoryEntry = async (id) => {
        const entry = loadHistory().find(e => e.id === id);
        if (!entry) return showToast('Esa nómina ya no está en el historial.', 'error');
        const newEmps = SplitXImportHistory.restoreEmployees(entry).map((e) => ({ ...e, id: SplitXCore.nextEmployeeId() }));
        let choice = 'replace';
        if (state.employees.length > 0) {
            const d = SplitXImportHistory.describeEntry(entry);
            choice = await showCustomChoice({
                title: 'Cargar del historial',
                message: `"${entry.title}"${d.periodLabel ? ' (' + d.periodLabel + ')' : ''} tiene ${newEmps.length} colaboradores. Ya tienes ${state.employees.length} en la lista actual. ¿Cómo deseas proceder?`,
                icon: 'fa-clock-rotate-left',
                type: 'question',
                choices: [
                    { label: 'Cancelar', value: 'cancel', isPrimary: false },
                    { label: 'Agregar al final', value: 'append', icon: 'fa-user-plus', class: 'bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-900 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800' },
                    { label: 'Reemplazar lista', value: 'replace', icon: 'fa-rotate', isPrimary: true, class: 'bg-blue-600 hover:bg-blue-700 text-white' }
                ]
            });
            if (!choice || choice === 'cancel') return;
        }
        state.employees = choice === 'append' ? [...state.employees, ...newEmps] : newEmps;
        if (newEmps.some(e => e.payroll)) state.payrollMode = 'deductions';
        const code = String(entry.currency || '').toUpperCase();
        if (CURRENCY_PRESETS[code] && state.currency !== code) setCurrencyPreset(code);
        state.importSnapshot = JSON.parse(JSON.stringify(state.employees));
        state.currentImport = { id: entry.id, title: entry.title, importedAt: entry.importedAt, source: entry.source, period: entry.period };
        saveData();
        closeHistoryModal();
        hideStaleBanner();
        const totalAmount = state.employees.reduce((sum, e) => sum + getEffectiveEmployeeAmount(e), 0);
        const countEl = document.getElementById('postImportCount');
        if (countEl) countEl.textContent = `${state.employees.length} empleados · Total: ${fmt(totalAmount)}`;
        document.getElementById('postImportModal').classList.remove('hidden');
    };

    const deleteHistoryEntry = async (id) => {
        const entry = loadHistory().find(e => e.id === id);
        if (!entry) return renderHistoryList();
        const ok = await showCustomConfirm({
            title: '¿Quitar del historial?',
            message: `"${entry.title}" se quitará del historial. La lista actual no cambia.`,
            icon: 'fa-trash-can',
            type: 'warning',
            confirmText: 'Quitar',
            cancelText: 'Cancelar'
        });
        if (!ok) return;
        SplitXImportHistory.save(historyStorage, SplitXImportHistory.removeEntry(loadHistory(), id));
        renderHistoryList();
    };

    // Unified storage adapter (SplitXStorage): multi-key memory fallback + quota vs blocked diagnostics
    let _storageWarnedReason = null;
    const appStorage = SplitXStorage.createStorage({
        onError: ({ reason }) => {
            if (_storageWarnedReason === reason) return;
            _storageWarnedReason = reason;
            const banner = document.getElementById('storageBanner');
            const textEl = document.getElementById('storageBannerText');
            if (reason === 'quota') {
                console.warn('SplitX: cuota de localStorage agotada. Los cambios recientes están solo en memoria.');
                if (textEl) {
                    textEl.innerHTML = '<strong>Almacenamiento lleno (cuota agotada):</strong> No hay espacio libre en este navegador para guardar cambios. Elimina imágenes personalizadas pesadas o entradas antiguas del historial.';
                }
            } else {
                console.warn('SplitX: localStorage bloqueado. Los datos solo se guardan mientras la pestaña esté abierta.');
                if (textEl) {
                    textEl.innerHTML = '<strong>Almacenamiento bloqueado:</strong> El navegador impide guardar datos locales (ej. archivo abierto desde OneDrive/red o modo privado). Los datos <strong>no se guardarán</strong> al cerrar la pestaña.';
                }
            }
            if (banner) banner.classList.remove('hidden');
        }
    });
    const storageGet = (key) => appStorage.get(key);
    const storageSet = (key, val) => appStorage.set(key, val);
    const storageRemove = (key) => appStorage.remove(key);

    let _corruptBackupMem = null;

    const loadData = () => {
        const loaded = SplitXState.loadOrRecoverState(appStorage, SplitXStorage.KEYS);
        if (!loaded.ok) {
            if (loaded.backupSaved) {
                console.error('SplitX: invalid stored state; original contents preserved as Split_data_corrupt_backup');
                setTimeout(() => showToast('Datos guardados dañados. Se conservó una copia de recuperación en Operaciones → Respaldo.', 'error'), 0);
            } else {
                _corruptBackupMem = loaded.rawBackup;
                console.error('SplitX: invalid stored state; failed to persist corrupt backup in browser storage');
                const reasonText = loaded.backupError === 'quota' ? 'almacenamiento lleno' : 'almacenamiento bloqueado';
                setTimeout(() => showToast(`Datos guardados dañados y no se pudo guardar la copia (${reasonText}). Descárgala desde Operaciones antes de cerrar la pestaña.`, 'error'), 0);
            }
        }
        if (loaded.data) {
            const parsed = loaded.data;
            state = { ...state, ...parsed };
            state.schemaVersion = Number(state.schemaVersion) || SplitXState.SCHEMA_VERSION;
            _lastKnownRev = Number(state._rev) || 0;
            if (!state.currency) state.currency = 'DOP';
            state.currencySymbol = sanitizeCurrencySymbol(state.currencySymbol || 'RD$');
            const cleanDenoms = Array.isArray(state.denominations)
                ? [...new Set(state.denominations.filter(d => typeof d === 'number' && Number.isFinite(d) && d > 0))].sort((a, b) => b - a)
                : [];
            state.denominations = cleanDenoms.length ? cleanDenoms : [...(CURRENCY_PRESETS[state.currency]?.denominations || [2000, 1000, 500, 200, 100, 50, 25, 10, 5, 1])];
            const cleanCoins = Array.isArray(state.coinDenoms)
                ? [...new Set(state.coinDenoms.filter(d => typeof d === 'number' && Number.isFinite(d) && d > 0))].sort((a, b) => b - a)
                : [];
            state.coinDenoms = cleanCoins.length ? cleanCoins : [25, 10, 5, 1];
            if (state.useDefaultImages === undefined) state.useDefaultImages = true;
            if (state.roundCoins === undefined) state.roundCoins = true;
            if (state.breakdownColumns === undefined) state.breakdownColumns = 5;
            if (state.breakdownGroupByType === undefined) state.breakdownGroupByType = false;
            if (state.breakdownShowZeros === undefined) state.breakdownShowZeros = false;
            if (state.breakdownSize === undefined) state.breakdownSize = 'normal';
            if (state.breakdownFormat === undefined) state.breakdownFormat = 'badge';
            if (!state.chipTextColor) state.chipTextColor = 'dark_tone';
            if (state.statusColorScheme !== 'classic' && state.statusColorScheme !== 'traffic') state.statusColorScheme = 'traffic';
            if (state.cardNumberMode !== 'order' && state.cardNumberMode !== 'ref') state.cardNumberMode = 'ref';
            if (parsed.theme !== 'dark' && parsed.theme !== 'light') {
                state.theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            }
            if (Array.isArray(state.employees)) {
                state.employees = state.employees.map(emp => {
                    const payoutStatus = SplitXCore.getEmployeePayoutStatus(emp);
                    const lockedDistribution = SplitXCore.sanitizeLockedDistribution(emp.lockedDistribution);
                    return {
                        ...emp,
                        payoutStatus,
                        paid: payoutStatus === 'paid',
                        lockedDistribution,
                        isManual: emp.isManual !== undefined ? emp.isManual : !emp.payroll,
                        isEdited: emp.isEdited || false,
                        originalData: emp.originalData || (emp.payroll ? { name: emp.name, amount: emp.amount, payroll: { ...emp.payroll } } : null)
                    };
                });
            }
        } else {
            state.denominations.sort((a,b) => b-a).forEach(d => state.inventory[d] = 0);
            state.theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        applyTheme();
    };

    let _lastKnownRev = 0;
    let _externalTabConflictNotified = false;

    const saveData = () => {
        state.schemaVersion = SplitXState.SCHEMA_VERSION;
        const nextRev = Math.max(Number(state._rev) || 0, _lastKnownRev) + 1;
        state._rev = nextRev;
        _lastKnownRev = nextRev;
        storageSet('Split_data', JSON.stringify(state));
        renderAll();
    };

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('storage', (event) => {
            if (event.key !== SplitXStorage.KEYS.DATA || !event.newValue) return;
            const incoming = SplitXState.parseSavedState(event.newValue);
            if (!incoming.ok || !incoming.data) return;
            const incomingRev = Number(incoming.data._rev) || 0;
            if (incomingRev > _lastKnownRev) {
                _lastKnownRev = incomingRev;
                if (!_externalTabConflictNotified) {
                    _externalTabConflictNotified = true;
                    showToast('Otra pestaña modificó la nómina. Recarga esta pestaña para evitar sobrescribir cambios.', 'info');
                    setTimeout(() => { _externalTabConflictNotified = false; }, 8000);
                }
            }
        });
    }

    // --- CORE LOGIC: DISTRIBUTION & CURRENCY ---
    const getCurrencySymbol = () => state.currencySymbol || 'RD$';
    const fmt = (num) => {
        const rounded = Math.round((Number(num) || 0) * 100) / 100;
        const isNeg = rounded < 0;
        return `${isNeg ? '-' : ''}${getCurrencySymbol()} ${fmtNum(Math.abs(rounded))}`;
    };
    const fmtNum = (num) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(Number(num) || 0));
    const {
        showToast,
        closeCustomDialog,
        showCustomDialog,
        showCustomAlert,
        showCustomConfirm,
        showCustomChoice
    } = SplitXDialogs.createDialogs({ documentRef: document, escapeHTML });

    // Printable sheets (envelope cards + signature sheet). Created on first open.
    let sheetStudio = null;
    const openSheetStudio = () => {
        if (typeof SheetStudio === 'undefined') return showToast('No se pudo cargar el módulo de hojas imprimibles.', 'error');
        if (!state.employees.length) return showToast('Agrega o importa empleados primero.', 'error');
        if (!sheetStudio) {
            sheetStudio = SheetStudio.createStudio({
                root: document.getElementById('sheetStudio'),
                storage: appStorage,
                getEmployees: () => state.employees,
                getNetAmount: (emp) => getEffectiveEmployeeAmount(emp),
                onOpenDocuments: () => { sheetStudio.close(); void openDocumentStudio(); }
            });
        }
        sheetStudio.open();
    };

    // Document templates are independent from payroll and printable sheets.
    let documentStudio = null;
    const openDocumentStudio = async () => {
        if (typeof DocumentStudio === 'undefined') return showToast('No se cargó el editor de documentos.', 'error');
        try {
            if (!documentStudio) documentStudio = DocumentStudio.createStudio({
                root: document.getElementById('documentStudio'),
                storage: appStorage,
                getEmployees: () => state.employees,
                getNetAmount: emp => getEffectiveEmployeeAmount(emp),
                getCurrency: () => state.currency
            });
            await documentStudio.open();
        } catch (error) {
            showToast('No se pudo abrir Documentos: ' + error.message, 'error');
        }
    };

    // Extra import data (employee number, work days, concepts…) used by printable sheets.
    const sheetFields = typeof SplitXSheetFields !== 'undefined' ? SplitXSheetFields : null;

    // Accepts a plain list [...] or { exportContext, employees: [...] } (sa-splitx-payroll/v1).
    const unwrapJsonImport = (parsed) => {
        if (sheetFields) return sheetFields.unwrapImportPayload(parsed);
        if (!Array.isArray(parsed)) throw new Error("El JSON debe ser una lista [...]");
        return { items: parsed, context: null };
    };

    const { parseImportNumber, hasPayrollFields, normalizeImportedEmployee } = SplitXImport.createImporter({ sheetFields, parseNumber: (str) => parseExcelNumber(str) });

    // Isolated and unit-tested cash/payroll engine.
    const core = SplitXCore.createCore({ getState: () => state, fmt });
    const { getEffectiveEmployeeAmount, getPayrollSummary, getIdealBreakdown, calculateDistribution, calculateBankNeeds } = core;

    const getImportValidation = (employees) => employees.reduce((summary, emp) => {
        if (!emp.payroll || emp.payroll.reconciled === null) return summary;
        summary.checked += 1;
        if (emp.payroll.reconciled) summary.valid += 1;
        else {
            summary.invalid += 1;
            summary.difference += emp.payroll.difference;
            summary.items.push({ name: emp.name, difference: emp.payroll.difference });
        }
        return summary;
    }, { checked: 0, valid: 0, invalid: 0, difference: 0, items: [] });

    const renderImportValidation = (employees) => {
        const el = document.getElementById('importValidation');
        const validation = getImportValidation(employees);
        if (!validation.checked) { el.classList.add('hidden'); return; }
        const isValid = validation.invalid === 0;
        el.className = `mt-2 rounded-lg border p-2.5 ${isValid ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-900'}`;
        const details = validation.items.slice(0, 3).map(item =>
            `<div class="flex justify-between gap-3 mt-1 font-mono"><span class="truncate">${escapeHTML(item.name)}</span><strong>${item.difference > 0 ? '+' : ''}${fmt(item.difference)}</strong></div>`
        ).join('');
        el.innerHTML = `
            <div class="flex items-start gap-2 text-xs">
                <i class="fa-solid ${isValid ? 'fa-circle-check' : 'fa-triangle-exclamation'} mt-0.5"></i>
                <div class="min-w-0 flex-1">
                    <strong>${isValid ? 'Nómina conciliada' : `${validation.invalid} registro(s) no cuadran`}</strong>
                    <div class="mt-0.5 opacity-80">${validation.valid} de ${validation.checked} cumplen: bruto + bonificaciones − descuentos − préstamos = neto.</div>
                    ${details}
                    ${validation.invalid > 3 ? `<div class="mt-1">Y ${validation.invalid - 3} diferencia(s) más.</div>` : ''}
                </div>
            </div>`;
        el.classList.remove('hidden');
    };

    // 3. Smart Advisor: extracted to SplitXEmployeeCard.generateSmartAdvisorData
    const getSmartAdvisorData = (leftoverInventory, processedEmployees, loanFundResult = null) =>
        SplitXEmployeeCard.generateSmartAdvisorData(state.denominations, leftoverInventory, processedEmployees, loanFundResult);

    // --- ACTIONS ---

    const addEmployee = () => {
        const nameInput = document.getElementById('empName');
        const amtInput = document.getElementById('empAmount');
        
        let name = nameInput.value.trim();
        let valStr = amtInput.value.trim();

        if (!name && !valStr) return;
        if (name && !valStr) {
            const quick = SplitXCore.parseQuickAddLine(name);
            if (quick) { name = quick.name; valStr = quick.amountText; }
        }

        if (name && valStr) {
            const parsed = SplitXCore.parseManualAmount(valStr, (v) => SplitXExcelImport.parseMoney(v));
            if (!parsed.ok) {
                showToast(parsed.error, 'error');
                return;
            }
            state.employees.push({
                id: SplitXCore.nextEmployeeId(),
                name,
                amount: parsed.amount,
                paid: false,
                isManual: true,
                isEdited: false,
                originalData: null
            });
            nameInput.value = '';
            amtInput.value = '';
            nameInput.focus();
            saveData();
        }
    };

    const removeEmployee = (id) => {
        state.employees = state.employees.filter(e => e.id !== id);
        saveData();
    };
    
    const advanceEmployeeStatus = (id) => {
        const emp = state.employees.find(e => e.id === id);
        if (!emp) return;
        const currentStatus = SplitXCore.getEmployeePayoutStatus(emp);
        if (currentStatus === 'paid') {
            showToast('Ya está Pagado (✓✓). Usa el botón deshacer de la derecha si necesitas revertir.', 'info');
            return;
        }
        const coverage = calculateDistribution();
        const covEmp = coverage.results.find(e => e.id === id);
        if (!covEmp) return;

        if (currentStatus === 'pending') {
            const totalBoxCents = state.denominations.reduce((s, d) => s + SplitXCore.toCents(d) * Math.max(0, Number(state.inventory[d]) || 0), 0);
            if (totalBoxCents === 0) {
                // Hybrid checklist mode: box is empty -> mark directly Paid
                state.employees = state.employees.map(e =>
                    e.id === id ? { ...e, payoutStatus: 'paid', paid: true, lockedDistribution: null } : e
                );
                cuadreCheckedDenoms.clear();
                saveData();
                showToast(`${emp.employeeName || emp.name} marcado como Pagado (modo sin caja).`, 'success');
                return;
            }
            if (covEmp.status === 'error' || (covEmp._missingAmount || 0) > 0) {
                showToast(`Faltan ${fmt(covEmp._missingAmount || 0)} en caja para armar el sobre de ${emp.employeeName || emp.name}.`, 'warning');
                return;
            }
            const locked = SplitXCore.sanitizeLockedDistribution(covEmp.distribution);
            state.employees = state.employees.map(e =>
                e.id === id ? { ...e, payoutStatus: 'packed', paid: false, lockedDistribution: locked } : e
            );
            cuadreCheckedDenoms.clear();
            saveData();
            showToast(`Sobre apartado: ${emp.employeeName || emp.name} (desglose fijado).`, 'success');
            return;
        }

        if (currentStatus === 'packed') {
            state.employees = state.employees.map(e =>
                e.id === id ? { ...e, payoutStatus: 'paid', paid: true } : e
            );
            cuadreCheckedDenoms.clear();
            saveData();
            showToast(`Pagado ✓✓: ${emp.employeeName || emp.name}.`, 'success');
        }
    };

    const revertEmployeeStatus = async (id) => {
        const emp = state.employees.find(e => e.id === id);
        if (!emp) return;
        const currentStatus = SplitXCore.getEmployeePayoutStatus(emp);
        if (currentStatus === 'pending') return;

        if (currentStatus === 'packed') {
            state.employees = state.employees.map(e =>
                e.id === id ? { ...e, payoutStatus: 'pending', paid: false, lockedDistribution: null } : e
            );
            cuadreCheckedDenoms.clear();
            saveData();
            showToast(`Sobre desarmado: billetes de ${emp.employeeName || emp.name} devueltos a caja disponible.`, 'info');
            return;
        }

        if (currentStatus === 'paid') {
            const hasLocked = !!SplitXCore.sanitizeLockedDistribution(emp.lockedDistribution);
            const targetLabel = hasLocked ? 'En sobre' : 'Pendiente';
            const ok = await showCustomConfirm({
                title: '¿Revertir estado Pagado?',
                message: `${emp.employeeName || emp.name} volverá al estado "${targetLabel}". ¿Deseas continuar?`,
                icon: 'fa-rotate-left',
                type: 'warning',
                confirmText: `Volver a ${targetLabel}`,
                cancelText: 'Cancelar'
            });
            if (!ok) return;
            state.employees = state.employees.map(e =>
                e.id === id
                    ? { ...e, payoutStatus: hasLocked ? 'packed' : 'pending', paid: false, lockedDistribution: hasLocked ? e.lockedDistribution : null }
                    : e
            );
            cuadreCheckedDenoms.clear();
            saveData();
            showToast(`${emp.employeeName || emp.name} devuelto a ${targetLabel}.`, 'info');
        }
    };

    const togglePaid = (id) => advanceEmployeeStatus(id);

    const updateInventory = (denom, val) => {
        state.inventory[denom] = SplitXCore.sanitizeInventoryQty(val);
        saveData();
    };

    const updateBankLimit = (denom, val) => {
        state.bankLimits[denom] = SplitXCore.sanitizeBankLimit(val);
        saveData();
    };

    const applyBankToInventory = () => {
        const bankData = calculateBankNeeds();
        let totalAddedCents = 0;
        state.denominations.forEach(d => {
            const quantity = Math.max(0, Number(bankData.breakdown[d]?.final) || 0);
            state.inventory[d] = (state.inventory[d] || 0) + quantity;
            totalAddedCents += quantity * SplitXCore.toCents(d);
        });
        const totalAdded = SplitXCore.fromCents(totalAddedCents);
        if (totalAdded <= 0) {
            showToast('No hay dinero pendiente para retirar del banco.', 'info');
            return;
        }
        state.mode = 'inventory';
        switchTab('inventory');
        saveData();
        const extra = bankData.remainder > 0
            ? ` (quedan ${fmt(bankData.remainder)} sin cubrir por límites del banco)`
            : '';
        showToast(`${fmt(totalAdded)} agregados a Mi Caja. El inventario anterior se conservó.${extra}`);
    };

    const clearBankLimits = () => {
        const hasLimits = Object.values(state.bankLimits || {}).some(value => value !== null && value !== undefined && value !== '');
        if (!hasLimits) {
            showToast('No hay límites bancarios configurados.', 'info');
            return;
        }
        state.bankLimits = {};
        saveData();
    };

    const setCurrencyPreset = (key) => {
        const preset = CURRENCY_PRESETS[key];
        if (!preset) return;
        state.currency = preset.code;
        state.currencySymbol = sanitizeCurrencySymbol(preset.symbol);
        state.denominations = [...preset.denominations];
        state.coinDenoms = [...preset.coinDenoms];
        
        // If DOP, default to photo images; for others default to vector chips unless customized
        if (key === 'DOP') {
            state.useDefaultImages = true;
        }
        
        // Apply preset colors cleanly so previous currency colors do not stick on overlapping denominations
        state.billColors = preset.colors ? { ...preset.colors } : {};

        // Ensure inventory keys exist
        state.denominations.forEach(d => {
            if (state.inventory[d] === undefined) state.inventory[d] = 0;
        });

        saveData();
        renderAppearanceConfig();
        renderCustomBillsConfig();
        showToast(`Moneda cambiada a ${preset.name} (${preset.symbol})`, 'success');
    };

    const setCurrencySymbol = (sym) => {
        const val = sanitizeCurrencySymbol(sym);
        state.currencySymbol = val;
        saveData();
        renderAppearanceConfig();
        renderCustomBillsConfig();
        showToast(`Símbolo de moneda actualizado a "${val}"`, 'success');
    };

    const addDenomination = () => {
        const input = document.getElementById('newDenomInput');
        if (!input) return;
        const val = parseFloat(input.value);
        if (!Number.isFinite(val) || val <= 0 || Math.abs(val * 100 - Math.round(val * 100)) > 1e-6) {
            showToast('Ingresa una denominación válida mayor a 0 con máximo 2 decimales', 'warning');
            return;
        }
        const normalizedVal = Math.round(val * 100) / 100;
        if (state.denominations.includes(normalizedVal)) {
            showToast(`La denominación ${normalizedVal} ya existe en la lista`, 'warning');
            return;
        }
        state.denominations.push(normalizedVal);
        state.denominations.sort((a, b) => b - a);
        if (state.inventory[normalizedVal] === undefined) state.inventory[normalizedVal] = 0;
        input.value = '';
        saveData();
        renderAppearanceConfig();
        renderCustomBillsConfig();
        showToast(`Denominación ${normalizedVal} agregada correctamente`, 'success');
    };

    const removeDenom = (denom) => {
        if (state.denominations.length <= 1) {
            showToast('Debes mantener al menos una denominación activa', 'warning');
            return;
        }
        state.denominations = state.denominations.filter(d => Number(d) !== Number(denom));
        delete state.inventory[denom];
        saveData();
        renderAppearanceConfig();
        renderCustomBillsConfig();
        showToast(`Denominación ${denom} eliminada`, 'success');
    };

    const exportFullBackup = () => {
        const json = SplitXBackup.serializeBackup(appStorage);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('hidden', '');
        a.setAttribute('href', url);
        a.setAttribute('download', `respaldo_SplitX_${SplitXExport.isoDateTag()}.json`);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => window.URL.revokeObjectURL(url), 1000);
        showToast('Respaldo íntegro descargado. Guárdalo en un lugar seguro.', 'success');
    };

    const importFullBackup = async (input) => {
        const file = input?.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const preview = SplitXBackup.validateBackup(text);
            const s = preview.summary;
            const ok = await showCustomConfirm({
                title: '¿Restaurar respaldo completo?',
                message: `Se restaurarán ${s.employees} colaborador(es) (${s.currency}), ${s.historyCount} nómina(s) en historial, ${s.sheetsCount} plantilla(s) de hojas y ${s.docTemplatesCount} plantilla(s) de documentos. Esto sobrescribirá los datos actuales del navegador.`,
                icon: 'fa-upload',
                type: 'warning',
                confirmText: 'Sí, restaurar respaldo',
                cancelText: 'Cancelar'
            });
            if (!ok) return;
            SplitXBackup.restoreBackup(appStorage, text);
            closeOperationsModal();
            location.reload();
        } catch (err) {
            showCustomAlert({
                title: 'Respaldo inválido',
                message: err instanceof Error ? err.message : 'No se pudo validar el archivo de respaldo.',
                icon: 'fa-circle-exclamation',
                type: 'danger',
                confirmText: 'Entendido'
            });
        } finally {
            if (input) input.value = '';
        }
    };

    const purgeDocumentPii = async () => {
        const ok = await showCustomConfirm({
            title: '¿Purgar datos personales de Documentos?',
            message: 'Se eliminarán las cédulas, direcciones, fechas de ingreso y salarios contractuales guardados en este navegador. Tus plantillas de documentos y la nómina actual no se borrarán.',
            icon: 'fa-user-shield',
            type: 'warning',
            confirmText: 'Sí, purgar datos',
            cancelText: 'Cancelar'
        });
        if (!ok) return;
        const res = SplitXBackup.purgeDocumentPii(appStorage);
        showToast(res.purged > 0 ? `Se purgaron datos personales de ${res.purged} colaborador(es).` : 'No había datos personales almacenados en Documentos.', 'success');
    };

    const downloadCorruptBackup = () => {
        const raw = SplitXState.getCorruptBackup(appStorage, SplitXStorage.KEYS, _corruptBackupMem);
        if (!raw) {
            showToast('No hay ninguna copia de recuperación pendiente.', 'info');
            return;
        }
        const blob = new Blob([raw], { type: 'text/plain;charset=utf-8;' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('hidden', '');
        a.setAttribute('href', url);
        a.setAttribute('download', `SplitX_recuperacion_${SplitXExport.isoDateTag()}.txt`);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => window.URL.revokeObjectURL(url), 1000);
        showToast('Copia de recuperación descargada localmente.', 'success');
    };

    const discardCorruptBackup = async () => {
        const ok = await showCustomConfirm({
            title: '¿Descartar copia de recuperación?',
            message: 'Se eliminará la copia de datos dañados guardada en este navegador. Descárgala antes si deseas inspeccionarla.',
            icon: 'fa-trash-can',
            type: 'warning',
            confirmText: 'Descartar copia',
            cancelText: 'Cancelar'
        });
        if (!ok) return;
        SplitXState.clearCorruptBackup(appStorage, SplitXStorage.KEYS);
        _corruptBackupMem = null;
        const card = document.getElementById('opCorruptBackupCard');
        if (card) card.classList.add('hidden');
        showToast('Copia de recuperación eliminada.', 'info');
    };

    const resetAll = async () => {
        const ok = await showCustomConfirm({
            title: '¿Borrar todos los datos?',
            message: 'Esta acción restablecerá por completo la aplicación a su estado de fábrica en este navegador. Se borrarán empleados, inventario, caja, historial de importaciones, plantillas de hojas y documentos personalizados (incluidas cédulas y direcciones).',
            icon: 'fa-trash-can',
            type: 'danger',
            confirmText: 'Sí, borrar todo',
            cancelText: 'Cancelar'
        });
        if (ok) {
            appStorage.clearAll();
            location.reload();
        }
    };

    const resetDenominations = () => {
        const preset = CURRENCY_PRESETS[state.currency || 'DOP'] || CURRENCY_PRESETS.DOP;
        state.denominations = [...preset.denominations];
        state.coinDenoms = [...preset.coinDenoms];
        state.denominations.forEach(d => {
            if (state.inventory[d] === undefined) state.inventory[d] = 0;
        });
        saveData();
        renderAppearanceConfig();
        renderCustomBillsConfig();
        showToast(`Denominaciones restauradas al preset ${preset.code}`, 'success');
    };

    const exporter = SplitXExport.createExporter({
        getState: () => state,
        getCurrencySymbol,
        calculateDistribution,
        calculateBankNeeds,
        getPayrollSummary,
        getEffectiveEmployeeAmount,
        showCustomAlert
    });
    const { buildExportData, exportToCSV, exportToExcel, exportToPDF } = exporter;

    let importMode = 'excel'; // 'excel' | 'json'
    let lastImportAction = 'replace'; // 'replace' | 'append'

    const switchImportTab = (mode) => {
        importMode = mode;
        const tabs = ['excel', 'json'];
        tabs.forEach(t => {
            const tab = document.getElementById(`importTab-${t}`);
            const info = document.getElementById(`importInfo-${t}`);
            if (t === mode) {
                tab.classList.add('bg-white', 'text-blue-700', 'shadow-sm');
                tab.classList.remove('text-slate-500');
                info.classList.remove('hidden');
            } else {
                tab.classList.remove('bg-white', 'text-blue-700', 'shadow-sm');
                tab.classList.add('text-slate-500');
                info.classList.add('hidden');
            }
        });
        // Update placeholder
        const ta = document.getElementById('jsonImportInput');
        document.getElementById('excelFormatRow').classList.toggle('hidden', mode !== 'excel');
        ta.placeholder = mode === 'excel'
            ? 'Pega aquí las filas copiadas desde Excel...'
            : '[{"nombre": "Empleado 1", "monto": 100}, ...]';
        // Clear preview and error
        document.getElementById('importPreview').classList.add('hidden');
        document.getElementById('importErrorMsg').classList.add('hidden');
        parseImportPreview();
    };

    // Validate the complete monetary text; never silently guess separators.
    const parseExcelNumber = (value) => {
        try { return SplitXExcelImport.parseMoney(value); }
        catch (_) { return NaN; }
    };
    const getExcelAmountFormat = () => document.getElementById('excelAmountFormat')?.value || 'auto';
    const parseExcelText = (rawText) => SplitXExcelImport.parseExcelText(rawText, { format: getExcelAmountFormat() });

    const parseImportPreview = () => {
        const rawText = document.getElementById('jsonImportInput').value.trim();
        const previewEl = document.getElementById('importPreview');
        const previewList = document.getElementById('importPreviewList');
        const previewCount = document.getElementById('importPreviewCount');
        const errEl = document.getElementById('importErrorMsg');

        if (!rawText) {
            previewEl.classList.add('hidden');
            errEl.classList.add('hidden');
            document.getElementById('importValidation')?.classList.add('hidden');
            return;
        }

        try {
            let employees = [];
            if (importMode === 'excel') {
                const result = parseExcelText(rawText);
                employees = result.employees.map((item, idx) => normalizeImportedEmployee(item, idx));
                // Show all rejected rows even when other employees are valid.
                if (result.errors.length) {
                    errEl.textContent = `${result.rows} filas: ${result.valid} válidas, ${result.rejected} rechazadas. Corrige las filas antes de importar.\n${result.errors.slice(0, 10).join('\n')}${result.errors.length > 10 ? '\n... y ' + (result.errors.length - 10) + ' errores más.' : ''}`;
                    errEl.classList.remove('hidden');
                } else errEl.classList.add('hidden');
            } else {
                const { items } = unwrapJsonImport(JSON.parse(rawText));
                employees = items.map((item, idx) => normalizeImportedEmployee(item, idx));
            }

            if (employees.length > 0) {
                previewCount.innerText = employees.length;
                previewList.innerHTML = employees.slice(0, 8).map(e =>
                    `<div class="flex justify-between"><span>${escapeHTML(e.employeeNumber ? `${e.employeeNumber} · ${e.employeeName || e.name}` : e.name)}</span><span class="font-bold">${fmt(e.amount)}</span></div>`
                ).join('') + (employees.length > 8 ? `<div class="text-green-600 italic">... y ${employees.length - 8} más</div>` : '');
                previewEl.classList.remove('hidden');
                renderImportValidation(employees);
                if (importMode !== 'excel') errEl.classList.add('hidden');
            } else {
                previewEl.classList.add('hidden');
            }
        } catch(e) {
            previewEl.classList.add('hidden');
            document.getElementById('importValidation').classList.add('hidden');
            if (rawText.length > 10) {
                errEl.innerText = "Error: " + e.message;
                errEl.classList.remove('hidden');
            }
        }
    };

    const openImportModal = () => {
        document.getElementById('importModal').classList.remove('hidden');
        document.getElementById('jsonImportInput').value = '';
        document.getElementById('importErrorMsg').classList.add('hidden');
        document.getElementById('importPreview').classList.add('hidden');
        document.getElementById('importValidation').classList.add('hidden');
        importMode = 'excel';
        document.getElementById('excelAmountFormat').value = 'auto';
        switchImportTab('excel');
        // Attach live preview listener
        const ta = document.getElementById('jsonImportInput');
        ta.oninput = parseImportPreview;
        document.getElementById('excelAmountFormat').onchange = parseImportPreview;
    };

    const closeImportModal = () => {
        document.getElementById('importModal').classList.add('hidden');
    };

    const processImport = async () => {
        const rawText = document.getElementById('jsonImportInput').value.trim();
        const errEl = document.getElementById('importErrorMsg');
        
        try {
            let newEmps = [];
            let importContext = null;

            if (importMode === 'excel') {
                const result = parseExcelText(rawText);
                if (result.errors.length > 0) {
                    // Fail atomically: do not import only the valid subset.
                    throw new Error(`Importación bloqueada. ${result.rows} filas: ${result.valid} válidas y ${result.rejected} rechazadas. Corrige las filas y vuelve a intentarlo.\n${result.errors.slice(0, 10).join('\n')}${result.errors.length > 10 ? '\n... y ' + (result.errors.length - 10) + ' errores más.' : ''}`);
                }
                newEmps = result.employees.map((item, idx) => normalizeImportedEmployee(item, idx));
            } else {
                const unwrapped = unwrapJsonImport(JSON.parse(rawText));
                importContext = unwrapped.context;
                newEmps = unwrapped.items.map((item, idx) => normalizeImportedEmployee(item, idx));
            }

            if (newEmps.length > 0) {
                if (state.employees.length > 0) {
                    const choice = await showCustomChoice({
                        title: 'Colaboradores detectados',
                        message: `Se detectaron ${newEmps.length} colaboradores en la importación. Ya tienes ${state.employees.length} colaboradores en la lista actual. ¿Cómo deseas proceder?`,
                        icon: 'fa-users-gear',
                        type: 'question',
                        choices: [
                            {
                                label: 'Cancelar',
                                value: 'cancel',
                                isPrimary: false
                            },
                            {
                                label: 'Agregar al final',
                                value: 'append',
                                icon: 'fa-user-plus',
                                class: 'bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-900 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800'
                            },
                            {
                                label: 'Reemplazar lista',
                                value: 'replace',
                                icon: 'fa-rotate',
                                isPrimary: true,
                                class: 'bg-blue-600 hover:bg-blue-700 text-white'
                            }
                        ]
                    });

                    if (!choice || choice === 'cancel') return;

                    if (choice === 'replace') {
                        lastImportAction = 'replace';
                        state.employees = newEmps;
                    } else if (choice === 'append') {
                        lastImportAction = 'append';
                        state.employees = [...state.employees, ...newEmps];
                    }
                } else {
                    lastImportAction = 'replace';
                    state.employees = newEmps;
                }

                if (newEmps.some(e => e.payroll)) state.payrollMode = 'deductions';
                const importCurrency = String(importContext?.currency || '').toUpperCase();
                if (CURRENCY_PRESETS[importCurrency] && state.currency !== importCurrency) setCurrencyPreset(importCurrency);
                recordImport({ employees: newEmps, source: importMode === 'excel' ? 'excel' : 'json', context: importContext });
                closeImportModal();

                // Show post-import auto-distribute modal
                const totalAmount = state.employees.reduce((sum, e) => sum + getEffectiveEmployeeAmount(e), 0);
                const countEl = document.getElementById('postImportCount');
                if (countEl) countEl.textContent = `${state.employees.length} empleados · Total: ${fmt(totalAmount)}`;
                document.getElementById('postImportModal').classList.remove('hidden');
            } else {
                throw new Error("No se encontraron empleados válidos.");
            }

        } catch (e) {
            errEl.innerText = "Error: " + e.message;
            errEl.classList.remove('hidden');
        }
    };

    const closePostImportModal = (autoDistribute) => {
        document.getElementById('postImportModal').classList.add('hidden');
        if (autoDistribute) {
            // Only clear existing inventory when replacing the payroll; preserve box cash on append imports
            if (lastImportAction !== 'append') {
                state.inventory = {};
                state.denominations.forEach(d => state.inventory[d] = 0);
            } else {
                state.denominations.forEach(d => {
                    if (state.inventory[d] === undefined) state.inventory[d] = 0;
                });
            }

            // Calculate what's still needed and add to inventory
            const bankData = calculateBankNeeds();
            let totalAddedCents = 0;
            state.denominations.forEach(d => {
                const quantity = bankData.breakdown[d]?.final || 0;
                state.inventory[d] = (state.inventory[d] || 0) + quantity;
                totalAddedCents += quantity * SplitXCore.toCents(d);
            });
            const totalAdded = SplitXCore.fromCents(totalAddedCents);

            state.mode = 'inventory';
            switchTab('inventory');
            saveData();

            if (totalAdded > 0) {
                const suffix = lastImportAction === 'append' ? ' (conservando el efectivo existente en caja)' : '';
                showToast(`Reparto automático: ${fmt(totalAdded)} distribuidos a ${state.employees.length} empleados${suffix}.`, 'success');
            } else {
                showToast('Empleados importados. No se necesitan billetes adicionales.', 'info');
            }
        } else {
            renderAll();
            showToast('Empleados importados. Ve a Banco para preparar el efectivo.', 'info');
        }
    };

    // --- UI RENDERING ---

    const renderAll = () => {
        // Compute derived state ONCE per render cycle (avoids 4x-8x recalculation cascade)
        const coverage = calculateDistribution();
        const bankData = calculateBankNeeds(coverage);
        const payrollSummary = getPayrollSummary();
        const ledger = SplitXCore.computeLedgerSummary(state.denominations, state.inventory, coverage.results);

        renderInventory(coverage.leftoverInventory, coverage.results, coverage.loanFundResult, ledger);
        renderEmployees(coverage.results, coverage.loanFundResult, payrollSummary);
        renderBank(bankData);
        renderCuadre(ledger);
        renderConfigModal();
        updateTotals(coverage, bankData, payrollSummary, ledger);
        if (document.getElementById('appearanceLivePreviewCard')) {
            renderAppearancePreviewCard();
        }
    };

    const renderInventory = (leftoverInventory, processedEmployees, loanFundResult = null, ledger = null) => {
        const container = document.getElementById('inventoryList');
        container.innerHTML = '';
        
        state.denominations.forEach(denom => {
            const div = document.createElement('div');
            div.className = "inv-row";
            const billStyle = getBillStyle(denom);
            const qty = state.inventory[denom] || 0;
            const committed = ledger?.committedBills?.[denom] || 0;
            const freeInHand = ledger?.physicalLooseOnTable?.[denom] ?? qty;
            const isCoinDenom = isCoin(denom);
            const isRound = state.roundCoins !== false && isCoinDenom;
            const shapeClass = isRound ? 'chip-vector-coin' : 'chip-vector-banknote';
            const shapeStyle = isRound ? 'width:32px;height:32px;' : 'width:54px;height:28px;';
            const hasImg = !!getBillImage(denom);
            const innerHTML = hasImg ? '' : (isRound ? `<div class="coin-inner"></div><span class="coin-text">${denom}</span>` : `<div class="banknote-inner"></div><span class="banknote-text">${denom}</span>`);

            div.innerHTML = `
                <div class="flex items-center gap-2.5 min-w-0">
                    <div class="bill-chip ${shapeClass} shrink-0" style="${billStyle};${shapeStyle}">
                        ${innerHTML}
                    </div>
                    <div class="flex flex-col leading-tight">
                        <span class="text-xs sm:text-sm font-semibold text-slate-500 dark:text-slate-400">
                            × <span class="font-bold font-mono text-sm sm:text-base ${qty > 0 ? 'text-slate-900 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500'}">${qty}</span>
                        </span>
                        ${committed > 0 ? `<span class="text-[10px] font-mono font-semibold text-blue-600 dark:text-sky-400">en mano: ${freeInHand}</span>` : ''}
                    </div>
                </div>
                <div class="flex items-center gap-1.5">
                    <button data-sx-click="adjustInv" data-sx-arg="${denom}" data-sx-arg2="-1" class="stepper-btn minus" aria-label="Restar billete de ${denom}">−</button>
                    <input type="number"
                        value="${qty}"
                        data-sx-change="updateInventory" data-sx-arg="${denom}"
                        class="w-14 text-center border border-slate-200 dark:border-slate-700 rounded-lg py-1 px-1 text-sm font-bold font-mono text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-900 focus:bg-white dark:focus:bg-slate-950 focus:ring-1 focus:ring-blue-500 outline-none transition-colors">
                    <button data-sx-click="adjustInv" data-sx-arg="${denom}" data-sx-arg2="1" class="stepper-btn plus" aria-label="Sumar billete de ${denom}">+</button>
                </div>
            `;
            container.appendChild(div);
        });

        // Render Smart Advisor
        if (processedEmployees) {
            const advisorData = getSmartAdvisorData(leftoverInventory, processedEmployees, loanFundResult);
            const advisorEl = document.getElementById('inventoryAdvisor');
            
            if (advisorData.deficit.length > 0) {
                advisorEl.classList.remove('hidden');

                // Determine Logic for Yellow vs Red
                // Rule: If missing denomination < smallest available surplus denomination -> Yellow (Just change)
                // Rule: Else -> Red (Real money missing)
                
                let minSurplus = advisorData.surplus.length > 0 
                    ? Math.min(...advisorData.surplus.map(s => s.denom)) 
                    : Infinity;
                
                // We check each deficit line
                let deficitHTML = `<div class="font-semibold flex flex-col gap-1 mt-2">`;
                
                advisorData.deficit.forEach(d => {
                    let colorClass = "text-red-600";
                    let icon = "fa-arrow-trend-down";
                    
                    // Yellow Condition: I'm missing a bill SMALLER than the smallest bill I have extra.
                    // OR I have enough surplus value in general but just wrong bills (simplified check)
                    if (d.denom < minSurplus && minSurplus !== Infinity) {
                        colorClass = "text-yellow-600"; 
                        icon = "fa-rotate"; // Icon indicating "Change/Swap"
                    }

                    deficitHTML += `<div class="${colorClass}"><i class="fa-solid ${icon} mr-1"></i>Faltan: ${d.count}x${escapeHTML(getCurrencySymbol())}${d.denom}</div>`;
                });
                deficitHTML += `</div>`;

                let surplusHTML = advisorData.surplus.length > 0 
                    ? `<div class="mb-1 text-green-700 font-semibold"><i class="fa-solid fa-arrow-trend-up mr-1"></i>Sobran: ` + advisorData.surplus.map(s => `${s.count}x${escapeHTML(getCurrencySymbol())}${s.denom}`).join(', ') + `</div>`
                    : `<div class="mb-1 text-slate-500 italic text-[10px]">No hay sobrantes útiles.</div>`;
                
                advisorEl.innerHTML = `
                    <p class="font-bold text-orange-800 mb-2 border-b border-orange-200 pb-1">Asesor de Cambio</p>
                    ${surplusHTML}
                    ${deficitHTML}
                    <p class="mt-2 text-[10px] text-orange-700 italic">Consejo: Usa los sobrantes para cubrir los faltantes amarillos.</p>
                `;
            } else {
                advisorEl.classList.add('hidden');
            }
        }
    };

    const adjustInv = (denom, delta) => {
        const current = state.inventory[denom] || 0;
        const newVal = Math.max(0, current + delta);
        updateInventory(denom, newVal);
    };

    const priorityBucket = (emp) => {
        const st = SplitXCore.getEmployeePayoutStatus(emp);
        if (st === 'pending' && (emp.status === 'error' || (emp._missingAmount || 0) > 0)) return 0; // 1. Sin fondos
        if (st === 'pending') return 1; // 2. Pendiente sin sobre
        if (st === 'packed') return 2;  // 3. En sobre
        return 3;                       // 4. Pagado
    };

    // Sort modes cycle: status (Prioridad) → ref (Lista fija)
    const SORT_MODES = [
        { key: 'status', label: 'Prioridad', icon: 'fa-arrow-down-short-wide',
          fn: (a, b) => {
              const pa = priorityBucket(a);
              const pb = priorityBucket(b);
              if (pa !== pb) return pa - pb;
              const ai = typeof a._originalIndex === 'number' ? a._originalIndex : state.employees.findIndex(e => e.id === a.id);
              const bi = typeof b._originalIndex === 'number' ? b._originalIndex : state.employees.findIndex(e => e.id === b.id);
              return ai - bi;
          }
        },
        { key: 'ref',    label: 'Lista fija', icon: 'fa-arrow-down-1-9',
          fn: (a, b) => {
              const ai = typeof a._originalIndex === 'number' ? a._originalIndex : state.employees.findIndex(e => e.id === a.id);
              const bi = typeof b._originalIndex === 'number' ? b._originalIndex : state.employees.findIndex(e => e.id === b.id);
              return ai - bi;
          }
        },
    ];

    const toggleCardNumberMode = () => {
        state.cardNumberMode = state.cardNumberMode === 'order' ? 'ref' : 'order';
        saveData();
        showToast(state.cardNumberMode === 'ref' ? 'Mostrando # Ref SA (si existe).' : 'Mostrando # de orden SplitX.', 'info');
    };

    const cycleSortMode = () => {
        const idx   = SORT_MODES.findIndex(m => m.key === sortMode);
        const next  = SORT_MODES[(idx + 1) % SORT_MODES.length];
        sortMode = next.key;
        const btn   = document.getElementById('sortBtn');
        const label = document.getElementById('sortBtnLabel');
        if (btn) {
            btn.style.borderColor = '';
            btn.style.color       = '';
            btn.style.background  = '';
            const icon = btn.querySelector('i');
            if (icon) { icon.className = `fa-solid ${next.icon} text-xs`; }
        }
        if (label) label.textContent = next.label;
        renderAll();
    };

    const setPayrollMode = async (mode) => {
        const nextMode = mode === 'deductions' ? 'deductions' : 'normal';
        if (state.payrollMode === nextMode) return;
        const affectedPacked = state.employees.filter(e =>
            SplitXCore.getEmployeePayoutStatus(e) === 'packed' && e.payroll && (e.payroll.loans || 0) > 0
        );
        if (affectedPacked.length > 0) {
            const ok = await showCustomConfirm({
                title: 'Sobres apartados afectados',
                message: `Cambiar de modo afectará el monto neto de ${affectedPacked.length} colaborador(es) que ya están "En sobre". Esos sobres volverán a "Pendiente" para rearmarlos. ¿Continuar?`,
                icon: 'fa-triangle-exclamation',
                type: 'warning',
                confirmText: 'Sí, cambiar modo',
                cancelText: 'Cancelar'
            });
            if (!ok) return;
            const affectedIds = new Set(affectedPacked.map(e => e.id));
            state.employees = state.employees.map(e =>
                affectedIds.has(e.id) ? { ...e, payoutStatus: 'pending', paid: false, lockedDistribution: null } : e
            );
            cuadreCheckedDenoms.clear();
        }
        state.payrollMode = nextMode;
        saveData();
    };

    const togglePayrollMode = () => setPayrollMode(state.payrollMode === 'deductions' ? 'normal' : 'deductions');

    const resetOperation = async () => {
        if (!state.employees.length) {
            showToast('No hay empleados ni una operación para reiniciar.', 'info');
            return;
        }
        const ok = await showCustomConfirm({
            title: '¿Reiniciar la operación?',
            message: 'Se conservarán los empleados y sus montos, pero se vaciarán Mi Caja, los retiros, límites, pagos y el fondo para préstamos.',
            icon: 'fa-rotate-left',
            type: 'warning',
            confirmText: 'Sí, reiniciar',
            cancelText: 'Cancelar'
        });
        if (!ok) return;

        state.denominations.forEach(denom => state.inventory[denom] = 0);
        state.bankLimits = {};
        state.payrollLoanFund = 0;
        state.distributionCleared = false;
        state.employees = state.employees.map(employee => {
            const cleanEmployee = { ...employee, paid: false, payoutStatus: 'pending', lockedDistribution: null };
            delete cleanEmployee._missingAmount;
            return cleanEmployee;
        });
        cuadreCheckedDenoms.clear();
        state.mode = 'inventory';
        switchTab('inventory');
        saveData();
        showToast('Operación reiniciada. Se conservaron los empleados y sus montos.');
    };

    const restoreImportSnapshot = async () => {
        if (!Array.isArray(state.importSnapshot) || !state.importSnapshot.length) {
            showToast('Todavía no hay una importación guardada para restaurar.', 'info');
            return;
        }
        const ok = await showCustomConfirm({
            title: '¿Restaurar última importación?',
            message: 'Se recuperarán nombres, montos y desglose originales. También se limpiarán Mi Caja, retiros, pagos y el fondo para préstamos.',
            icon: 'fa-clock-rotate-left',
            type: 'warning',
            confirmText: 'Sí, restaurar',
            cancelText: 'Cancelar'
        });
        if (!ok) return;

        state.employees = JSON.parse(JSON.stringify(state.importSnapshot)).map((employee, index) => ({
            ...employee,
            id: employee.id ?? Date.now() + index,
            paid: false,
            payoutStatus: 'pending',
            lockedDistribution: null
        }));
        cuadreCheckedDenoms.clear();
        state.denominations.forEach(denom => state.inventory[denom] = 0);
        state.bankLimits = {};
        state.payrollLoanFund = 0;
        state.distributionCleared = false;
        state.payrollMode = state.employees.some(employee => employee.payroll) ? 'deductions' : 'normal';
        state.mode = 'inventory';
        switchTab('inventory');
        saveData();
        showToast('Última importación restaurada correctamente.');
    };

    const openOperationsModal = () => {
        const modal = document.getElementById('operationsModal');
        if (!modal) return;
        const hasSnapshot = Array.isArray(state.importSnapshot) && state.importSnapshot.length > 0;
        const cardRestore = document.getElementById('opCardRestore');
        const descRestore = document.getElementById('opDescRestore');
        if (cardRestore) {
            if (hasSnapshot) {
                cardRestore.classList.remove('opacity-40', 'pointer-events-none');
                cardRestore.style.filter = '';
                if (descRestore) {
                    descRestore.textContent = `Recupera la nómina original tal como se importó (${state.importSnapshot.length} empleados)`;
                }
            } else {
                cardRestore.classList.add('opacity-40', 'pointer-events-none');
                cardRestore.style.filter = 'grayscale(0.6)';
                if (descRestore) {
                    descRestore.textContent = 'No hay una importación previa registrada en esta sesión';
                }
            }
        }
        const corruptCard = document.getElementById('opCorruptBackupCard');
        if (corruptCard) {
            const hasCorrupt = !!SplitXState.getCorruptBackup(appStorage, SplitXStorage.KEYS, _corruptBackupMem);
            corruptCard.classList.toggle('hidden', !hasCorrupt);
        }
        modal.classList.remove('hidden');
    };

    const closeOperationsModal = () => {
        document.getElementById('operationsModal')?.classList.add('hidden');
    };

    const openExportModal = () => {
        document.getElementById('exportModal')?.classList.remove('hidden');
    };

    const closeExportModal = () => {
        document.getElementById('exportModal')?.classList.add('hidden');
    };

    const updatePayrollLoanFund = (value) => {
        const collected = getPayrollSummary().loans;
        const result = SplitXCore.clampLoanFund(value, collected, (v) => SplitXExcelImport.parseMoney(v));
        if (!result.ok) {
            showToast(`Fondo de préstamos inválido: ${result.error}`, 'error');
            renderAll();
            return;
        }
        state.payrollLoanFund = result.value;
        saveData();
    };

    // Round all employee amounts, removing cents (keeps payroll.net and payroll.afterDiscounts consistent)
    const roundAllAmounts = async () => {
        const preview = SplitXCore.roundEmployeeAmounts(state.employees, state.payrollMode);
        if (preview.count === 0) {
            showCustomAlert({
                title: 'Sin centavos pendientes',
                message: 'Todos los montos de los colaboradores ya son números enteros sin centavos.',
                icon: 'fa-circle-check',
                type: 'info',
                confirmText: 'Entendido'
            });
            return;
        }
        const ok = await showCustomConfirm({
            title: 'Cortar centavos',
            message: `Se eliminarán los decimales redondeando hacia abajo en ${preview.count} colaborador(es). ¿Deseas continuar?`,
            icon: 'fa-scissors',
            type: 'warning',
            confirmText: 'Sí, cortar centavos',
            cancelText: 'Cancelar'
        });
        if (!ok) return;
        const applied = SplitXCore.roundEmployeeAmounts(state.employees, state.payrollMode);
        state.employees = applied.employees;
        saveData();
        showToast(`Centavos eliminados en ${applied.count} colaborador(es).`, 'success');
    };

    // Update employee field inline
    const updateEmployee = (id, field, value) => {
        const targetEmployee = state.employees.find(employee => employee.id === id);
        if (field === 'amount' && targetEmployee?.payroll) {
            showToast('El monto neto importado está protegido. Usa Restaurar importación para recuperar los valores originales.', 'info');
            return;
        }
        state.employees = state.employees.map(e => {
            if (e.id !== id) return e;
            if (field === 'amount') {
                const parsed = parseFloat(value);
                if (isNaN(parsed) || parsed < 0) return e;
                const payroll = e.payroll ? { ...e.payroll, net: parsed } : e.payroll;
                return { ...e, amount: parsed, payroll };
            }
            if (field === 'name') {
                return value.trim() ? { ...e, name: value.trim() } : e;
            }
            return e;
        });
        saveData();
    };

    const getBillImage = (denom) => SplitXCurrencies.getBillImage(state, denom);
    const getBillStyle = (denom) => SplitXCurrencies.getBillStyle(state, denom);

    const renderEmployees = (data, loanFundResult = { amount: 0, distribution: {}, status: 'ok', missingAmount: 0 }, precomputedSummary = null) => {
        const container = document.getElementById('employeeList');
        const summaryContainer = document.getElementById('payrollSummaryContainer');
        const payrollSummary = precomputedSummary || getPayrollSummary();
        const safeSym = escapeHTML(getCurrencySymbol());
        const showPayrollMode = state.payrollMode === 'deductions' && payrollSummary.count > 0;
        const restoreImportButton = document.getElementById('restoreImportBtn');
        if (restoreImportButton) restoreImportButton.disabled = !Array.isArray(state.importSnapshot) || state.importSnapshot.length === 0;
        document.getElementById('payrollModeNormal')?.classList.toggle('active', state.payrollMode === 'normal');
        document.getElementById('payrollModeDeductions')?.classList.toggle('active', state.payrollMode === 'deductions');
        document.getElementById('payrollModeSwitch')?.classList.toggle('hidden', payrollSummary.count === 0);

        if (showPayrollMode) {
            const loanFund = Math.min(Math.max(0, Number(state.payrollLoanFund) || 0), payrollSummary.loans);
            const remainingCollected = payrollSummary.loans - loanFund;
            const fundBreakdown = loanFundResult;
            let fundBillsHTML = '';
            state.denominations.forEach(denom => {
                const count = fundBreakdown.distribution[denom];
                if (!count) return;
                const billStyle = getBillStyle(denom);
                const hasImg = !!getBillImage(denom);
                const isCoinDenom = isCoin(denom);
                const isRound = state.roundCoins !== false && isCoinDenom;
                const shapeClass = isRound ? 'chip-vector-coin' : 'chip-vector-banknote';
                const shapeStyle = isRound ? 'width:30px;height:30px;' : 'width:54px;height:28px;';
                const innerHTML = hasImg ? '' : (isRound ? `<div class="coin-inner"></div><span class="coin-text">${denom}</span>` : `<div class="banknote-inner"></div><span class="banknote-text">${denom}</span>`);
                fundBillsHTML += `<div style="position:relative;display:inline-block;margin:3px 6px 3px 0">
                    <div class="bill-chip ${shapeClass}" style="${billStyle};${shapeStyle}">
                        ${innerHTML}
                    </div>
                    <span class="bill-badge">${count}</span>
                </div>`;
            });
            const totalLoans = payrollSummary.loans || 0;
            const pct = totalLoans > 0 ? Math.min(100, Math.max(0, Math.round((remainingCollected / totalLoans) * 100))) : 100;
            const dashOffset = (150.8 * (1 - pct / 100)).toFixed(1);

            summaryContainer.className = 'payroll-summary-panel';
            summaryContainer.innerHTML = `
                <div class="flex flex-col gap-2.5">
                    <!-- Header Card -->
                    <div class="p-3.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-xs flex items-center justify-between gap-3">
                        <div class="flex flex-col gap-1 min-w-0">
                            <div class="flex items-baseline gap-2 flex-wrap">
                                <span class="text-2xl font-black text-slate-900 dark:text-slate-100 font-mono">${payrollSummary.loansCount || 0}</span>
                                <span class="text-sm font-bold text-slate-800 dark:text-slate-200">Préstamos descontados</span>
                                <span class="text-xs text-slate-400 dark:text-slate-400 font-medium">(${payrollSummary.count} colaboradores en nómina)</span>
                            </div>
                            ${payrollSummary.loans > 0 ? `
                                <div class="flex flex-wrap items-center gap-1.5 mt-0.5">
                                    <span class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono">
                                        <span class="text-slate-400 dark:text-slate-500">Capital:</span> <strong>${fmtNum(payrollSummary.totalPrincipal)}</strong>
                                    </span>
                                    <span class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/50 border border-amber-200/60 dark:border-amber-800/60 text-amber-700 dark:text-amber-300 font-mono">
                                        <span class="text-amber-500 dark:text-amber-400">Interés recaudado:</span> <strong>${fmtNum(payrollSummary.totalInterest)}</strong>
                                    </span>
                                </div>
                            ` : ''}
                        </div>
                        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-extrabold uppercase tracking-wider bg-teal-700 dark:bg-teal-600 text-white shadow-xs shrink-0">
                            <i class="fa-solid fa-tag text-[9px]"></i> Resumen de Recaudación
                        </span>
                    </div>

                    <!-- Middle 2-Column Grid -->
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5 items-stretch">
                        <!-- Left: Cascada Contable Detallada -->
                        <div class="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-xs flex flex-col justify-between h-full">
                            <div class="font-mono text-xs">
                                <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
                                    <span class="font-semibold text-slate-700 dark:text-slate-300">Bruto total:</span>
                                    <span class="text-right text-slate-800 dark:text-slate-100 font-bold">${fmtNum(payrollSummary.gross)}</span>

                                    <span class="text-slate-600 dark:text-slate-400">Bonificaciones:</span>
                                    <span class="text-right text-emerald-600 dark:text-emerald-400 font-semibold">+ ${fmtNum(payrollSummary.bonuses || 0)}</span>

                                    <span class="text-slate-600 dark:text-slate-400">Descuentos:</span>
                                    <span class="text-right text-rose-600 dark:text-rose-400 font-semibold">- ${fmtNum(payrollSummary.discounts || 0)}</span>

                                    <span class="text-slate-600 dark:text-slate-400">Préstamos:</span>
                                    <span class="text-right text-amber-600 dark:text-amber-400 font-semibold">- ${fmtNum(payrollSummary.loans || 0)}</span>
                                    ${payrollSummary.loans > 0 ? `
                                        <span class="text-[11px] text-slate-500 dark:text-slate-400 pl-3">↳ Capital recaudado:</span>
                                        <span class="text-right text-[11px] text-slate-600 dark:text-slate-300 font-mono">${fmtNum(payrollSummary.totalPrincipal)}</span>
                                        <span class="text-[11px] text-amber-600 dark:text-amber-400 pl-3 font-medium">↳ Interés recaudado:</span>
                                        <span class="text-right text-[11px] text-amber-600 dark:text-amber-400 font-mono font-bold">${fmtNum(payrollSummary.totalInterest)}</span>
                                    ` : ''}
                                </div>
                                <div class="text-2xl font-black font-mono text-slate-950 dark:text-slate-50 tracking-tight mt-3 pt-2 border-t border-slate-100 dark:border-slate-800 text-right">
                                    ${safeSym} ${fmtNum(payrollSummary.net)}
                                </div>
                            </div>
                        </div>

                        <!-- Right: Recaudación restante en banco (Proporcional y Balanceada) -->
                        <div class="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-xs flex items-center justify-between gap-4 h-full">
                            <div class="flex flex-col justify-between h-full py-1">
                                <div>
                                    <div class="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Recaudación restante</div>
                                    <div class="font-mono text-2xl sm:text-3xl font-black text-slate-900 dark:text-slate-50 mt-1">${safeSym} ${fmtNum(remainingCollected)}</div>
                                </div>
                                <div class="text-xs font-mono text-teal-800 dark:text-teal-300 bg-teal-50 dark:bg-teal-950/60 px-2 py-1 rounded-md border border-teal-100 dark:border-teal-800 inline-block w-fit mt-2">
                                    de ${safeSym} ${fmtNum(totalLoans)} recaudados
                                </div>
                            </div>
                            <div class="relative w-20 h-20 shrink-0 flex items-center justify-center">
                                <svg class="w-20 h-20 -rotate-90" viewBox="0 0 60 60">
                                    <circle cx="30" cy="30" r="24" stroke="#e2e8f0" stroke-width="5" fill="none" class="circle-bg-track" />
                                    <circle cx="30" cy="30" r="24" stroke="#0d9488" stroke-width="5" stroke-linecap="round" fill="none"
                                        stroke-dasharray="150.8" stroke-dashoffset="${dashOffset}"
                                        class="transition-all duration-500 ease-out" />
                                </svg>
                                <span class="absolute font-mono text-sm font-black text-slate-800 dark:text-slate-100">${pct}%</span>
                            </div>
                        </div>
                    </div>

                    <!-- Bottom Card: Fondo para nuevos préstamos -->
                    <div class="p-3.5 rounded-xl bg-white dark:bg-slate-900 border ${loanFundResult.status === 'error' ? 'border-rose-200 dark:border-rose-900 bg-rose-50/20 dark:bg-rose-950/20' : 'border-slate-200/80 dark:border-slate-800'} shadow-xs flex flex-wrap items-center justify-between gap-3">
                        <div class="flex flex-col gap-1.5 min-w-0">
                            <div class="loan-fund-bills flex flex-wrap items-center gap-2">
                                ${fundBillsHTML || `<span class="text-[11px] ${loanFundResult.status === 'error' ? 'text-rose-500 dark:text-rose-400' : 'text-slate-400 dark:text-slate-500 italic'}">${loanFund > 0 ? 'Sin billetes asignados en caja.' : 'Indica un monto para reservar.'}</span>`}
                            </div>
                            ${loanFundResult.status === 'error'
                                ? `<div class="text-xs font-bold text-rose-600 dark:text-rose-400 flex items-center gap-1"><i class="fa-solid fa-triangle-exclamation"></i> Faltan ${safeSym} ${fmtNum(loanFundResult.missingAmount)} · retirar del banco</div>`
                                : loanFund > 0
                                    ? '<div class="text-xs font-bold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5"><i class="fa-solid fa-circle-check text-[11px]"></i> Fondo cubierto en caja</div>'
                                    : ''}
                        </div>
                        <div class="flex flex-col items-end gap-1 shrink-0">
                            <span class="text-xs font-bold text-slate-700 dark:text-slate-200">Fondo para nuevos préstamos</span>
                            <input class="loan-fund-input text-right font-mono font-bold w-32 h-8 px-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:border-teal-600 focus:ring-2 focus:ring-teal-100 outline-none"
                                type="number" min="0" max="${totalLoans}" step="1" value="${loanFund}"
                                data-sx-blur="updatePayrollLoanFund"
                                data-sx-enter="blurSelf">
                        </div>
                    </div>
                </div>`;
        } else {
            summaryContainer.className = 'hidden';
            summaryContainer.innerHTML = '';
        }

        const cardNumLabel = document.getElementById('cardNumToggleLabel');
        if (cardNumLabel) cardNumLabel.textContent = state.cardNumberMode === 'order' ? 'Orden #' : 'Ref SA';

        // Apply current sort mode
        if (data && data.length > 0) {
            const mode = SORT_MODES.find(m => m.key === sortMode);
            if (mode) data = [...data].sort(mode.fn);
            // Sync button label on initial render
            const label = document.getElementById('sortBtnLabel');
            const icon  = document.getElementById('sortBtn')?.querySelector('i');
            if (label) label.textContent = mode ? mode.label : 'Orden';
            if (icon && mode) icon.className = `fa-solid ${mode.icon} text-xs`;
        }
        
        if (!data || data.length === 0) {
            container.innerHTML = `<div class="text-center py-10 text-slate-400 dark:text-slate-500 flex flex-col items-center">
                <i class="fa-solid fa-users-viewfinder text-4xl mb-3 opacity-30"></i>
                <p>No hay empleados en la lista.</p>
            </div>`;
            document.getElementById('employeeCountBadge').innerText = '0';
            return;
        }

        document.getElementById('employeeCountBadge').innerText = data.length;
        container.innerHTML = '';

        data.forEach((emp, index) => {
            const card = createCardEl(emp, index, false);
            container.appendChild(card);
        });
    };

    const createCardEl = (emp, index, isPreview = false) => SplitXEmployeeCard.createEmployeeCardElement({
        emp,
        index,
        isPreview,
        state,
        expandedEmpCards,
        sheetFields,
        getEffectiveEmployeeAmount,
        fmt,
        fmtNum
    });

    const renderBank = (precomputedBankData = null) => {
        const tbody = document.getElementById('bankTableBody');
        const bankData = precomputedBankData || calculateBankNeeds();
        tbody.innerHTML = '';

        let totalToWithdraw = 0;

        state.denominations.forEach(denom => {
            const rowData = bankData.breakdown[denom] || { ideal: 0, neededAfterCarry: 0, final: 0 };
            
            const userLimit = state.bankLimits[denom];
            const isLimited = (userLimit !== undefined && userLimit !== null && userLimit !== "") && rowData.neededAfterCarry > rowData.final;
            
            const row = document.createElement('tr');
            row.className = "bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60";
            row.innerHTML = `
                <td class="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">${denom}</td>
                <td class="px-2 py-3 text-center text-slate-500 dark:text-slate-400 text-xs">${rowData.neededAfterCarry}</td>
                <td class="px-2 py-3 text-center">
                    <input type="number" min="0" step="1"
                        placeholder="∞" 
                        value="${userLimit === undefined || userLimit === null ? '' : userLimit}" 
                        data-sx-change="updateBankLimit" data-sx-arg="${denom}"
                        class="w-16 px-2 py-1 text-center text-sm border rounded bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-600 focus:bg-white dark:focus:bg-slate-900 focus:ring-1 focus:ring-blue-500 outline-none ${isLimited ? 'border-orange-400 text-orange-600 dark:text-orange-400 font-bold' : 'border-slate-200 dark:border-slate-700'}">
                </td>
                <td class="px-4 py-3 text-right font-bold text-blue-700 dark:text-sky-400">
                    ${rowData.final}
                    ${rowData.final > rowData.ideal ? `<span class="text-[10px] text-green-500 dark:text-emerald-400 block">+${rowData.final - rowData.ideal} por ajuste</span>` : ''}
                </td>
            `;
            tbody.appendChild(row);

            totalToWithdraw += (rowData.final * SplitXCore.toCents(denom));
        });

        const totalBankMoney = SplitXCore.fromCents(totalToWithdraw);
        document.getElementById('bankTotalDisplay').innerText = fmt(totalBankMoney);
        const shortfallEl = document.getElementById('bankShortfallWarning');
        if (shortfallEl) {
            if (bankData.remainder > 0) {
                shortfallEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1"></i>Faltan ${escapeHTML(fmt(bankData.remainder))} sin cubrir por los límites bancarios actuales.`;
                shortfallEl.classList.remove('hidden');
            } else {
                shortfallEl.classList.add('hidden');
                shortfallEl.textContent = '';
            }
        }
        const applyButton = document.getElementById('applyBankBtn');
        if (applyButton) applyButton.disabled = totalBankMoney <= 0;
    };

    const renderCuadre = (ledger) => {
        const tbody = document.getElementById('cuadreTableBody');
        const totalDisplay = document.getElementById('cuadreLooseTotalDisplay');
        const footer = document.getElementById('cuadreBalanceFooter');
        const warnEl = document.getElementById('cuadreOvercommitWarning');
        const statusEl = document.getElementById('cuadreChecklistStatus');
        if (!tbody || !ledger) return;

        if (totalDisplay) totalDisplay.textContent = fmt(ledger.looseTotal);
        if (warnEl) {
            const overKeys = Object.keys(ledger.overcommittedDenoms || {});
            if (overKeys.length > 0) {
                warnEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1"></i>Atención: Mi Caja tiene menos billetes que los ya apartados en sobres/pagados (${overKeys.map(d => `${escapeHTML(getCurrencySymbol())}${d}: faltan ${ledger.overcommittedDenoms[d]}`).join(', ')}).`;
                warnEl.classList.remove('hidden');
            } else {
                warnEl.classList.add('hidden');
                warnEl.textContent = '';
            }
        }

        tbody.innerHTML = '';
        let checkedCount = 0;
        state.denominations.forEach((denom) => {
            const initQty = Math.max(0, Number(state.inventory[denom]) || 0);
            const packedQty = ledger.packedBills[denom] || 0;
            const paidQty = ledger.paidBills[denom] || 0;
            const looseQty = ledger.physicalLooseOnTable[denom] || 0;
            const isChecked = cuadreCheckedDenoms.has(denom);
            if (isChecked) checkedCount += 1;

            const tr = document.createElement('tr');
            tr.className = `bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-opacity ${isChecked ? 'opacity-50' : ''}`;
            tr.innerHTML = `
                <td class="px-2.5 py-2 text-center">
                    <input type="checkbox" data-cuadre-denom="${denom}" ${isChecked ? 'checked' : ''}
                        aria-label="Verificar denominación ${denom}"
                        class="w-4 h-4 rounded accent-blue-600 cursor-pointer">
                </td>
                <td class="px-2 py-2 font-mono font-bold text-slate-800 dark:text-slate-100">${denom}</td>
                <td class="px-1.5 py-2 text-center font-mono text-slate-500 dark:text-slate-400">${initQty}</td>
                <td class="px-1.5 py-2 text-center font-mono font-bold text-blue-600 dark:text-blue-400">${packedQty > 0 ? `-${packedQty}` : '0'}</td>
                <td class="px-1.5 py-2 text-center font-mono text-slate-500 dark:text-slate-400">${paidQty > 0 ? `-${paidQty}` : '0'}</td>
                <td class="px-3 py-2 text-right font-mono font-extrabold text-sm text-indigo-700 dark:text-indigo-300">${looseQty}</td>
            `;
            tbody.appendChild(tr);
        });

        if (footer) {
            footer.innerHTML = `
                <div class="flex justify-between text-slate-500 dark:text-slate-400"><span>Caja inicial:</span><strong class="text-slate-800 dark:text-slate-100">${escapeHTML(fmt(ledger.totalBox))}</strong></div>
                <div class="flex justify-between text-blue-600 dark:text-blue-400"><span>− En sobres (${ledger.packedCount}):</span><strong>− ${escapeHTML(fmt(ledger.packedTotal))}</strong></div>
                <div class="flex justify-between text-slate-500 dark:text-slate-400"><span>− Pagados (${ledger.paidCount}):</span><strong>− ${escapeHTML(fmt(ledger.paidTotal))}</strong></div>
                <div class="flex justify-between pt-1.5 border-t border-slate-200 dark:border-slate-800 text-sm font-extrabold text-indigo-800 dark:text-indigo-200"><span>= Suelto en mesa:</span><span>${escapeHTML(fmt(ledger.looseTotal))}</span></div>
            `;
        }
        if (statusEl) {
            const totalDenoms = state.denominations.length;
            statusEl.textContent = checkedCount === totalDenoms && totalDenoms > 0
                ? '✓ ¡Todos los billetes verificados!'
                : `${checkedCount} / ${totalDenoms} denominaciones verificadas`;
        }
    };

    const clearCuadreChecks = () => {
        cuadreCheckedDenoms.clear();
        renderAll();
    };

    const configUI = SplitXConfigUI.createConfigUI({
        getState: () => state,
        saveData,
        CURRENCY_PRESETS,
        BILL_COLORS,
        isCoin,
        escapeHTML,
        sanitizeHexColor,
        getBillImage,
        getBillStyle,
        getCurrencySymbol,
        createCardEl,
        showToast,
        showCustomConfirm
    });
    const {
        renderConfigModal, openConfigModal, switchConfigTab,
        toggleUseDefaultImages, toggleRoundCoins, setBreakdownFormat,
        setChipTextColor, setBreakdownSize, setBreakdownColumns,
        toggleBreakdownGroupByType, toggleBreakdownShowZeros,
        setStatusColorScheme, setCardNumberMode,
        renderAppearancePreviewCard, renderAppearanceConfig,
        renderCustomBillsConfig, updateBillColor, resetBillColor,
        uploadBillImage, clearBillImage, resetAllAppearance, clearAllImages
    } = configUI;

    const updateTotals = (precomputedCoverage = null, precomputedBankData = null, precomputedSummary = null, precomputedLedger = null) => {
        // Cash in Box
        let totalBox = 0;
        state.denominations.forEach(d => totalBox += d * (state.inventory[d] || 0));
        document.getElementById('totalInventoryDisplay').innerText = fmt(totalBox);

        // Payroll totals
        const isNormal = state.payrollMode === 'normal';
        const coverage = precomputedCoverage || calculateDistribution();
        const ledger = precomputedLedger || SplitXCore.computeLedgerSummary(state.denominations, state.inventory, coverage.results);
        const paidEmps = coverage.results.filter(e => e.payoutStatus === 'paid');
        const packedEmps = coverage.results.filter(e => e.payoutStatus === 'packed');
        const pendingEmps = coverage.results.filter(e => e.payoutStatus === 'pending');
        let totalPending = pendingEmps.reduce((s, e) => s + getEffectiveEmployeeAmount(e), 0);
        const payrollSummary = precomputedSummary || getPayrollSummary();
        const loanFund = isNormal ? 0 : Math.min(Math.max(0, Number(state.payrollLoanFund) || 0), payrollSummary.loans);
        totalPending += loanFund;
        const employeeMissing = coverage.results.reduce((sum, emp) => sum + (emp.payoutStatus === 'pending' ? (emp._missingAmount || 0) : 0), 0);
        const totalMissing = employeeMissing + (coverage.loanFundResult.missingAmount || 0);

        // ── KPI Cards ──────────────────────────────
        // KPI 1: En Caja
        const kpiCaja = document.getElementById('kpiEnCaja');
        const kpiCajaSub = document.getElementById('kpiEnCajaSub');
        if (kpiCaja) {
            kpiCaja.innerText = fmt(totalBox);
            kpiCaja.style.color = '';
            kpiCaja.className = `kpi-value ${totalMissing <= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-sky-400'}`;
        }
        if (kpiCajaSub) {
            if (totalMissing <= 0 && (totalPending > 0 || ledger.packedTotal > 0)) {
                const leftover = Math.max(0, SplitXCore.fromCents(SplitXCore.toCents(ledger.looseTotal) - SplitXCore.toCents(totalPending)));
                kpiCajaSub.innerHTML = `<span class="text-emerald-600 dark:text-emerald-400 font-semibold">En mesa: ${escapeHTML(fmt(ledger.looseTotal))} · Sobran ${escapeHTML(fmt(leftover))}</span>`;
            } else if (totalMissing > 0) {
                kpiCajaSub.innerHTML = `<span class="text-rose-600 dark:text-rose-400 font-semibold">Faltan ${escapeHTML(fmt(totalMissing))}</span>`;
            } else {
                kpiCajaSub.innerText = 'Sin nómina pendiente';
            }
        }

        // KPI 2: Pendiente
        const kpiPend = document.getElementById('kpiPendiente');
        if (kpiPend) {
            kpiPend.innerText = fmt(totalPending);
            kpiPend.style.color = '';
            kpiPend.className = `kpi-value ${totalPending > 0 ? 'text-slate-800 dark:text-slate-100' : 'text-emerald-600 dark:text-emerald-400'}`;
        }
        const payrollSub = document.getElementById('totalPayrollDisplay');
        if (payrollSub) {
            const parts = [];
            if (pendingEmps.length > 0) parts.push(`${pendingEmps.length} pend.`);
            if (packedEmps.length > 0) parts.push(`${packedEmps.length} en sobre`);
            if (paidEmps.length > 0) parts.push(`${paidEmps.length} pag.`);
            payrollSub.innerText = state.employees.length === 0 ? '0 empleados' : (parts.join(' · ') || `${state.employees.length} empleados`);
        }

        // KPI 3: Cubiertos
        const kpiCub = document.getElementById('kpiCubiertos');
        const kpiCubSub = document.getElementById('kpiCubiertosSub');
        if (state.employees.length === 0) {
            if (kpiCub) {
                kpiCub.innerText = '0 / 0';
                kpiCub.style.color = '';
                kpiCub.className = 'kpi-value text-slate-400 dark:text-slate-500';
            }
            if (kpiCubSub) kpiCubSub.innerText = 'Sin empleados';
        } else {
            const covered = coverage.results.filter(e => e.paid || e.payoutStatus === 'packed' || e.status === 'ok').length;
            const total = state.employees.length;
            if (kpiCub) {
                kpiCub.innerText = `${covered} / ${total}`;
                kpiCub.style.color = '';
                kpiCub.className = `kpi-value ${covered === total ? 'text-emerald-600 dark:text-emerald-400' : covered > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400'}`;
            }
            if (kpiCubSub) {
                const pct = total > 0 ? Math.round(covered / total * 100) : 0;
                kpiCubSub.innerText = (packedEmps.length > 0 || paidEmps.length > 0)
                    ? `${pct}% cubierto · ${packedEmps.length} sobre · ${paidEmps.length} pag.`
                    : `${pct}% cubierto`;
            }
        }

        // KPI 4: Retirar banco
        const bankData = precomputedBankData || calculateBankNeeds(coverage);
        let toWithdraw = 0;
        state.denominations.forEach(d => {
            if (bankData.breakdown[d]) toWithdraw += bankData.breakdown[d].final * d;
        });
        const kpiRet = document.getElementById('kpiRetirar');
        if (kpiRet) {
            kpiRet.innerText = fmt(toWithdraw);
            kpiRet.style.color = '';
            kpiRet.className = `kpi-value ${toWithdraw > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`;
        }

        // Compact Multi-Segment Progress & Live Table-Cash Card
        const totalPay = ledger.totalPayroll;
        const pctPaid = totalPay > 0 ? Math.min(100, (ledger.paidTotal / totalPay) * 100) : 0;
        const pctPacked = totalPay > 0 ? Math.min(100 - pctPaid, (ledger.packedTotal / totalPay) * 100) : 0;
        const coveredPending = Math.max(0, totalPending - totalMissing);
        const pctCoveredPending = totalPay > 0 ? Math.min(100 - pctPaid - pctPacked, (coveredPending / totalPay) * 100) : 0;

        const paidBar = document.getElementById('ledgerPaidBar');
        const packedBar = document.getElementById('ledgerPackedBar');
        const bar = document.getElementById('cashProgressBar');
        const statusEl = document.getElementById('cashStatusText');
        const isClassic = state.statusColorScheme === 'classic';
        if (paidBar) {
            paidBar.style.width = `${pctPaid.toFixed(1)}%`;
            paidBar.className = `h-full transition-all duration-300 ${isClassic ? 'bg-slate-400' : 'bg-emerald-500'}`;
        }
        if (packedBar) packedBar.style.width = `${pctPacked.toFixed(1)}%`;
        if (bar) {
            bar.style.width = `${pctCoveredPending.toFixed(1)}%`;
            bar.className = `h-full transition-all duration-300 ${totalMissing > 0 ? 'bg-rose-400/70' : (isClassic ? 'bg-emerald-400/60' : 'bg-amber-400/60')}`;
        }

        const countsBadge = document.getElementById('ledgerCountsBadge');
        if (countsBadge) {
            countsBadge.textContent = state.employees.length === 0
                ? 'Sin empleados'
                : `${ledger.pendingCount} pend. · ${ledger.packedCount} en sobre · ${ledger.paidCount} pagados`;
        }
        const paidDisp = document.getElementById('ledgerPaidDisplay');
        if (paidDisp) paidDisp.textContent = fmt(ledger.paidTotal);
        const packedDisp = document.getElementById('ledgerPackedDisplay');
        if (packedDisp) packedDisp.textContent = fmt(ledger.packedTotal);
        const pendDisp = document.getElementById('ledgerPendingDisplay');
        if (pendDisp) pendDisp.textContent = fmt(ledger.pendingTotal);
        const looseDisp = document.getElementById('ledgerLooseDisplay');
        if (looseDisp) looseDisp.textContent = fmt(ledger.looseTotal);

        if (statusEl) {
            if (ledger.pendingCount === 0 && ledger.packedCount === 0 && state.employees.length > 0) {
                statusEl.innerHTML = `<span class="text-emerald-600 dark:text-emerald-400 font-semibold">¡Todo Pagado!</span>`;
            } else if (totalMissing <= 0) {
                statusEl.innerHTML = `<span class="text-emerald-600 dark:text-emerald-400 font-semibold">Caja cubierta ✓</span>`;
            } else {
                statusEl.innerHTML = `<span class="text-rose-600 dark:text-rose-400 font-semibold">Faltan ${escapeHTML(fmt(totalMissing))}</span>`;
            }
        }
    };

    // Switch left panel tab (inventory / bank / cuadre)
    const switchTab = (tabName) => {
        const tabs = [
            { key: 'inventory', view: document.getElementById('view-inventory'), btn: document.getElementById('tab-inventory') },
            { key: 'bank', view: document.getElementById('view-bank'), btn: document.getElementById('tab-bank') },
            { key: 'cuadre', view: document.getElementById('view-cuadre'), btn: document.getElementById('tab-cuadre') }
        ];
        tabs.forEach(({ key, view, btn }) => {
            const active = key === tabName;
            if (view) view.classList.toggle('hidden', !active);
            if (btn) {
                btn.classList.toggle('active', active);
                btn.classList.toggle('inactive', !active);
            }
        });
        if (tabName === 'bank') renderBank();
        if (tabName === 'cuadre') {
            const coverage = calculateDistribution();
            renderCuadre(SplitXCore.computeLedgerSummary(state.denominations, state.inventory, coverage.results));
        }
    };

    const openCuadreView = () => {
        switchMobileView('caja');
        switchTab('cuadre');
        const bnavCuadre = document.getElementById('bnav-cuadre');
        const bnavCaja = document.getElementById('bnav-caja');
        const bnavBanco = document.getElementById('bnav-banco');
        const bnavNom = document.getElementById('bnav-nomina');
        if (bnavCuadre) {
            bnavCuadre.classList.add('active');
            bnavCaja?.classList.remove('active');
            bnavBanco?.classList.remove('active');
            bnavNom?.classList.remove('active');
        }
    };

    // Mobile view switcher (bottom nav + segmented control)
    const switchMobileView = (view) => {
        const nomPanel  = document.getElementById('panel-nomina');
        const cajaPanel = document.getElementById('panel-caja');
        const segNom    = document.getElementById('seg-nomina');
        const segCaja   = document.getElementById('seg-caja');
        const bnavNom   = document.getElementById('bnav-nomina');
        const bnavCaja  = document.getElementById('bnav-caja');
        const bnavBanco = document.getElementById('bnav-banco');
        const bnavCuadre = document.getElementById('bnav-cuadre');

        if (view === 'nomina') {
            nomPanel.classList.add('active');    cajaPanel.classList.remove('active');
            if (segNom)  { segNom.classList.add('active');    segCaja.classList.remove('active'); }
            if (bnavNom) { bnavNom.classList.add('active'); bnavCaja?.classList.remove('active'); bnavBanco?.classList.remove('active'); bnavCuadre?.classList.remove('active'); }
        } else {
            cajaPanel.classList.add('active');   nomPanel.classList.remove('active');
            if (segCaja) { segCaja.classList.add('active');   segNom.classList.remove('active'); }
            if (bnavCaja) { bnavCaja.classList.add('active'); bnavNom?.classList.remove('active'); bnavBanco?.classList.remove('active'); bnavCuadre?.classList.remove('active'); }
        }
    };

    // Mobile Add Employee Drawer
    const openAddDrawer = () => {
        document.getElementById('addDrawerBackdrop').classList.add('open');
        document.getElementById('addDrawer').classList.add('open');
        setTimeout(() => document.getElementById('empNameMobile').focus(), 320);
    };
    const closeAddDrawer = () => {
        document.getElementById('addDrawerBackdrop').classList.remove('open');
        document.getElementById('addDrawer').classList.remove('open');
    };
    const addEmployeeMobile = () => {
        const nameInput = document.getElementById('empNameMobile');
        const amtInput  = document.getElementById('empAmountMobile');
        let name   = nameInput.value.trim();
        let valStr = amtInput.value.trim();
        if (!name && !valStr) return;
        if (name && !valStr) {
            const quick = SplitXCore.parseQuickAddLine(name);
            if (quick) { name = quick.name; valStr = quick.amountText; }
        }
        if (name && valStr) {
            const parsed = SplitXCore.parseManualAmount(valStr, (v) => SplitXExcelImport.parseMoney(v));
            if (!parsed.ok) {
                showToast(parsed.error, 'error');
                return;
            }
            state.employees.push({
                id: SplitXCore.nextEmployeeId(),
                name,
                amount: parsed.amount,
                paid: false,
                isManual: true,
                isEdited: false,
                originalData: null
            });
            nameInput.value = ''; amtInput.value = '';
            saveData();
            closeAddDrawer();
            switchMobileView('nomina');
        }
    };

    // --- EDIT EMPLOYEE MODAL LOGIC ---
    const editModal = SplitXEditModal.createEditModal({
        getState: () => state,
        saveData,
        fmt,
        getCurrencySymbol,
        escapeHTML,
        isCoin,
        getBillStyle,
        getBillImage,
        getIdealBreakdown,
        showToast,
        showCustomConfirm
    });
    const {
        openEditModal, toggleLoanDetailsPanel, calcLoanFromDetails,
        calcLoanFromInterestAmount, closeEditModal, setModalAdjustmentType,
        updateModalCalculations, syncNetFromCalculated, saveEmployeeModal,
        revertEmployeeToOriginal
    } = editModal;

    const setupEventListeners = () => {
        document.getElementById('empAmount').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') addEmployee();
        });
        document.getElementById('empName').addEventListener('keypress', (e) => {
            if (e.key !== 'Enter') return;
            const amtInput = document.getElementById('empAmount');
            if (!amtInput.value.trim() && SplitXCore.parseQuickAddLine(e.currentTarget.value)) {
                addEmployee();
            } else {
                amtInput.focus();
            }
        });
        const mobileAmt = document.getElementById('empAmountMobile');
        if (mobileAmt) mobileAmt.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') addEmployeeMobile();
        });
        const mobileNm = document.getElementById('empNameMobile');
        if (mobileNm) mobileNm.addEventListener('keypress', (e) => {
            if (e.key !== 'Enter') return;
            if ((!mobileAmt || !mobileAmt.value.trim()) && SplitXCore.parseQuickAddLine(e.currentTarget.value)) {
                addEmployeeMobile();
            } else if (mobileAmt) {
                mobileAmt.focus();
            }
        });

        // Global Escape key handler for all visible modals and mobile drawer (topmost first)
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const isOpen = (id) => {
                const el = document.getElementById(id);
                return !!(el && !el.classList.contains('hidden'));
            };
            if (isOpen('customDialogModal')) { closeCustomDialog(false); return; }
            if (isOpen('editEmployeeModal')) { closeEditModal(); return; }
            if (isOpen('postImportModal')) { closePostImportModal(false); return; }
            if (isOpen('configModal')) { document.getElementById('configModal')?.classList.add('hidden'); return; }
            if (isOpen('operationsModal')) { closeOperationsModal(); return; }
            if (isOpen('importModal')) { closeImportModal(); return; }
            if (isOpen('exportModal')) { closeExportModal(); return; }
            if (isOpen('historyModal')) { closeHistoryModal(); return; }
            const drawer = document.getElementById('addDrawer');
            if (drawer && drawer.classList.contains('open')) { closeAddDrawer(); }
        });

        // Delegated events for employee cards (no inline onclick string interpolation)
        const empList = document.getElementById('employeeList');
        if (empList) {
            empList.addEventListener('click', (e) => {
                const target = e.target.closest('[data-card-action]');
                if (!target) return;
                const action = target.dataset.cardAction;
                const rawId = target.dataset.empId;
                if (!rawId) return;
                const emp = state.employees.find(x => String(x.id) === rawId);
                if (!emp) return;
                e.stopPropagation();
                if (action === 'advance-status' || action === 'toggle-paid') advanceEmployeeStatus(emp.id);
                else if (action === 'revert-status') revertEmployeeStatus(emp.id);
                else if (action === 'toggle-details') toggleCardDetails(emp.id, e);
                else if (action === 'edit') openEditModal(emp.id);
                else if (action === 'remove') removeEmployee(emp.id);
            });
        }

        // Physical-count checklist in Cuadre tab
        const cuadreBody = document.getElementById('cuadreTableBody');
        if (cuadreBody) {
            cuadreBody.addEventListener('change', (e) => {
                const input = e.target.closest('[data-cuadre-denom]');
                if (!input) return;
                const d = Number(input.dataset.cuadreDenom);
                if (!Number.isFinite(d)) return;
                if (input.checked) cuadreCheckedDenoms.add(d);
                else cuadreCheckedDenoms.delete(d);
                const coverage = calculateDistribution();
                renderCuadre(SplitXCore.computeLedgerSummary(state.denominations, state.inventory, coverage.results));
            });
        }

        // Declarative allowlisted action delegation (zero inline on* handlers -> strict CSP)
        if (typeof SplitXActionDelegation !== 'undefined') {
            SplitXActionDelegation.installActionDelegation(document, {
                openImportModal: () => openImportModal(),
                closeImportModal: () => closeImportModal(),
                switchImportTab: (_el, _e, tab) => switchImportTab(tab),
                processImport: () => processImport(),
                openHistoryModal: () => openHistoryModal(),
                closeHistoryModal: () => closeHistoryModal(),
                openExportModal: () => openExportModal(),
                closeExportModal: () => closeExportModal(),
                exportExcelAndClose: () => { closeExportModal(); exportToExcel(); },
                exportPDFAndClose: () => { closeExportModal(); exportToPDF(); },
                exportCSVAndClose: () => { closeExportModal(); exportToCSV(); },
                openSheetStudio: () => openSheetStudio(),
                openDocumentStudio: () => openDocumentStudio(),
                toggleTheme: () => toggleTheme(),
                openConfigModal: () => openConfigModal(),
                closeConfigModal: () => { const m = document.getElementById('configModal'); if (m) m.classList.add('hidden'); },
                switchConfigTab: (_el, _e, tab) => switchConfigTab(tab),
                setBreakdownFormat: (_el, _e, fmtVal) => setBreakdownFormat(fmtVal),
                setBreakdownSize: (_el, _e, sizeVal) => setBreakdownSize(sizeVal),
                setBreakdownColumns: (_el, _e, cols) => setBreakdownColumns(cols === 'auto' ? 'auto' : Number(cols)),
                setChipTextColor: (_el, _e, mode) => setChipTextColor(mode),
                toggleBreakdownGroupByType: (el) => toggleBreakdownGroupByType(!!el.checked),
                toggleBreakdownShowZeros: (el) => toggleBreakdownShowZeros(!!el.checked),
                setStatusColorScheme: (_el, _e, sc) => setStatusColorScheme(sc),
                setCardNumberMode: (_el, _e, mode) => setCardNumberMode(mode),
                toggleUseDefaultImages: (el) => toggleUseDefaultImages(!!el.checked),
                toggleRoundCoins: (el) => toggleRoundCoins(!!el.checked),
                resetAllAppearance: () => resetAllAppearance(),
                clearAllImages: () => clearAllImages(),
                setCurrencyPreset: (_el, _e, key) => setCurrencyPreset(key),
                setCurrencySymbol: (el) => setCurrencySymbol(el.value),
                addDenomination: () => addDenomination(),
                removeDenom: (_el, _e, d) => removeDenom(Number(d)),
                resetDenominations: () => resetDenominations(),
                updateBillColor: (el, _e, d) => updateBillColor(Number(d), el.value),
                resetBillColor: (_el, _e, d) => resetBillColor(Number(d)),
                uploadBillImage: (el, _e, d) => uploadBillImage(Number(d), el),
                clearBillImage: (_el, _e, d) => clearBillImage(Number(d)),
                openOperationsModal: () => openOperationsModal(),
                closeOperationsModal: () => closeOperationsModal(),
                opResetOperation: () => { closeOperationsModal(); resetOperation(); },
                opRestoreImportSnapshot: () => { closeOperationsModal(); restoreImportSnapshot(); },
                opPurgeDocumentPii: () => { closeOperationsModal(); purgeDocumentPii(); },
                opResetAll: () => { closeOperationsModal(); resetAll(); },
                exportFullBackup: () => exportFullBackup(),
                importFullBackup: (el) => importFullBackup(el),
                downloadCorruptBackup: () => downloadCorruptBackup(),
                discardCorruptBackup: () => discardCorruptBackup(),
                retrySaImport: () => retrySaImport(),
                hideStaleBanner: () => hideStaleBanner(),
                hideParent: (el) => { if (el.parentElement) el.parentElement.classList.add('hidden'); },
                switchTab: (_el, _e, tab) => switchTab(tab),
                switchMobileView: (_el, _e, view) => switchMobileView(view),
                openBankMobile: () => { switchMobileView('caja'); switchTab('bank'); },
                openCuadreView: () => openCuadreView(),
                clearCuadreChecks: () => clearCuadreChecks(),
                applyBankToInventory: () => applyBankToInventory(),
                clearBankLimits: () => clearBankLimits(),
                addEmployee: () => addEmployee(),
                roundAllAmounts: () => roundAllAmounts(),
                cycleSortMode: () => cycleSortMode(),
                toggleCardNumberMode: () => toggleCardNumberMode(),
                setPayrollMode: (_el, _e, mode) => setPayrollMode(mode),
                openAddDrawer: () => openAddDrawer(),
                closeAddDrawer: () => closeAddDrawer(),
                addEmployeeMobile: () => addEmployeeMobile(),
                openImportFromDrawer: () => { openImportModal(); closeAddDrawer(); },
                closePostImportModal: (_el, _e, auto) => closePostImportModal(auto === 'true'),
                closeEditModal: () => closeEditModal(),
                updateModalCalculations: (_el, _e, manual) => updateModalCalculations(manual === 'true'),
                setModalAdjustmentType: (_el, _e, field, type) => setModalAdjustmentType(field, type),
                toggleLoanDetailsPanel: () => toggleLoanDetailsPanel(),
                calcLoanFromDetails: () => calcLoanFromDetails(),
                calcLoanFromInterestAmount: () => calcLoanFromInterestAmount(),
                syncNetFromCalculated: () => syncNetFromCalculated(),
                revertEmployeeToOriginal: () => revertEmployeeToOriginal(),
                saveEmployeeModal: () => saveEmployeeModal(),
                adjustInv: (_el, _e, d, delta) => adjustInv(Number(d), Number(delta)),
                updateInventory: (el, _e, d) => updateInventory(Number(d), el.value),
                updateBankLimit: (el, _e, d) => updateBankLimit(Number(d), el.value),
                updatePayrollLoanFund: (el) => updatePayrollLoanFund(el.value),
                blurSelf: (el) => { if (typeof el.blur === 'function') el.blur(); }
            });
        }

        // Delegated events for import history modal (prevents DOM XSS via entry.id)
        const histList = document.getElementById('historyList');
        if (histList) {
            histList.addEventListener('click', (e) => {
                const target = e.target.closest('[data-history-action]');
                if (!target) return;
                const action = target.dataset.historyAction;
                const id = target.dataset.historyId;
                if (!id) return;
                if (action === 'load') loadHistoryEntry(id);
                else if (action === 'delete') deleteHistoryEntry(id);
            });
        }
    };

    return {
        init,
        addEmployee,
        addEmployeeMobile,
        removeEmployee,
        togglePaid,
        advanceEmployeeStatus,
        revertEmployeeStatus,
        toggleCardNumberMode,
        openCuadreView,
        clearCuadreChecks,
        setStatusColorScheme,
        setCardNumberMode,
        updateInventory,
        adjustInv,
        resetAll,
        exportFullBackup,
        importFullBackup,
        purgeDocumentPii,
        downloadCorruptBackup,
        discardCorruptBackup,
        switchTab,
        switchMobileView,
        openAddDrawer,
        closeAddDrawer,
        updateBankLimit,
        applyBankToInventory,
        clearBankLimits,
        addDenomination,
        removeDenom,
        resetDenominations,
        setCurrencyPreset,
        setCurrencySymbol,
        renderConfigModal,
        exportToCSV,
        exportToExcel,
        exportToPDF,
        openImportModal,
        openHistoryModal,
        closeHistoryModal,
        loadHistoryEntry,
        deleteHistoryEntry,
        retrySaImport,
        hideStaleBanner,
        openSheetStudio,
        openDocumentStudio,
        closeImportModal,
        closePostImportModal,
        processImport,
        switchImportTab,
        roundAllAmounts,
        cycleSortMode,
        togglePayrollMode,
        setPayrollMode,
        toggleCardDetails,
        resetOperation,
        restoreImportSnapshot,
        openOperationsModal,
        closeOperationsModal,
        openExportModal,
        closeExportModal,
        updatePayrollLoanFund,
        updateEmployee,
        openEditModal,
        closeEditModal,
        setModalAdjustmentType,
        updateModalCalculations,
        syncNetFromCalculated,
        saveEmployeeModal,
        revertEmployeeToOriginal,
        toggleLoanDetailsPanel,
        calcLoanFromDetails,
        calcLoanFromInterestAmount,
        openConfigModal,
        switchConfigTab,
        renderAppearanceConfig,
        renderCustomBillsConfig,
        setBreakdownFormat,
        setChipTextColor,
        setBreakdownSize,
        setBreakdownColumns,
        toggleBreakdownGroupByType,
        toggleBreakdownShowZeros,
        toggleUseDefaultImages,
        toggleRoundCoins,
        updateBillColor,
        resetBillColor,
        uploadBillImage,
        clearBillImage,
        resetAllAppearance,
        clearAllImages,
        toggleTheme,
        applyTheme,
        showCustomAlert,
        showCustomConfirm,
        showCustomChoice,
        closeCustomDialog
    };
})();

window.app = app;
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', app.init, { once: true });
} else {
    app.init();
}
