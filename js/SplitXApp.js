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
    // View-only search & status filter (never mutates state.employees or cash allocation)
    let empSearchQuery = '';
    let empStatusFilter = 'all'; // 'all' | 'pending' | 'packed' | 'paid'
    // Session physical count checkboxes & optional actual counts for the Cuadre tab
    const cuadreCheckedDenoms = new Set();
    const cuadreActualCounts = new Map();
    let _lastRenderedLedger = null;
    const clearEmployeeFiltersQuiet = () => {
        empSearchQuery = '';
        empStatusFilter = 'all';
        const input = document.getElementById('empSearchInput');
        if (input) input.value = '';
    };
    const clearCuadreState = () => {
        cuadreCheckedDenoms.clear();
        cuadreActualCounts.clear();
    };

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
                setCurrencyPreset: (code) => setCurrencyPreset(code, { silent: true }),
                normalizeEmployee: normalizeImportedEmployee,
                showCustomChoice,
                showToast,
                onImported: (info) => {
                    clearCuadreState();
                    if (info.mode === 'replace') clearEmployeeFiltersQuiet();
                    recordImport({ employees: info.employees, source: 'sa', context: info.exportContext, period: info.period, currency: info.currency });
                    try { sessionStorage.setItem('splitx_sa_received', '1'); } catch (e) { }
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
                    try { receivedBefore = sessionStorage.getItem('splitx_sa_received') === '1'; } catch (e) { }
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
        const hadCommitted = state.employees.some(e => {
            const st = SplitXCore.getEmployeePayoutStatus(e);
            return st === 'packed' || st === 'paid';
        });
        let choice = 'replace';
        if (state.employees.length > 0) {
            const d = SplitXImportHistory.describeEntry(entry);
            const committedNote = hadCommitted ? ' Atención: reemplazar descartará los sobres armados o pagados actuales.' : '';
            choice = await showCustomChoice({
                title: 'Cargar del historial',
                message: `"${entry.title}"${d.periodLabel ? ' (' + d.periodLabel + ')' : ''} tiene ${newEmps.length} colaboradores. Ya tienes ${state.employees.length} en la lista actual.${committedNote} ¿Cómo deseas proceder?`,
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
        lastImportAction = choice;
        clearCuadreState();
        if (choice === 'replace') {
            state.employees = newEmps;
            state.payrollLoanFund = 0;
            state.bankLimits = {};
            clearEmployeeFiltersQuiet();
        } else {
            state.employees = [...state.employees, ...newEmps];
        }
        const canSwitchGlobals = choice === 'replace' || !hadCommitted;
        if (canSwitchGlobals && newEmps.some(e => e.payroll)) state.payrollMode = 'deductions';
        const code = String(entry.currency || '').toUpperCase();
        if (canSwitchGlobals && CURRENCY_PRESETS[code] && state.currency !== code) {
            await setCurrencyPreset(code, { silent: true });
        }
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
            syncController.syncFromLoaded(state);
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
            const validCols = state.breakdownColumns;
            state.breakdownColumns = (validCols === 'auto' || validCols === 3 || validCols === 4 || validCols === 5 || validCols === 6) ? validCols : 5;
            if (state.breakdownGroupByType === undefined) state.breakdownGroupByType = false;
            if (state.breakdownShowZeros === undefined) state.breakdownShowZeros = false;
            state.breakdownSize = (state.breakdownSize === 'compact' || state.breakdownSize === 'normal' || state.breakdownSize === 'large') ? state.breakdownSize : 'normal';
            state.breakdownFormat = (state.breakdownFormat === 'badge' || state.breakdownFormat === 'qty_x_denom' || state.breakdownFormat === 'denom_x_qty') ? state.breakdownFormat : 'badge';
            state.chipTextColor = (state.chipTextColor === 'dark_tone' || state.chipTextColor === 'black' || state.chipTextColor === 'white') ? state.chipTextColor : 'dark_tone';
            if (state.statusColorScheme !== 'classic' && state.statusColorScheme !== 'traffic') state.statusColorScheme = 'traffic';
            if (state.cardNumberMode !== 'order' && state.cardNumberMode !== 'ref') state.cardNumberMode = 'ref';
            // Sanitize stored bankLimits, inventory, billColors and billImages on load (defense-in-depth against stored XSS)
            const cleanInv = {};
            if (state.inventory && typeof state.inventory === 'object') {
                Object.entries(state.inventory).forEach(([k, v]) => {
                    const d = Number(k);
                    if (Number.isFinite(d) && d > 0) cleanInv[d] = SplitXCore.sanitizeInventoryQty(v);
                });
            }
            state.inventory = cleanInv;
            const cleanLimits = {};
            if (state.bankLimits && typeof state.bankLimits === 'object') {
                Object.entries(state.bankLimits).forEach(([k, v]) => {
                    const d = Number(k);
                    const lim = SplitXCore.sanitizeBankLimit(v);
                    if (Number.isFinite(d) && d > 0 && lim !== null) cleanLimits[d] = lim;
                });
            }
            state.bankLimits = cleanLimits;
            if (state.billColors && typeof state.billColors === 'object') {
                const cleanColors = {};
                Object.entries(state.billColors).forEach(([k, v]) => {
                    const hex = sanitizeHexColor(v);
                    if (hex) cleanColors[k] = hex;
                });
                state.billColors = cleanColors;
            } else {
                state.billColors = {};
            }
            if (state.billImages && typeof state.billImages === 'object') {
                const cleanImgs = {};
                Object.entries(state.billImages).forEach(([k, v]) => {
                    if (SplitXCurrencies.isSafeBillImage(v)) cleanImgs[k] = String(v);
                });
                state.billImages = cleanImgs;
            } else {
                state.billImages = {};
            }
            if (parsed.theme !== 'dark' && parsed.theme !== 'light') {
                state.theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            }
            if (Array.isArray(state.employees)) {
                state.employees = state.employees.map(emp => {
                    const rawStatus = SplitXCore.getEmployeePayoutStatus(emp);
                    const locked = SplitXCore.sanitizeLockedDistribution(emp.lockedDistribution);
                    const payoutStatus = (rawStatus === 'packed' && (Number(emp.amount) || 0) > 0 && !locked) ? 'pending' : rawStatus;
                    const lockedDistribution = payoutStatus === 'pending' ? null : locked;
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
            state.denominations.sort((a, b) => b - a).forEach(d => state.inventory[d] = 0);
            state.theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        applyTheme();
        undoStack.reset(captureUndoSnapshot());
    };

    const undoStack = SplitXCore.createUndoStack(40);
    const captureUndoSnapshot = () => ({
        employees: state.employees,
        inventory: state.inventory,
        bankLimits: state.bankLimits,
        payrollMode: state.payrollMode,
        payrollLoanFund: state.payrollLoanFund,
        currency: state.currency,
        currencySymbol: state.currencySymbol,
        denominations: state.denominations,
        coinDenoms: state.coinDenoms
    });
    const applyUndoSnapshot = (snap) => {
        if (!snap || typeof snap !== 'object') return;
        state.employees = Array.isArray(snap.employees) ? snap.employees : [];
        state.inventory = snap.inventory && typeof snap.inventory === 'object' ? snap.inventory : {};
        state.bankLimits = snap.bankLimits && typeof snap.bankLimits === 'object' ? snap.bankLimits : {};
        state.payrollMode = snap.payrollMode === 'deductions' ? 'deductions' : 'normal';
        state.payrollLoanFund = Number(snap.payrollLoanFund) || 0;
        if (snap.currency) state.currency = snap.currency;
        if (snap.currencySymbol) state.currencySymbol = sanitizeCurrencySymbol(snap.currencySymbol);
        if (Array.isArray(snap.denominations) && snap.denominations.length > 0) state.denominations = [...snap.denominations];
        if (Array.isArray(snap.coinDenoms) && snap.coinDenoms.length > 0) state.coinDenoms = [...snap.coinDenoms];
    };
    const syncUndoRedoButtons = () => {
        const setBtn = (id, enabled) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
            btn.classList.toggle('opacity-40', !enabled);
            btn.classList.toggle('cursor-not-allowed', !enabled);
            btn.classList.toggle('cursor-pointer', enabled);
        };
        setBtn('undoBtn', undoStack.canUndo());
        setBtn('redoBtn', undoStack.canRedo());
    };
    const undoAction = () => {
        if (!undoStack.canUndo()) return;
        const beforeSnap = JSON.parse(JSON.stringify(captureUndoSnapshot()));
        const prevSnap = undoStack.undo();
        if (!prevSnap) return;
        applyUndoSnapshot(prevSnap);
        clearCuadreState();
        if (!saveData({ fromHistory: true })) {
            undoStack.redo();
            applyUndoSnapshot(beforeSnap);
            renderAll();
            return;
        }
        showToast('Cambio deshecho (Ctrl+Z).', 'info');
    };
    const redoAction = () => {
        if (!undoStack.canRedo()) return;
        const beforeSnap = JSON.parse(JSON.stringify(captureUndoSnapshot()));
        const nextSnap = undoStack.redo();
        if (!nextSnap) return;
        applyUndoSnapshot(nextSnap);
        clearCuadreState();
        if (!saveData({ fromHistory: true })) {
            undoStack.undo();
            applyUndoSnapshot(beforeSnap);
            renderAll();
            return;
        }
        showToast('Cambio rehecho (Ctrl+Y).', 'info');
    };

    let _externalTabConflictNotified = false;
    const syncController = SplitXSync.createSyncController({
        getState: () => state,
        readRaw: () => (typeof localStorage !== 'undefined' ? localStorage.getItem(SplitXStorage.KEYS.DATA) : null),
        writeRaw: (serialized) => storageSet('Split_data', serialized),
        parseSavedState: SplitXState.parseSavedState,
        schemaVersion: SplitXState.SCHEMA_VERSION,
        showCustomChoice: (opts) => showCustomChoice(opts),
        onReload: () => location.reload(),
        onBeforeCommit: ({ fromHistory = false } = {}) => {
            if (!fromHistory) undoStack.push(captureUndoSnapshot());
        },
        onAfterCommit: () => renderAll(),
        onConflictBlocked: () => renderAll()
    });

    const saveData = (opts = {}) => syncController.save(opts);

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('storage', (event) => {
            if (event.key !== SplitXStorage.KEYS.DATA || !event.newValue) return;
            if (syncController.handleExternalStorage(event.newValue)) {
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

    const empLabel = (emp) => {
        if (!emp) return '';
        const nameEdited = !!(emp.isEdited && emp.originalData && emp.originalData.name && emp.name !== emp.originalData.name);
        return (!nameEdited && emp.employeeName) ? emp.employeeName : (emp.name || '');
    };

    const removeEmployee = async (id) => {
        const emp = state.employees.find(e => e.id === id);
        if (!emp) return;
        const st = SplitXCore.getEmployeePayoutStatus(emp);
        if (st === 'paid' || st === 'packed') {
            const label = empLabel(emp);
            const msg = st === 'paid'
                ? `${label} ya está marcado como PAGADO. Si lo eliminas, el efectivo fijado volverá a aparecer como disponible en Mi Caja (puede causar descuadre con el efectivo físico ya entregado). ¿Seguro que deseas eliminarlo?`
                : `${label} ya tiene su dinero apartado "En sobre". Si lo eliminas, esos billetes volverán a estar disponibles en Mi Caja. ¿Deseas continuar?`;
            const ok = await showCustomConfirm({
                title: st === 'paid' ? '¿Eliminar colaborador ya pagado?' : '¿Eliminar colaborador con sobre armado?',
                message: msg,
                icon: 'fa-triangle-exclamation',
                type: 'danger',
                confirmText: 'Sí, eliminar',
                cancelText: 'Cancelar'
            });
            if (!ok) return;
        }
        const removedLabel = empLabel(emp);
        state.employees = state.employees.filter(e => e.id !== id);
        clearCuadreState();
        if (!saveData()) return;
        showToast(`Eliminado: ${removedLabel}.`, 'info', {
            actionLabel: 'Deshacer',
            durationMs: 6000,
            onAction: () => undoAction()
        });
    };

    const undoAdvanceTransition = (id, expectedStatus, prevStatus, prevPaid, prevLocked) => {
        const cur = state.employees.find(e => e.id === id);
        if (!cur) return;
        if (SplitXCore.getEmployeePayoutStatus(cur) !== expectedStatus) return;
        if (undoStack.length > 0) {
            undoAction();
            return;
        }
        state.employees = state.employees.map(e =>
            e.id === id
                ? { ...e, payoutStatus: prevStatus, paid: prevPaid, lockedDistribution: prevLocked }
                : e
        );
        clearCuadreState();
        saveData();
        showToast(`Cambio deshecho: ${empLabel(cur)}.`, 'info');
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
        const prevPaid = !!emp.paid;
        const prevLocked = SplitXCore.sanitizeLockedDistribution(emp.lockedDistribution);

        if (currentStatus === 'pending') {
            const totalBoxCents = state.denominations.reduce((s, d) => s + SplitXCore.toCents(d) * Math.max(0, Number(state.inventory[d]) || 0), 0);
            if (totalBoxCents === 0) {
                // Hybrid checklist mode: box is empty -> mark directly Paid
                state.employees = state.employees.map(e =>
                    e.id === id ? { ...e, payoutStatus: 'paid', paid: true, lockedDistribution: null } : e
                );
                clearCuadreState();
                if (!saveData()) return;
                showToast(`${empLabel(emp)} marcado como Pagado (modo sin caja).`, 'success', {
                    actionLabel: 'Deshacer',
                    durationMs: 5000,
                    onAction: () => undoAdvanceTransition(id, 'paid', 'pending', prevPaid, prevLocked)
                });
                return;
            }
            if (covEmp.status === 'error' || (covEmp._missingAmount || 0) > 0) {
                showToast(`Faltan ${fmt(covEmp._missingAmount || 0)} en caja para armar el sobre de ${empLabel(emp)}.`, 'warning');
                return;
            }
            const locked = SplitXCore.sanitizeLockedDistribution(covEmp.distribution);
            state.employees = state.employees.map(e =>
                e.id === id ? { ...e, payoutStatus: 'packed', paid: false, lockedDistribution: locked } : e
            );
            clearCuadreState();
            if (!saveData()) return;
            showToast(`Sobre apartado: ${empLabel(emp)}.`, 'success', {
                actionLabel: 'Deshacer',
                durationMs: 5000,
                onAction: () => undoAdvanceTransition(id, 'packed', 'pending', prevPaid, prevLocked)
            });
            return;
        }

        if (currentStatus === 'packed') {
            state.employees = state.employees.map(e =>
                e.id === id ? { ...e, payoutStatus: 'paid', paid: true } : e
            );
            clearCuadreState();
            if (!saveData()) return;
            showToast(`Pagado ✓✓: ${empLabel(emp)}.`, 'success', {
                actionLabel: 'Deshacer',
                durationMs: 5000,
                onAction: () => undoAdvanceTransition(id, 'paid', 'packed', prevPaid, prevLocked)
            });
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
            clearCuadreState();
            saveData();
            showToast(`Sobre desarmado: billetes de ${empLabel(emp)} devueltos a caja disponible.`, 'info');
            return;
        }

        if (currentStatus === 'paid') {
            const hasLocked = !!SplitXCore.sanitizeLockedDistribution(emp.lockedDistribution);
            const targetLabel = hasLocked ? 'En sobre' : 'Pendiente';
            const ok = await showCustomConfirm({
                title: '¿Revertir estado Pagado?',
                message: `${empLabel(emp)} volverá al estado "${targetLabel}". ¿Deseas continuar?`,
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
            clearCuadreState();
            saveData();
            showToast(`${empLabel(emp)} devuelto a ${targetLabel}.`, 'info');
        }
    };

    const togglePaid = (id) => advanceEmployeeStatus(id);

    const updateInventory = (denom, val) => {
        state.inventory[denom] = SplitXCore.sanitizeInventoryQty(val);
        clearCuadreState();
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
        clearCuadreState();
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

    const setCurrencyPreset = async (key, { silent = false } = {}) => {
        const preset = CURRENCY_PRESETS[key];
        if (!preset) return;
        const isSwitchingCurrency = state.currency !== preset.code;
        const presetDenomSet = new Set(preset.denominations.map(Number));
        const affectedLocked = state.employees.filter(e => {
            const st = SplitXCore.getEmployeePayoutStatus(e);
            const locked = SplitXCore.sanitizeLockedDistribution(e.lockedDistribution);
            if ((st !== 'packed' && st !== 'paid') || !locked) return false;
            if (isSwitchingCurrency) return true;
            return Object.entries(locked).some(([d, qty]) => qty > 0 && !presetDenomSet.has(Number(d)));
        });
        if (!silent && affectedLocked.length > 0) {
            const ok = await showCustomConfirm({
                title: isSwitchingCurrency ? '¿Cambiar de moneda con sobres fijados?' : '¿Restaurar denominaciones con sobres fijados?',
                message: isSwitchingCurrency
                    ? `Hay ${affectedLocked.length} colaborador(es) con billetes fijados en ${state.currency}. Cambiar a ${preset.code} liberará esos desgloses y reiniciará los sobres a Pendiente para evitar mezclar monedas. ¿Continuar?`
                    : `Hay ${affectedLocked.length} colaborador(es) con sobres fijados usando denominaciones personalizadas que desaparecerán al aplicar el preset ${preset.code}. Esos sobres volverán a Pendiente. ¿Continuar?`,
                icon: 'fa-triangle-exclamation',
                type: 'warning',
                confirmText: isSwitchingCurrency ? 'Sí, cambiar moneda' : 'Sí, restaurar y reajustar',
                cancelText: 'Cancelar'
            });
            if (!ok) return;
            const affectedIds = new Set(affectedLocked.map(e => e.id));
            state.employees = state.employees.map(e =>
                affectedIds.has(e.id) ? { ...e, payoutStatus: 'pending', paid: false, lockedDistribution: null } : e
            );
        }

        state.currency = preset.code;
        state.currencySymbol = sanitizeCurrencySymbol(preset.symbol);
        state.denominations = [...preset.denominations];
        state.coinDenoms = [...preset.coinDenoms];

        if (key === 'DOP') {
            state.useDefaultImages = true;
        }

        state.billColors = preset.colors ? { ...preset.colors } : {};

        // Prune stale inventory & bankLimits keys from removed denominations or previous currency
        const nextInv = {};
        const nextLimits = {};
        state.denominations.forEach(d => {
            nextInv[d] = isSwitchingCurrency ? 0 : (state.inventory[d] !== undefined ? state.inventory[d] : 0);
            if (!isSwitchingCurrency && state.bankLimits && state.bankLimits[d] !== undefined) {
                nextLimits[d] = state.bankLimits[d];
            }
        });
        state.inventory = nextInv;
        state.bankLimits = nextLimits;
        clearCuadreState();

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

    const removeDenom = async (denom) => {
        if (state.denominations.length <= 1) {
            showToast('Debes mantener al menos una denominación activa', 'warning');
            return;
        }
        const affected = state.employees.filter(e => {
            const locked = SplitXCore.sanitizeLockedDistribution(e.lockedDistribution);
            return locked && (locked[Number(denom)] || 0) > 0;
        });
        if (affected.length > 0) {
            const ok = await showCustomConfirm({
                title: 'Denominación usada en sobres',
                message: `La denominación ${getCurrencySymbol()} ${denom} está fijada en ${affected.length} colaborador(es) ("En sobre" o "Pagado"). Si la eliminas, esos sobres volverán a "Pendiente" para recalcularse. ¿Continuar?`,
                icon: 'fa-triangle-exclamation',
                type: 'warning',
                confirmText: 'Sí, eliminar y reajustar',
                cancelText: 'Cancelar'
            });
            if (!ok) return;
            const ids = new Set(affected.map(e => e.id));
            state.employees = state.employees.map(e =>
                ids.has(e.id) ? { ...e, payoutStatus: 'pending', paid: false, lockedDistribution: null } : e
            );
        }
        state.denominations = state.denominations.filter(d => Number(d) !== Number(denom));
        delete state.inventory[denom];
        if (state.bankLimits) delete state.bankLimits[denom];
        clearCuadreState();
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

    const resetDenominations = async () => {
        const preset = CURRENCY_PRESETS[state.currency || 'DOP'] || CURRENCY_PRESETS.DOP;
        const presetSet = new Set(preset.denominations.map(Number));
        const affected = state.employees.filter(e => {
            const locked = SplitXCore.sanitizeLockedDistribution(e.lockedDistribution);
            if (!locked) return false;
            return Object.entries(locked).some(([d, qty]) => qty > 0 && !presetSet.has(Number(d)));
        });
        if (affected.length > 0) {
            const ok = await showCustomConfirm({
                title: 'Restaurar denominaciones con sobres fijados',
                message: `${affected.length} colaborador(es) tienen sobres fijados con denominaciones personalizadas que desaparecerán al restaurar ${preset.code}. Esos sobres volverán a "Pendiente". ¿Continuar?`,
                icon: 'fa-triangle-exclamation',
                type: 'warning',
                confirmText: 'Sí, restaurar y reajustar',
                cancelText: 'Cancelar'
            });
            if (!ok) return;
            const ids = new Set(affected.map(e => e.id));
            state.employees = state.employees.map(e =>
                ids.has(e.id) ? { ...e, payoutStatus: 'pending', paid: false, lockedDistribution: null } : e
            );
        }
        state.denominations = [...preset.denominations];
        state.coinDenoms = [...preset.coinDenoms];
        const nextInv = {};
        const nextLimits = {};
        state.denominations.forEach(d => {
            nextInv[d] = state.inventory[d] !== undefined ? state.inventory[d] : 0;
            if (state.bankLimits && state.bankLimits[d] !== undefined) nextLimits[d] = state.bankLimits[d];
        });
        state.inventory = nextInv;
        state.bankLimits = nextLimits;
        clearCuadreState();
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
        computeLedgerSummary: SplitXCore.computeLedgerSummary,
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
                tab.classList.add('bg-white', 'dark:bg-slate-800', 'text-blue-700', 'dark:text-blue-300', 'shadow-sm');
                tab.classList.remove('text-slate-500', 'dark:text-slate-400', 'hover:text-slate-700', 'dark:hover:text-slate-200');
                info.classList.remove('hidden');
            } else {
                tab.classList.remove('bg-white', 'dark:bg-slate-800', 'text-blue-700', 'dark:text-blue-300', 'shadow-sm');
                tab.classList.add('text-slate-500', 'dark:text-slate-400', 'hover:text-slate-700', 'dark:hover:text-slate-200');
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
        } catch (e) {
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
                const hadCommitted = state.employees.some(e => {
                    const st = SplitXCore.getEmployeePayoutStatus(e);
                    return st === 'packed' || st === 'paid';
                });
                let importChoice = 'replace';
                if (state.employees.length > 0) {
                    const committedNote = hadCommitted ? ' Atención: reemplazar descartará los sobres armados o pagados actuales.' : '';
                    const choice = await showCustomChoice({
                        title: 'Colaboradores detectados',
                        message: `Se detectaron ${newEmps.length} colaboradores en la importación. Ya tienes ${state.employees.length} colaboradores en la lista actual.${committedNote} ¿Cómo deseas proceder?`,
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
                    importChoice = choice;

                    if (choice === 'replace') {
                        lastImportAction = 'replace';
                        state.employees = newEmps;
                        state.payrollLoanFund = 0;
                        state.bankLimits = {};
                        clearEmployeeFiltersQuiet();
                    } else if (choice === 'append') {
                        lastImportAction = 'append';
                        state.employees = [...state.employees, ...newEmps];
                    }
                } else {
                    lastImportAction = 'replace';
                    state.employees = newEmps;
                    state.payrollLoanFund = 0;
                    state.bankLimits = {};
                    clearEmployeeFiltersQuiet();
                }
                clearCuadreState();

                const canSwitchGlobals = importChoice === 'replace' || !hadCommitted;
                if (canSwitchGlobals && newEmps.some(e => e.payroll)) state.payrollMode = 'deductions';
                const importCurrency = String(importContext?.currency || '').toUpperCase();
                if (canSwitchGlobals && CURRENCY_PRESETS[importCurrency] && state.currency !== importCurrency) {
                    await setCurrencyPreset(importCurrency, { silent: true });
                }
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

            clearCuadreState();
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

    let _lastRenderCtx = null;

    const renderAll = () => {
        // Compute derived state ONCE per render cycle (avoids 4x-8x recalculation cascade)
        const coverage = calculateDistribution();
        const bankData = calculateBankNeeds(coverage);
        const payrollSummary = getPayrollSummary();
        const ledger = SplitXCore.computeLedgerSummary(state.denominations, state.inventory, coverage.results, coverage.loanFundResult);
        _lastRenderCtx = { coverage, payrollSummary };

        renderInventory(coverage.leftoverInventory, coverage.results, coverage.loanFundResult, ledger);
        renderEmployees(coverage.results, coverage.loanFundResult, payrollSummary);
        renderBank(bankData);
        renderCuadre(ledger);
        renderConfigModal();
        updateTotals(coverage, bankData, payrollSummary, ledger);
        syncUndoRedoButtons();
        if (document.getElementById('appearanceLivePreviewCard')) {
            renderAppearancePreviewCard();
        }
    };

    const renderFilteredEmployeesOnly = () => {
        if (_lastRenderCtx) {
            renderEmployees(_lastRenderCtx.coverage.results, _lastRenderCtx.coverage.loanFundResult, _lastRenderCtx.payrollSummary);
        } else {
            renderAll();
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
            const overQty = ledger?.overcommittedDenoms?.[denom] || 0;
            const isCoinDenom = isCoin(denom);
            const isRound = state.roundCoins !== false && isCoinDenom;
            const shapeClass = isRound ? 'chip-vector-coin' : 'chip-vector-banknote';
            const shapeStyle = isRound ? 'width:32px;height:32px;' : 'width:54px;height:28px;';
            const hasImg = !!getBillImage(denom);
            const innerHTML = hasImg ? '' : (isRound ? `<div class="coin-inner"></div><span class="coin-text">${denom}</span>` : `<div class="banknote-inner"></div><span class="banknote-text">${denom}</span>`);
            if (overQty > 0) div.classList.add('inv-row-overcommitted', 'border-rose-300', 'dark:border-rose-800', 'bg-rose-50/40', 'dark:bg-rose-950/30');

            div.innerHTML = `
                <div class="flex items-center gap-2.5 min-w-0">
                    <div class="bill-chip ${shapeClass} shrink-0" style="${billStyle};${shapeStyle}">
                        ${innerHTML}
                    </div>
                    <div class="flex flex-col leading-tight">
                        <span class="text-xs sm:text-sm font-semibold text-slate-500 dark:text-slate-400">
                            × <span class="font-bold font-mono text-sm sm:text-base ${qty > 0 ? 'text-slate-900 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500'}">${qty}</span>
                        </span>
                        ${overQty > 0
                    ? `<span class="text-[10px] font-mono font-bold text-rose-600 dark:text-rose-400">faltan ${overQty} (apart.: ${committed})</span>`
                    : (committed > 0 ? `<span class="text-[10px] font-mono font-semibold text-blue-600 dark:text-sky-400">en mano: ${freeInHand}</span>` : '')}
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

                // Rule: If missing denomination < largest available surplus denomination -> Yellow (can swap/change larger bill)
                // Rule: Else -> Red (real cash missing)
                const maxSurplus = advisorData.surplus.length > 0
                    ? Math.max(...advisorData.surplus.map(s => s.denom))
                    : 0;

                // We check each deficit line
                let deficitHTML = `<div class="font-semibold flex flex-col gap-1 mt-2">`;

                advisorData.deficit.forEach(d => {
                    let colorClass = "text-red-600 dark:text-rose-400";
                    let icon = "fa-arrow-trend-down";

                    if (maxSurplus > 0 && d.denom < maxSurplus) {
                        colorClass = "text-yellow-600 dark:text-amber-300";
                        icon = "fa-rotate"; // Icon indicating "Change/Swap"
                    }

                    deficitHTML += `<div class="${colorClass}"><i class="fa-solid ${icon} mr-1"></i>Faltan: ${d.count}x${escapeHTML(getCurrencySymbol())}${d.denom}</div>`;
                });
                deficitHTML += `</div>`;

                let surplusHTML = advisorData.surplus.length > 0
                    ? `<div class="mb-1 text-green-700 dark:text-emerald-400 font-semibold"><i class="fa-solid fa-arrow-trend-up mr-1"></i>Sobran: ` + advisorData.surplus.map(s => `${s.count}x${escapeHTML(getCurrencySymbol())}${s.denom}`).join(', ') + `</div>`
                    : `<div class="mb-1 text-slate-500 dark:text-slate-400 italic text-[10px]">No hay sobrantes útiles.</div>`;

                advisorEl.innerHTML = `
                    <p class="font-bold text-orange-800 dark:text-orange-200 mb-2 border-b border-orange-200 dark:border-orange-800/70 pb-1">Asesor de Cambio</p>
                    ${surplusHTML}
                    ${deficitHTML}
                    <p class="mt-2 text-[10px] text-orange-700 dark:text-orange-300 italic">Consejo: Usa los sobrantes para cubrir los faltantes amarillos.</p>
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
        {
            key: 'status', label: 'Prioridad', icon: 'fa-arrow-down-short-wide',
            fn: (a, b) => {
                const pa = priorityBucket(a);
                const pb = priorityBucket(b);
                if (pa !== pb) return pa - pb;
                const ai = typeof a._originalIndex === 'number' ? a._originalIndex : state.employees.findIndex(e => e.id === a.id);
                const bi = typeof b._originalIndex === 'number' ? b._originalIndex : state.employees.findIndex(e => e.id === b.id);
                return ai - bi;
            }
        },
        {
            key: 'ref', label: 'Lista fija', icon: 'fa-arrow-down-1-9',
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
        const idx = SORT_MODES.findIndex(m => m.key === sortMode);
        const next = SORT_MODES[(idx + 1) % SORT_MODES.length];
        sortMode = next.key;
        const btn = document.getElementById('sortBtn');
        const label = document.getElementById('sortBtnLabel');
        if (btn) {
            btn.style.borderColor = '';
            btn.style.color = '';
            btn.style.background = '';
            const icon = btn.querySelector('i');
            if (icon) { icon.className = `fa-solid ${next.icon} text-xs`; }
        }
        if (label) label.textContent = next.label;
        renderAll();
    };

    const setPayrollMode = async (mode) => {
        const nextMode = mode === 'deductions' ? 'deductions' : 'normal';
        if (state.payrollMode === nextMode) return;
        const effectiveIn = (e, m) => (m === 'normal' && e.payroll && e.payroll.afterDiscounts !== undefined && e.payroll.afterDiscounts !== null)
            ? (Number(e.payroll.afterDiscounts) || 0)
            : (Number(e.amount) || 0);
        const affectedCommitted = state.employees.filter(e => {
            const st = SplitXCore.getEmployeePayoutStatus(e);
            if (st !== 'packed' && st !== 'paid') return false;
            return Math.abs(effectiveIn(e, state.payrollMode) - effectiveIn(e, nextMode)) > 0.001;
        });
        if (affectedCommitted.length > 0) {
            const hasPaidAffected = affectedCommitted.some(e => SplitXCore.getEmployeePayoutStatus(e) === 'paid');
            const ok = await showCustomConfirm({
                title: hasPaidAffected ? 'Pagos y sobres afectados' : 'Sobres apartados afectados',
                message: `Cambiar de modo afectará el monto efectivo de ${affectedCommitted.length} colaborador(es) ya marcados como "En sobre" o "Pagado". Esos registros volverán a "Pendiente" para reajustar los billetes. ¿Continuar?`,
                icon: 'fa-triangle-exclamation',
                type: 'warning',
                confirmText: 'Sí, cambiar modo',
                cancelText: 'Cancelar'
            });
            if (!ok) return;
            const affectedIds = new Set(affectedCommitted.map(e => e.id));
            state.employees = state.employees.map(e =>
                affectedIds.has(e.id) ? { ...e, payoutStatus: 'pending', paid: false, lockedDistribution: null } : e
            );
            clearCuadreState();
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
        clearCuadreState();
        clearEmployeeFiltersQuiet();
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
        clearCuadreState();
        clearEmployeeFiltersQuiet();
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
        clearCuadreState();
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
        let changedAmount = false;
        state.employees = state.employees.map(e => {
            if (e.id !== id) return e;
            if (field === 'amount') {
                const parsed = parseFloat(value);
                if (isNaN(parsed) || parsed < 0) return e;
                const payroll = e.payroll ? { ...e.payroll, net: parsed } : e.payroll;
                const prevAmount = Number(e.amount) || 0;
                const amountDiff = Math.abs(parsed - prevAmount) > 0.005;
                if (amountDiff) changedAmount = true;
                const st = SplitXCore.getEmployeePayoutStatus(e);
                const resetLedger = amountDiff && (st === 'packed' || st === 'paid')
                    ? { payoutStatus: 'pending', paid: false, lockedDistribution: null }
                    : {};
                return { ...e, amount: parsed, payroll, ...resetLedger };
            }
            if (field === 'name') {
                const trimmed = String(value || '').trim();
                if (!trimmed) return e;
                return e.employeeName ? { ...e, name: trimmed, employeeName: trimmed } : { ...e, name: trimmed };
            }
            return e;
        });
        if (changedAmount) clearCuadreState();
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
            const icon = document.getElementById('sortBtn')?.querySelector('i');
            if (label) label.textContent = mode ? mode.label : 'Orden';
            if (icon && mode) icon.className = `fa-solid ${mode.icon} text-xs`;
        }

        // Sync view-only search & status filter UI (never mutates allocation or state.employees)
        const allList = Array.isArray(data) ? data : [];
        const counts = { all: allList.length, pending: 0, packed: 0, paid: 0 };
        allList.forEach(e => {
            const st = SplitXCore.getEmployeePayoutStatus(e);
            if (counts[st] !== undefined) counts[st] += 1;
        });
        const filterButtons = [
            { id: 'empFilterAll', key: 'all', label: 'Todos', active: 'bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900 font-bold' },
            { id: 'empFilterPending', key: 'pending', label: `Pend.${counts.pending ? ` (${counts.pending})` : ''}`, active: 'bg-amber-600 text-white font-bold' },
            { id: 'empFilterPacked', key: 'packed', label: `Sobre${counts.packed ? ` (${counts.packed})` : ''}`, active: 'bg-blue-600 text-white font-bold' },
            { id: 'empFilterPaid', key: 'paid', label: `Pag.${counts.paid ? ` (${counts.paid})` : ''}`, active: 'bg-emerald-600 text-white font-bold' }
        ];
        filterButtons.forEach(cfg => {
            const btn = document.getElementById(cfg.id);
            if (!btn) return;
            btn.textContent = cfg.label;
            const isActive = empStatusFilter === cfg.key;
            btn.className = `px-2.5 py-1 rounded-full text-[11px] transition-colors ${isActive ? cfg.active : 'font-semibold bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'}`;
            btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
        const clearSearchBtn = document.getElementById('empSearchClearBtn');
        if (clearSearchBtn) clearSearchBtn.classList.toggle('hidden', !empSearchQuery);

        if (allList.length === 0) {
            container.innerHTML = `<div class="text-center py-10 text-slate-400 dark:text-slate-500 flex flex-col items-center">
                <i class="fa-solid fa-users-viewfinder text-4xl mb-3 opacity-30"></i>
                <p>No hay empleados en la lista.</p>
            </div>`;
            document.getElementById('employeeCountBadge').innerText = '0';
            return;
        }

        const normQuery = normalizeSearchText(empSearchQuery);
        const visibleList = allList.filter((emp, idx) => {
            if (empStatusFilter !== 'all' && SplitXCore.getEmployeePayoutStatus(emp) !== empStatusFilter) return false;
            if (!normQuery) return true;
            const hay = normalizeSearchText([
                emp.name,
                emp.employeeName,
                emp.employeeNumber,
                String((typeof emp._originalIndex === 'number' ? emp._originalIndex : idx) + 1)
            ].filter(Boolean).join(' '));
            return hay.includes(normQuery);
        });

        const countBadge = document.getElementById('employeeCountBadge');
        if (countBadge) {
            countBadge.innerText = visibleList.length === allList.length
                ? String(allList.length)
                : `${visibleList.length} / ${allList.length}`;
        }

        if (visibleList.length === 0) {
            container.innerHTML = `<div class="text-center py-10 text-slate-400 dark:text-slate-500 flex flex-col items-center gap-2">
                <i class="fa-solid fa-filter-circle-xmark text-3xl opacity-40"></i>
                <p class="text-sm font-medium text-slate-600 dark:text-slate-300">Ningún colaborador coincide con el filtro actual.</p>
                <button type="button" data-sx-click="clearEmployeeFilters" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                    Limpiar filtros
                </button>
            </div>`;
            return;
        }

        container.innerHTML = '';

        visibleList.forEach((emp, index) => {
            const card = createCardEl(emp, index, false);
            container.appendChild(card);
        });
    };

    const normalizeSearchText = (str) => String(str || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

    const setEmployeeSearch = (val) => {
        empSearchQuery = String(val || '');
        renderFilteredEmployeesOnly();
    };

    const clearEmployeeSearch = () => {
        empSearchQuery = '';
        const input = document.getElementById('empSearchInput');
        if (input) input.value = '';
        renderFilteredEmployeesOnly();
    };

    const setEmployeeStatusFilter = (filter) => {
        empStatusFilter = (filter === 'pending' || filter === 'packed' || filter === 'paid') ? filter : 'all';
        renderFilteredEmployeesOnly();
    };

    const clearEmployeeFilters = () => {
        empSearchQuery = '';
        empStatusFilter = 'all';
        const input = document.getElementById('empSearchInput');
        if (input) input.value = '';
        renderFilteredEmployeesOnly();
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

            const userLimit = SplitXCore.sanitizeBankLimit(state.bankLimits[denom]);
            const isLimited = userLimit !== null && rowData.neededAfterCarry > rowData.final;

            const row = document.createElement('tr');
            row.className = "bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/60";
            row.innerHTML = `
                <td class="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">${denom}</td>
                <td class="px-2 py-3 text-center text-slate-500 dark:text-slate-400 text-xs">${rowData.neededAfterCarry}</td>
                <td class="px-2 py-3 text-center">
                    <input type="number" min="0" step="1"
                        placeholder="∞" 
                        value="${userLimit === null ? '' : userLimit}" 
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

    const applyCuadreSwapToBox = () => {
        const coverage = calculateDistribution();
        const ledger = SplitXCore.computeLedgerSummary(state.denominations, state.inventory, coverage.results, coverage.loanFundResult);
        const swapRes = SplitXCuadre.buildSwappedInventory({
            inventory: state.inventory,
            denominations: state.denominations,
            ledger,
            actualCounts: cuadreActualCounts
        });
        if (!swapRes.ok || !swapRes.nextInventory) return;

        const prevInventory = { ...state.inventory };
        state.inventory = swapRes.nextInventory;
        clearCuadreState();
        if (!saveData()) {
            state.inventory = prevInventory;
            return;
        }
        showToast(`Intercambio aplicado a Mi Caja (${swapRes.summaryText}).`, 'success', {
            actionLabel: 'Deshacer',
            durationMs: 5000,
            onAction: () => {
                state.inventory = { ...prevInventory };
                clearCuadreState();
                saveData();
                showToast('Intercambio en Mi Caja deshecho.', 'info');
            }
        });
    };

    const updateCuadreVarianceBanner = (ledger) => {
        const banner = document.getElementById('cuadreVarianceBanner');
        if (!banner) return;
        const stats = SplitXCuadre.computeVariance({
            denominations: state.denominations,
            ledger,
            actualCounts: cuadreActualCounts
        });
        if (!stats) {
            banner.classList.add('hidden');
            banner.innerHTML = '';
            return;
        }
        const expText = escapeHTML(fmt(SplitXCuadre.fromCents(stats.expectedCents)));
        const actText = escapeHTML(fmt(SplitXCuadre.fromCents(stats.actualCents)));
        const countScope = `${stats.enteredCount}/${stats.totalDenoms} denom. contadas`;
        banner.classList.remove('hidden');

        if (stats.status === 'overcommit') {
            banner.className = 'p-2.5 rounded-lg border text-xs font-semibold bg-rose-50 dark:bg-rose-950/50 border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300';
            banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1.5"></i>Resuelve primero el sobrecompromiso de caja (−${escapeHTML(fmt(ledger.overcommitTotal))}) antes de conciliar (${countScope}: contado ${actText}).`;
        } else if (stats.status === 'swap_balanced') {
            banner.className = 'p-2.5 rounded-lg border text-xs font-semibold bg-indigo-50 dark:bg-indigo-950/50 border-indigo-200 dark:border-indigo-800 text-indigo-900 dark:text-indigo-200 space-y-2';
            banner.innerHTML = `
                <div><i class="fa-solid fa-scale-balanced mr-1.5"></i>Diferencia neta: ${escapeHTML(fmt(0))} — cuadra por intercambio (${escapeHTML(stats.deltaSummary)}). <span class="font-normal opacity-80">(${countScope})</span></div>
                <button type="button" data-sx-click="applyCuadreSwapToBox" class="w-full py-1.5 px-2.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold transition-colors flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-arrows-rotate"></i> Aplicar intercambio a Mi Caja
                </button>
            `;
        } else if (stats.status === 'exact_complete') {
            banner.className = 'p-2.5 rounded-lg border text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200';
            banner.innerHTML = `<i class="fa-solid fa-circle-check mr-1.5"></i>Conteo real completo coincide exactamente con la mesa (${actText}).`;
        } else if (stats.status === 'exact_partial') {
            banner.className = 'p-2.5 rounded-lg border text-xs font-semibold bg-blue-50 dark:bg-blue-950/50 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200';
            banner.innerHTML = `<i class="fa-solid fa-circle-info mr-1.5"></i>Parcial (${countScope}): las contadas coinciden (${actText} de ${expText} esperado en esas denominaciones).`;
        } else if (stats.status === 'shortage') {
            const prefix = stats.isComplete ? '' : `Parcial (${countScope}): `;
            banner.className = 'p-2.5 rounded-lg border text-xs font-semibold bg-rose-50 dark:bg-rose-950/50 border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300';
            banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1.5"></i>${prefix}Faltan ${escapeHTML(fmt(SplitXCuadre.fromCents(-stats.deltaCents)))} (esperado ${expText} vs real ${actText}).`;
        } else {
            const prefix = stats.isComplete ? '' : `Parcial (${countScope}): `;
            banner.className = 'p-2.5 rounded-lg border text-xs font-semibold bg-amber-50 dark:bg-amber-950/50 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200';
            banner.innerHTML = `<i class="fa-solid fa-circle-info mr-1.5"></i>${prefix}Sobran ${escapeHTML(fmt(SplitXCuadre.fromCents(stats.deltaCents)))} (esperado ${expText} vs real ${actText}).`;
        }
    };

    const renderCuadre = (ledger) => {
        const tbody = document.getElementById('cuadreTableBody');
        const totalDisplay = document.getElementById('cuadreLooseTotalDisplay');
        const footer = document.getElementById('cuadreBalanceFooter');
        const warnEl = document.getElementById('cuadreOvercommitWarning');
        const statusEl = document.getElementById('cuadreChecklistStatus');
        if (!tbody || !ledger) return;
        _lastRenderedLedger = ledger;

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
            const hasActual = cuadreActualCounts.has(denom);
            const actualVal = hasActual ? cuadreActualCounts.get(denom) : '';
            const actualDiff = hasActual ? (Number(actualVal) - looseQty) : 0;
            const inputTone = !hasActual
                ? 'border-slate-200 dark:border-slate-700'
                : actualDiff === 0
                    ? 'border-emerald-400 text-emerald-700 dark:text-emerald-300 font-bold'
                    : actualDiff < 0
                        ? 'border-rose-400 text-rose-700 dark:text-rose-300 font-bold'
                        : 'border-amber-400 text-amber-700 dark:text-amber-300 font-bold';
            if (isChecked) checkedCount += 1;

            const tr = document.createElement('tr');
            tr.className = `bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-opacity ${isChecked ? 'opacity-50' : ''}`;
            tr.innerHTML = `
                <td class="px-2 py-2 text-center">
                    <input type="checkbox" data-cuadre-denom="${denom}" ${isChecked ? 'checked' : ''}
                        aria-label="Verificar denominación ${denom}"
                        class="w-4 h-4 rounded accent-blue-600 cursor-pointer">
                </td>
                <td class="px-1.5 py-2 font-mono font-bold text-slate-800 dark:text-slate-100">${denom}</td>
                <td class="px-1 py-2 text-center font-mono text-slate-500 dark:text-slate-400">${initQty}</td>
                <td class="px-1 py-2 text-center font-mono font-bold text-blue-600 dark:text-blue-400">${packedQty > 0 ? `-${packedQty}` : '0'}</td>
                <td class="px-1 py-2 text-center font-mono text-slate-500 dark:text-slate-400">${paidQty > 0 ? `-${paidQty}` : '0'}</td>
                <td class="px-1.5 py-2 text-right font-mono font-extrabold text-sm text-indigo-700 dark:text-indigo-300">${looseQty}</td>
                <td class="px-2 py-1.5 text-center">
                    <input type="number" min="0" step="1" placeholder="—" value="${actualVal}"
                        data-cuadre-actual="${denom}" aria-label="Conteo real de denominación ${denom}"
                        class="w-12 px-1.5 py-0.5 text-center font-mono text-xs rounded border bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 outline-none focus:ring-1 focus:ring-blue-500 ${inputTone}">
                </td>
            `;
            tbody.appendChild(tr);
        });

        updateCuadreVarianceBanner(ledger);

        if (footer) {
            const overRow = ledger.overcommitTotal > 0
                ? `<div class="flex justify-between text-rose-600 dark:text-rose-400 font-bold"><span>+ Descuadre caja editada:</span><strong>+ ${escapeHTML(fmt(ledger.overcommitTotal))}</strong></div>`
                : '';
            const extRow = ledger.paidExternalTotal > 0
                ? `<div class="flex justify-between text-slate-400 dark:text-slate-500 text-[11px] pt-1"><span>Pagados sin caja (${ledger.paidExternalCount}, no salen de mesa):</span><span>${escapeHTML(fmt(ledger.paidExternalTotal))}</span></div>`
                : '';
            const loanRow = ledger.loanFundAmount > 0
                ? `<div class="flex justify-between text-teal-700 dark:text-teal-400 text-[11px] pt-0.5"><span>Reserva préstamos incluida en mesa:</span><span>${escapeHTML(fmt(ledger.loanFundAmount))}</span></div>`
                : '';
            const orphanRow = ledger.orphanedLockedTotal > 0
                ? `<div class="flex justify-between text-amber-600 dark:text-amber-400 text-[11px] pt-0.5"><span>Denominaciones retiradas en sobres:</span><span>${escapeHTML(fmt(ledger.orphanedLockedTotal))}</span></div>`
                : '';
            footer.innerHTML = `
                <div class="flex justify-between text-slate-500 dark:text-slate-400"><span>Caja inicial:</span><strong class="text-slate-800 dark:text-slate-100">${escapeHTML(fmt(ledger.totalBox))}</strong></div>
                <div class="flex justify-between text-blue-600 dark:text-blue-400"><span>− En sobres (${ledger.packedCount}):</span><strong>− ${escapeHTML(fmt(ledger.packedBillsTotal))}</strong></div>
                <div class="flex justify-between text-slate-500 dark:text-slate-400"><span>− Pagados de caja (${ledger.paidFromBoxCount}):</span><strong>− ${escapeHTML(fmt(ledger.paidFromBoxTotal))}</strong></div>
                ${overRow}
                <div class="flex justify-between pt-1.5 border-t border-slate-200 dark:border-slate-800 text-sm font-extrabold text-indigo-800 dark:text-indigo-200"><span>= Suelto en mesa:</span><span>${escapeHTML(fmt(ledger.looseTotal))}</span></div>
                ${extRow}${loanRow}${orphanRow}
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
        clearCuadreState();
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
        // Payroll & Box totals using integer-cent math (zero float drift)
        const isNormal = state.payrollMode === 'normal';
        const coverage = precomputedCoverage || calculateDistribution();
        const ledger = precomputedLedger || SplitXCore.computeLedgerSummary(state.denominations, state.inventory, coverage.results, coverage.loanFundResult);
        const totalBox = ledger.totalBox;
        document.getElementById('totalInventoryDisplay').innerText = fmt(totalBox);

        const paidEmps = coverage.results.filter(e => e.payoutStatus === 'paid');
        const packedEmps = coverage.results.filter(e => e.payoutStatus === 'packed');
        const pendingEmps = coverage.results.filter(e => e.payoutStatus === 'pending');
        const payrollSummary = precomputedSummary || getPayrollSummary();
        const loanFund = isNormal ? 0 : Math.min(Math.max(0, Number(state.payrollLoanFund) || 0), payrollSummary.loans);
        const totalPendingCents = pendingEmps.reduce((s, e) => s + SplitXCore.toCents(getEffectiveEmployeeAmount(e)), 0) + SplitXCore.toCents(loanFund);
        const totalPending = SplitXCore.fromCents(totalPendingCents);
        const employeeMissingCents = coverage.results.reduce((sum, emp) => sum + (emp.payoutStatus === 'pending' ? SplitXCore.toCents(emp._missingAmount || 0) : 0), 0);
        const totalMissing = SplitXCore.fromCents(employeeMissingCents + SplitXCore.toCents(coverage.loanFundResult.missingAmount || 0));
        const hasOvercommit = (ledger.overcommitTotal || 0) > 0;

        // ── KPI Cards ──────────────────────────────
        // KPI 1: En Caja
        const kpiCaja = document.getElementById('kpiEnCaja');
        const kpiCajaSub = document.getElementById('kpiEnCajaSub');
        if (kpiCaja) {
            kpiCaja.innerText = fmt(totalBox);
            kpiCaja.style.color = '';
            kpiCaja.className = `kpi-value ${hasOvercommit ? 'text-rose-600 dark:text-rose-400' : (totalMissing <= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-sky-400')}`;
        }
        if (kpiCajaSub) {
            if (hasOvercommit) {
                kpiCajaSub.innerHTML = `<span class="text-rose-600 dark:text-rose-400 font-semibold">Sobrecompromiso: faltan ${escapeHTML(fmt(ledger.overcommitTotal))}</span>`;
            } else if (totalMissing <= 0 && (totalPending > 0 || ledger.packedTotal > 0)) {
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
            if (loanFund > 0) parts.push(`+${fmt(loanFund)} reserva`);
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
                kpiCub.className = `kpi-value ${hasOvercommit ? 'text-rose-600 dark:text-rose-400' : (covered === total ? 'text-emerald-600 dark:text-emerald-400' : covered > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400')}`;
            }
            if (kpiCubSub) {
                const pct = total > 0 ? Math.round(covered / total * 100) : 0;
                kpiCubSub.innerText = hasOvercommit
                    ? `Caja insuficiente para sobres`
                    : ((packedEmps.length > 0 || paidEmps.length > 0)
                        ? `${pct}% cubierto · ${packedEmps.length} sobre · ${paidEmps.length} pag.`
                        : `${pct}% cubierto`);
            }
        }

        // KPI 4: Retirar banco
        const bankData = precomputedBankData || calculateBankNeeds(coverage);
        let toWithdrawCents = 0;
        state.denominations.forEach(d => {
            if (bankData.breakdown[d]) toWithdrawCents += bankData.breakdown[d].final * SplitXCore.toCents(d);
        });
        const toWithdraw = SplitXCore.fromCents(toWithdrawCents);
        const kpiRet = document.getElementById('kpiRetirar');
        if (kpiRet) {
            kpiRet.innerText = fmt(toWithdraw);
            kpiRet.style.color = '';
            kpiRet.className = `kpi-value ${toWithdraw > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`;
        }

        // Compact Multi-Segment Progress & Live Table-Cash Card (denominator includes loanFund when active)
        const totalRequired = ledger.totalRequired || ledger.totalPayroll;
        const pctPaid = totalRequired > 0 ? Math.min(100, (ledger.paidTotal / totalRequired) * 100) : 0;
        const pctPacked = totalRequired > 0 ? Math.min(100 - pctPaid, (ledger.packedTotal / totalRequired) * 100) : 0;
        const coveredPending = Math.max(0, totalPending - totalMissing);
        const pctCoveredPending = totalRequired > 0 ? Math.min(100 - pctPaid - pctPacked, (coveredPending / totalRequired) * 100) : 0;

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
            bar.className = `h-full transition-all duration-300 ${(totalMissing > 0 || hasOvercommit) ? 'bg-rose-400/70' : (isClassic ? 'bg-emerald-400/60' : 'bg-amber-400/60')}`;
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
        if (pendDisp) pendDisp.textContent = fmt(totalPending);
        const looseDisp = document.getElementById('ledgerLooseDisplay');
        if (looseDisp) looseDisp.textContent = fmt(ledger.looseTotal);

        if (statusEl) {
            if (hasOvercommit) {
                statusEl.innerHTML = `<span class="text-rose-600 dark:text-rose-400 font-semibold">Descuadre caja (−${escapeHTML(fmt(ledger.overcommitTotal))})</span>`;
            } else if (totalMissing > 0) {
                statusEl.innerHTML = `<span class="text-rose-600 dark:text-rose-400 font-semibold">Faltan ${escapeHTML(fmt(totalMissing))}</span>`;
            } else if (ledger.pendingCount === 0 && ledger.packedCount === 0 && state.employees.length > 0) {
                statusEl.innerHTML = `<span class="text-emerald-600 dark:text-emerald-400 font-semibold">${loanFund > 0 ? '¡Nómina pagada! (+ reserva lista)' : '¡Todo Pagado!'}</span>`;
            } else {
                statusEl.innerHTML = `<span class="text-emerald-600 dark:text-emerald-400 font-semibold">Caja cubierta ✓</span>`;
            }
        }
    };

    const syncMobileBottomNav = (activeKey) => {
        const map = {
            nomina: document.getElementById('bnav-nomina'),
            inventory: document.getElementById('bnav-caja'),
            bank: document.getElementById('bnav-banco'),
            cuadre: document.getElementById('bnav-cuadre')
        };
        Object.entries(map).forEach(([key, el]) => {
            if (el) el.classList.toggle('active', key === activeKey);
        });
    };

    let activeLeftTab = 'inventory';

    // Switch left panel tab (inventory / bank / cuadre)
    const switchTab = (tabName) => {
        activeLeftTab = tabName;
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
        const cajaPanel = document.getElementById('panel-caja');
        if (cajaPanel && cajaPanel.classList.contains('active')) {
            syncMobileBottomNav(tabName);
        }
        if (tabName === 'bank') renderBank();
        if (tabName === 'cuadre') {
            const coverage = calculateDistribution();
            renderCuadre(SplitXCore.computeLedgerSummary(state.denominations, state.inventory, coverage.results, coverage.loanFundResult));
        }
    };

    const openCajaMobile = () => {
        switchMobileView('caja');
        switchTab('inventory');
    };

    const openBankMobile = () => {
        switchMobileView('caja');
        switchTab('bank');
    };

    const openCuadreView = () => {
        switchMobileView('caja');
        switchTab('cuadre');
    };

    // Mobile view switcher (bottom nav + segmented control)
    const switchMobileView = (view) => {
        const nomPanel = document.getElementById('panel-nomina');
        const cajaPanel = document.getElementById('panel-caja');
        const segNom = document.getElementById('seg-nomina');
        const segCaja = document.getElementById('seg-caja');

        if (view === 'nomina') {
            nomPanel.classList.add('active'); cajaPanel.classList.remove('active');
            if (segNom) { segNom.classList.add('active'); segCaja.classList.remove('active'); }
            syncMobileBottomNav('nomina');
        } else {
            cajaPanel.classList.add('active'); nomPanel.classList.remove('active');
            if (segCaja) { segCaja.classList.add('active'); segNom.classList.remove('active'); }
            syncMobileBottomNav(activeLeftTab);
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
        const amtInput = document.getElementById('empAmountMobile');
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
        onLedgerMutated: clearCuadreState,
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

        // Global keyboard handler: Escape (modals) + Ctrl+Z / Ctrl+Y (Undo/Redo outside text inputs & modals)
        document.addEventListener('keydown', (e) => {
            const isOpen = (id) => {
                const el = document.getElementById(id);
                return !!(el && !el.classList.contains('hidden') && !el.hidden);
            };
            const anyModalOpen = () => (
                isOpen('customDialogModal') || isOpen('editEmployeeModal') || isOpen('postImportModal') ||
                isOpen('configModal') || isOpen('operationsModal') || isOpen('importModal') ||
                isOpen('exportModal') || isOpen('historyModal') ||
                isOpen('sheetStudio') || isOpen('documentStudio')
            );

            if ((e.ctrlKey || e.metaKey) && !e.altKey) {
                const key = String(e.key || '').toLowerCase();
                if (key === 'z' || key === 'y') {
                    const target = e.target;
                    const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
                    const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!(target && target.isContentEditable);
                    if (!isEditable && !anyModalOpen()) {
                        if (key === 'z' && !e.shiftKey) {
                            if (undoStack.canUndo()) {
                                e.preventDefault();
                                undoAction();
                            }
                            return;
                        }
                        if ((key === 'y' && !e.shiftKey) || (key === 'z' && e.shiftKey)) {
                            if (undoStack.canRedo()) {
                                e.preventDefault();
                                redoAction();
                            }
                            return;
                        }
                    }
                }
            }

            if (e.key !== 'Escape') return;
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

        // Physical-count checklist & optional actual counts in Cuadre tab
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
                renderCuadre(SplitXCore.computeLedgerSummary(state.denominations, state.inventory, coverage.results, coverage.loanFundResult));
                cuadreBody.querySelector(`[data-cuadre-denom="${d}"]`)?.focus();
            });
            cuadreBody.addEventListener('input', (e) => {
                const input = e.target.closest('[data-cuadre-actual]');
                if (!input) return;
                const d = Number(input.dataset.cuadreActual);
                if (!Number.isFinite(d)) return;
                const sanitized = SplitXCuadre.sanitizeActualCountInput(input.value);
                if (sanitized.empty) {
                    cuadreActualCounts.delete(d);
                } else {
                    if (sanitized.normalizedText !== String(input.value || '').trim()) {
                        input.value = sanitized.normalizedText;
                    }
                    cuadreActualCounts.set(d, sanitized.qty);
                }
                const ledger = _lastRenderedLedger;
                if (ledger) {
                    const expQty = ledger.physicalLooseOnTable[d] || 0;
                    const hasAct = cuadreActualCounts.has(d);
                    const diff = hasAct ? (cuadreActualCounts.get(d) - expQty) : 0;
                    input.className = `w-12 px-1.5 py-0.5 text-center font-mono text-xs rounded border bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 outline-none focus:ring-1 focus:ring-blue-500 ${!hasAct
                        ? 'border-slate-200 dark:border-slate-700'
                        : diff === 0
                            ? 'border-emerald-400 text-emerald-700 dark:text-emerald-300 font-bold'
                            : diff < 0
                                ? 'border-rose-400 text-rose-700 dark:text-rose-300 font-bold'
                                : 'border-amber-400 text-amber-700 dark:text-amber-300 font-bold'
                        }`;
                    updateCuadreVarianceBanner(ledger);
                }
            });
        }

        // Declarative allowlisted action delegation (zero inline on* handlers -> strict CSP)
        if (typeof SplitXActionDelegation !== 'undefined') {
            SplitXActionDelegation.installActionDelegation(document, {
                openImportModal: () => openImportModal(),
                undoAction: () => undoAction(),
                redoAction: () => redoAction(),
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
                openCajaMobile: () => openCajaMobile(),
                openBankMobile: () => openBankMobile(),
                openCuadreView: () => openCuadreView(),
                clearCuadreChecks: () => clearCuadreChecks(),
                applyCuadreSwapToBox: () => applyCuadreSwapToBox(),
                applyBankToInventory: () => applyBankToInventory(),
                clearBankLimits: () => clearBankLimits(),
                addEmployee: () => addEmployee(),
                roundAllAmounts: () => roundAllAmounts(),
                cycleSortMode: () => cycleSortMode(),
                toggleCardNumberMode: () => toggleCardNumberMode(),
                setEmployeeSearch: (el) => setEmployeeSearch(el.value),
                clearEmployeeSearch: () => clearEmployeeSearch(),
                setEmployeeStatusFilter: (_el, _e, filter) => setEmployeeStatusFilter(filter),
                clearEmployeeFilters: () => clearEmployeeFilters(),
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
        openCajaMobile,
        openCuadreView,
        clearCuadreChecks,
        applyCuadreSwapToBox,
        undoAction,
        redoAction,
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
        setEmployeeSearch,
        clearEmployeeSearch,
        setEmployeeStatusFilter,
        clearEmployeeFilters,
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
