/**
 * Visual adapter for reusable print-only formulas. The existing SplitXVariables
 * parser remains the single evaluator; the UI only edits SheetBuilder chips.
 */
(function(root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./SplitXVariables.js'));
    else root.SplitXFormulaBuilder = factory(root.SplitXVariables);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(CV) {
    'use strict';
    const html = v => String(v == null ? '' : v).replace(/[&<>"']/g,
        c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const clone = x => JSON.parse(JSON.stringify(x));
    const F = key => ({kind:'field',key});
    const O = op => ({kind:'op',op});
    const P = paren => ({kind:'paren',paren});
    const OPS = [['+','+'],['−','-'],['×','*'],['÷','/'],['(', '('],[')', ')']];
    const makeOp = op => op === '(' || op === ')' ? P(op) : O(op);
    const opSymbol = op => ({'*':'×','/':'÷','-':'−'}[op] || op);

    const mount = ({host, fields, variables, employees, existing, seed, savePreview}) => {
        const q = s => host.querySelector(s);
        const formula = q('#ssVarFormula');
        const kind = q('#ssVarKind');
        const formLabel = formula.closest('label');
        const msg = q('#ssVarsMsg');
        const available = fields.filter(f=>f.type==='number' || f.key.startsWith('custom:'));
        const byKey = new Map(fields.map(f=>[f.key,f.label]));
        const catalog = {fields,variables,resolveField:savePreview.resolveField};
        let chips = [];
        let mode = 'visual';
        let dragged = null;
        let selectedIndex = -1;
        let editingNumberIndex = -1;
        const initial = existing?.kind === 'formula' ? existing.formula : '';
        if (seed?.length) {
            chips = clone(seed);
            kind.value = 'formula';
        } else if (initial) {
            try { chips = CV.formulaToChips(initial,catalog); }
            catch (_) { mode='text'; }
        }
        const markup = '<div id="ssVarBuilder" style="display:none;margin-top:10px;min-width:0;max-width:100%">' +
          '<div role="group" aria-label="Modo de edición" style="display:flex;gap:6px;margin:6px 0">' +
          '<button type="button" class="ss-btn sm" id="ssVarModeVisual">Chips · visual</button>' +
          '<button type="button" class="ss-btn sm" id="ssVarModeText">Texto avanzado</button></div>' +
          '<div id="ssVarVisualArea"><div id="ssVarFormulaCanvas" role="list" aria-label="Fórmula visual, arrastra o toca los chips" tabindex="0" '+
            'style="display:flex;min-height:48px;align-items:center;flex-wrap:wrap;gap:6px;padding:10px 8px;border:1px dashed var(--border-strong,#888);border-radius:10px;max-width:100%;overflow:auto"></div>' +
          '<p class="ss-hint" style="margin:6px 0">Escribe números, ( ), /, *, −, + y % directamente en la fórmula. # agrega un número editable. Arrastra hasta la línea azul para reordenar.</p>' +
          '<div id="ssVarBuilderPalette" role="group" aria-label="Campos y operadores para la fórmula" '+
            'style="max-height:180px;overflow:auto;display:flex;flex-wrap:wrap;gap:6px;margin-top:9px"></div>' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:9px 0">' +
            '<label>Valor <input type="number" class="ss-inp" id="ssVarNumberValue" step="any" style="width:105px" value="0"></label>' +
            '<label class="ss-check"><input type="checkbox" id="ssVarNumberPercent"> %</label>' +
            '<button type="button" class="ss-btn sm" id="ssVarInsertNumber">Agregar número</button></div></div>' +
          '<div id="ssVarFormulaSuggestions" style="display:none;max-height:130px;overflow:auto"></div>' +
          '<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
            '<label>Empleado de ejemplo <select class="ss-inp" id="ssVarPreviewEmployee"></select></label>' +
            '<output id="ssVarPreviewValue" aria-live="polite"></output></div></div>';
        formLabel.insertAdjacentHTML('beforebegin',markup);
        const box = q('#ssVarBuilder');
        const openedAt = Date.now();
        const area = q('#ssVarVisualArea');
        const canvas=q('#ssVarFormulaCanvas'),palette=q('#ssVarBuilderPalette');
        const preview=q('#ssVarPreviewValue'), selector=q('#ssVarPreviewEmployee');
        const labelOf = ch => ch.kind==='field' ? byKey.get(ch.key) || ch.key :
            ch.kind==='op' ? opSymbol(ch.op) : ch.kind==='paren' ? ch.paren :
            ch.kind==='number' ? String(ch.value)+(ch.percent?'%':'') : '?';
        // Selected token keeps a small, explicit delete control. The input
        // stays at the end of the formula so typing can create chips directly.
        const renderTokens = () => {
            const oldInput=canvas.querySelector('#ssVarInlineInput');
            const oldValue=oldInput?.value || '';
            const active=document.activeElement===oldInput;
            const cursor=active ? oldInput.selectionStart : null;
            canvas.innerHTML = chips.map((ch,i)=>
              '<span draggable="true" role="listitem" class="ss-chip '+(ch.kind==='field'?'k-field':ch.kind==='op'?'k-op':'k-number')+
              '" data-formula-token="'+i+'" tabindex="0" aria-selected="'+(selectedIndex===i)+'" title="Selecciona para eliminar o arrastra para ordenar" '+
              'style="display:inline-flex;position:relative;align-items:center;min-height:27px;'+(selectedIndex===i?'outline:2px solid #2563eb;outline-offset:2px;':'')+'">'+
              html(labelOf(ch))+
              (selectedIndex===i?'<button type="button" data-remove-token="'+i+'" aria-label="Eliminar '+html(labelOf(ch))+
              '" title="Eliminar chip" style="position:absolute;top:-10px;right:-10px;width:19px;height:19px;border-radius:50%;background:#dc2626;color:white;border:2px solid white;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1;cursor:pointer;z-index:2">×</button>':'')+
              '</span>').join('')+
              '<input id="ssVarInlineInput" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="Escribe números u operadores para crear chips" placeholder="'+(chips.length?'5, +, −, *, /, %, #':'Escribe 5, +, -, (, %, #')+
              '" style="min-width:118px;flex:1 1 118px;max-width:100%;border:0;outline:0;background:transparent;color:inherit;min-height:28px;font:inherit;padding:3px">';
            const input=canvas.querySelector('#ssVarInlineInput');
            input.value=oldValue;
            if(active){
                input.focus();
                if(cursor!==null)input.setSelectionRange(Math.min(cursor,input.value.length),Math.min(cursor,input.value.length));
            }
        };
        const renderPalette = () => {
            const fieldHTML=available.map(f=>'<button type="button" class="ss-chip k-field" draggable="true" data-chip-key="'+html(f.key)+'">'+html(f.label)+'</button>').join('');
            const ops=OPS.map(pair=>'<button type="button" class="ss-chip k-op" draggable="true" data-chip-op="'+html(pair[1])+'">'+html(pair[0])+'</button>').join('');
            palette.innerHTML=fieldHTML+ops;
        };
        renderPalette();
        selector.innerHTML=employees.map((e,i)=>{
            const key=e.employeeNumber!=null?String(e.employeeNumber):'id:'+e.id;
            return '<option value="'+html(key)+'">'+html((e.employeeNumber||i+1)+' · '+e.name)+'</option>';
        }).join('');
        const textFormula = () => mode==='text' ? formula.value : CV.chipsToFormula(chips);
        const previewValue = () => {
            if (kind.value!=='formula') return;
            try {
                const expression=textFormula();
                const id=existing?.id || 'vistaprevia';
                const next={id,label:'Vista previa',kind:'formula',formula:expression};
                const definitions=[...variables.filter(v=>v.id!==id),next];
                const own=savePreview.createFieldSet(definitions);
                const key=selector.value;
                const row=employees.find(e=>String(e.employeeNumber??('id:'+e.id))===key);
                const field=own.fields.find(f=>f.key==='custom:'+id);
                if (!row || !field) { preview.textContent='Sin empleado';return; }
                const number=field.get(row,{index:employees.indexOf(row)});
                preview.textContent=Number(number).toLocaleString('es-DO',{maximumFractionDigits:2});
            } catch(err) { preview.textContent='Vista previa: '+err.message; }
        };
        const renderMode = () => {
            const active=kind.value==='formula';
            box.style.display=active?'block':'none';
            formLabel.style.display=active && mode==='text'?'block':'none';
            area.style.display=mode==='visual'?'block':'none';
            q('#ssVarModeVisual').setAttribute('aria-pressed',String(mode==='visual'));
            q('#ssVarModeText').setAttribute('aria-pressed',String(mode==='text'));
            renderTokens();previewValue();
        };
        const showError = err => {msg.textContent=err.message || String(err);};
        const switchMode = next => {
            try {
                if (next==='visual' && mode==='text') chips=formula.value.trim()?CV.formulaToChips(formula.value,catalog):[];
                if (next==='text' && mode==='visual') formula.value=chips.length?CV.chipsToFormula(chips):'';
                mode=next;msg.textContent='';renderMode();
            } catch(err) {showError(err);}
        };
        const add = item => {
            chips.push(clone(item));
            selectedIndex=-1;editingNumberIndex=-1;
            msg.textContent='';renderTokens();previewValue();
        };
        const removeToken = i => {
            if(i<0||i>=chips.length)return;
            chips.splice(i,1);selectedIndex=-1;editingNumberIndex=-1;
            renderTokens();previewValue();
        };
        q('#ssVarModeVisual').addEventListener('click',()=>switchMode('visual'));
        // A touch on the opener can generate a delayed click on the newly
        // mounted dialog (click-through). Only pointer clicks that actually
        // began on this button may switch to advanced mode. Keyboard click
        // events (detail=0) remain accessible.
        const textModeButton=q('#ssVarModeText');
        let textPointerDown=false;
        textModeButton.addEventListener('pointerdown',()=>{textPointerDown=true;});
        textModeButton.addEventListener('pointercancel',()=>{textPointerDown=false;});
        textModeButton.addEventListener('click',e=>{
            // Some touch browsers retarget a 50ms synthesized gesture after
            // the opener creates this modal. Ignore that immediate event.
            const touchGhost=e.detail>0 && navigator.maxTouchPoints>0 && Date.now()-openedAt<220;
            const intentional=!touchGhost && (!e.detail || textPointerDown);
            textPointerDown=false;
            if(intentional) switchMode('text');
        });
        kind.addEventListener('change',()=>{
            if (kind.value==='formula' && !existing && !seed) mode='visual';
            else if (kind.value==='formula'&&!chips.length&&formula.value.trim()) {
                try { chips=CV.formulaToChips(formula.value,catalog); }
                catch(_) { mode='text'; }
            }
            renderMode();
        });
        palette.addEventListener('click',e=>{
            const el=e.target.closest('[data-chip-key],[data-chip-op]');if(!el) return;
            add(el.dataset.chipKey?F(el.dataset.chipKey):makeOp(el.dataset.chipOp));
        });
        q('#ssVarInsertNumber').addEventListener('click',()=>{
            const value=q('#ssVarNumberValue').value;
            if(value===''||!Number.isFinite(Number(value))||Number(value)<0)
                return showError(new Error('Número inválido.'));
            add({kind:'number',value:Number(value),...(q('#ssVarNumberPercent').checked?{percent:true}:{})});
        });
        // Destination is an insertion *slot* from 0..length. Moving a token
        // forward must account for its removal before inserting it again.
        const move=(from,slot)=>{
            if(from<0||from>=chips.length)return;
            const to=Math.max(0,Math.min(chips.length,slot))-(from<slot?1:0);
            if(from===to)return;
            const [item]=chips.splice(from,1);chips.splice(to,0,item);
            selectedIndex=to;editingNumberIndex=-1;
            renderTokens();previewValue();
        };
        canvas.addEventListener('click',e=>{
            const deleteButton=e.target.closest('[data-remove-token]');
            if(deleteButton){e.stopPropagation();removeToken(Number(deleteButton.dataset.removeToken));return;}
            const el=e.target.closest('[data-formula-token]');
            if(el){
                selectedIndex=Number(el.dataset.formulaToken);
                editingNumberIndex=-1;
                renderTokens();
                canvas.querySelector('[data-formula-token="'+selectedIndex+'"]')?.focus();
            } else if(e.target===canvas)canvas.querySelector('#ssVarInlineInput')?.focus();
        });
        canvas.addEventListener('keydown',e=>{
            const el=e.target.closest('[data-formula-token]');
            if(el){
                const index=Number(el.dataset.formulaToken);
                if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();removeToken(index);}
                if(e.altKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){
                    e.preventDefault();
                    move(index,index+(e.key==='ArrowLeft'?-1:2));
                    canvas.querySelector('[data-formula-token="'+selectedIndex+'"]')?.focus();
                }
                return;
            }
            if(e.target.id!=='ssVarInlineInput'||e.ctrlKey||e.metaKey||e.altKey)return;
            const input=e.target;
            const operators={'+':'+','-':'-','*':'*','/':'/','×':'*','÷':'/','(':'(',')':')'};
            if(Object.prototype.hasOwnProperty.call(operators,e.key)){
                e.preventDefault();
                input.value='';editingNumberIndex=-1;
                add(makeOp(operators[e.key]));
                canvas.querySelector('#ssVarInlineInput')?.focus();
            } else if(e.key==='%'){
                e.preventDefault();
                const target=editingNumberIndex>=0?editingNumberIndex:
                    chips.length-1;
                if(chips[target]?.kind==='number'){
                    chips[target].percent=true;
                    input.value='';editingNumberIndex=-1;
                    selectedIndex=target;
                    renderTokens();previewValue();
                }else showError(new Error('Escribe un número antes de %.'));
                canvas.querySelector('#ssVarInlineInput')?.focus();
            }else if(e.key==='#'){
                e.preventDefault();
                input.value='';
                add({kind:'number',value:0});
                editingNumberIndex=chips.length-1;
                selectedIndex=editingNumberIndex;
                renderTokens();previewValue();
                canvas.querySelector('#ssVarInlineInput')?.focus();
            }else if(e.key==='Enter'||e.key===' '){
                e.preventDefault();input.value='';editingNumberIndex=-1;
                renderTokens();previewValue();
                canvas.querySelector('#ssVarInlineInput')?.focus();
            }else if(e.key==='Backspace'&&!input.value){
                e.preventDefault();
                removeToken(chips.length-1);
                canvas.querySelector('#ssVarInlineInput')?.focus();
            }
        });
        canvas.addEventListener('input',e=>{
            if(e.target.id!=='ssVarInlineInput')return;
            const value=e.target.value.trim();
            if(!value)return;
            if(!/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value)){
                showError(new Error('Escribe un número; los operadores se convierten en chips.'));
                return;
            }
            const number=Number(value.replace(',','.'));
            if(!Number.isFinite(number)||number<0)return;
            if(editingNumberIndex<0||!chips[editingNumberIndex]||chips[editingNumberIndex].kind!=='number'){
                editingNumberIndex=chips.length;
                chips.push({kind:'number',value:number});
            }else chips[editingNumberIndex].value=number;
            selectedIndex=editingNumberIndex;
            msg.textContent='';renderTokens();previewValue();
        });
        // Re-rendering tokens replaces the inline input during a keystroke.
        // A focusout listener here would wrongly end the number being typed,
        // creating separate chips for 1, 12 and 12.5. Terminate the number
        // only when an explicit operator/action is inserted instead.
        const fromDom = el => el?.dataset?.chipKey ? F(el.dataset.chipKey) :
            el?.dataset?.chipOp ? makeOp(el.dataset.chipOp) : null;
        const removeGuide=()=>canvas.querySelector('#ssVarDropMarker')?.remove();
        const insertionSlot=e=>{
            const tokens=Array.from(canvas.querySelectorAll('[data-formula-token]'));
            for(let i=0;i<tokens.length;i++){
                const rect=tokens[i].getBoundingClientRect();
                if(e.clientY<rect.top+rect.height/2 ||
                    (e.clientY<=rect.bottom && e.clientX<rect.left+rect.width/2))return i;
            }
            return tokens.length;
        };
        const showGuide=slot=>{
            removeGuide();
            const guide=document.createElement('span');
            guide.id='ssVarDropMarker';
            guide.setAttribute('aria-hidden','true');
            guide.title='Se colocará aquí';
            guide.style.cssText='display:inline-block;flex:0 0 3px;width:3px;height:30px;border-radius:3px;background:#2563eb;box-shadow:0 0 0 2px #dbeafe;pointer-events:none;align-self:center';
            const tokens=canvas.querySelectorAll('[data-formula-token]');
            canvas.insertBefore(guide,tokens[slot]||canvas.querySelector('#ssVarInlineInput'));
        };
        const dragStart=e=>{
            const token=e.target.closest('[data-formula-token]');
            if(token)dragged={src:'token',index:Number(token.dataset.formulaToken)};
            else{
                const item=fromDom(e.target.closest('[data-chip-key],[data-chip-op]'));
                if(item)dragged={src:'palette',item};
            }
            if(dragged){e.dataTransfer.effectAllowed='copyMove';e.dataTransfer.setData('text/plain','splitx-formula');}
        };
        palette.addEventListener('dragstart',dragStart);
        canvas.addEventListener('dragstart',dragStart);
        canvas.addEventListener('dragover',e=>{
            if(!dragged)return;
            e.preventDefault();
            e.dataTransfer.dropEffect=dragged.src==='palette'?'copy':'move';
            const slot=insertionSlot(e);
            dragged.slot=slot;
            if(canvas.querySelector('#ssVarDropMarker')?.dataset.slot!==String(slot)){
                showGuide(slot);
                canvas.querySelector('#ssVarDropMarker').dataset.slot=String(slot);
            }
        });
        canvas.addEventListener('drop',e=>{
            if(!dragged)return;
            e.preventDefault();e.stopPropagation();
            const slot=dragged.slot??insertionSlot(e);
            removeGuide();
            if(dragged.src==='palette'){
                chips.splice(slot,0,clone(dragged.item));
                selectedIndex=slot;editingNumberIndex=-1;
                renderTokens();previewValue();
            }else move(dragged.index,slot);
            dragged=null;
        });
        const endDrag=()=>{removeGuide();dragged=null;};
        canvas.addEventListener('dragend',endDrag);
        palette.addEventListener('dragend',endDrag);
        canvas.addEventListener('dragleave',e=>{
            if(!canvas.contains(e.relatedTarget))removeGuide();
        });
        selector.addEventListener('change',previewValue);
        formula.addEventListener('input',()=>{
            previewValue();
            const val=formula.value, match=/[a-z_][a-z0-9_:]*$/i.exec(val);
            const dest=q('#ssVarFormulaSuggestions');
            const options=match?available.filter(f=>f.key.toLowerCase().includes(match[0].toLowerCase())||
                f.label.toLowerCase().includes(match[0].toLowerCase())).slice(0,8):[];
            dest.style.display=mode==='text'&&options.length?'block':'none';
            dest.innerHTML=options.map(f=>'<button type="button" class="ss-btn sm" data-chip-key="'+html(f.key)+'">'+html(f.label)+'</button>').join('');
        });
        q('#ssVarFormulaSuggestions').addEventListener('click',e=>{
            const btn=e.target.closest('[data-chip-key]');if(!btn)return;
            const match=/[a-z_][a-z0-9_:]*$/i.exec(formula.value);
            formula.value=(match?formula.value.slice(0,match.index):formula.value)+
                btn.dataset.chipKey.replace(/^custom:/,'');
            q('#ssVarFormulaSuggestions').style.display='none';previewValue();
        });
        renderMode();
        return {
            getFormula:()=>textFormula(),
            setChips:list=>{chips=clone(list);mode='visual';renderMode();},
            getChips:()=>clone(chips)
        };
    };
    return {mount};
});
