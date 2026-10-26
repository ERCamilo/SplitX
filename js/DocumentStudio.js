/**
 * Rich-text employee documents, local-only. DOCX imports use Mammoth as a lazy
 * browser dependency; sanitize all converted HTML before displaying/saving.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./SplitXDocuments.js'), require('./SplitXSheetFields.js'));
    else root.DocumentStudio = factory(root.SplitXDocuments, root.SplitXSheetFields);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (D, SF) {
    'use strict';
    const loadMammoth = () => new Promise((resolve, reject) => {
        if (window.mammoth && window.mammoth.convertToHtml) { resolve(window.mammoth); return; }
        const pending = document.querySelector('script[data-sxdoc-mammoth]');
        if (pending) {
            pending.addEventListener('load', () => resolve(window.mammoth), {once:true});
            pending.addEventListener('error', () => reject(Error('No se pudo cargar el conversor DOCX')), {once:true});
            return;
        }
        const script = document.createElement('script');
        script.setAttribute('data-sxdoc-mammoth', '');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.13.0/mammoth.browser.min.js';
        script.onload = () => window.mammoth ? resolve(window.mammoth) : reject(Error('Conversor DOCX no disponible'));
        script.onerror = () => reject(Error('No se pudo cargar el conversor DOCX. Comprueba la conexión.'));
        document.head.appendChild(script);
    });
    const createStudio = opts => {
        const rootEl = opts.root;
        const storage = opts.storage || {
            get: key => {try{return localStorage.getItem(key);}catch(_){return null;}},
            set: (key, value) => localStorage.setItem(key,value)
        };
        let state = D.defaultState(), employees = [], fieldSet = null, selectedIndex = 0;
        let bound = false, loaded = false, savedRange = null;
        const q = selector => rootEl.querySelector(selector);
        const current = () => state.templates.find(t => t.id === state.activeId) || state.templates[0];
        const selected = () => employees[selectedIndex] || null;
        const valueFor = emp => emp ? (state.people[D.personKey(emp)] || {}) : {};
        const status = (message, failure=false) => {
            const el = q('#sxdocStatus');
            if (el) {el.textContent=message;el.style.color=failure?'#b91c1c':'#0f766e';}
        };
        const save = () => {
            const clean = D.safeState(state);
            storage.set(D.KEY,JSON.stringify(clean));
            state = clean;
        };
        const load = () => {
            let obj = null;
            try {obj = JSON.parse(storage.get(D.KEY) || 'null');} catch (_) {}
            state = D.safeState(obj);
        };
        const sanitize = html => D.sanitize(html,document);
        const snapshot = () => {
            const editor = q('#sxdocEditor');
            if (editor && current()) current().html = sanitize(editor.innerHTML);
        };
        const setSelect = (el, items, value) => {
            if (!el) return;
            el.textContent = '';
            for (const item of items) el.add(new Option(item.label,item.value));
            if (value !== undefined) el.value = String(value);
        };
        const showActive = () => {
            setSelect(q('#sxdocTemplates'),state.templates.map(t => ({value:t.id,label:t.name})),state.activeId);
            q('#sxdocName').value=current().name;
            q('#sxdocEditor').innerHTML=sanitize(current().html);
            setSelect(q('#sxdocFields'),[
                ...fieldSet.fields.map(f => ({value:f.key,label:f.label})),
                {value:'today',label:'Fecha actual'},
                ...D.PERSON_FIELDS.map(f=>({value:f.key,label:f.label}))
            ]);
            setSelect(q('#sxdocEmployee'),employees.map((e,i)=>({
                value:String(i),label:(e.employeeNumber || String(i+1))+' · '+(e.employeeName||e.name||'Empleado')
            })),String(selectedIndex));
            for (const action of ['print-one','print-all']) {
                const button = q('[data-act="'+action+'"]');if(button)button.disabled=!employees.length;
            }
            savedRange=null;refreshPerson();preview();
        };
        const refreshPerson = () => {
            const data=valueFor(selected());
            for(const f of D.PERSON_FIELDS) {
                const input=q('#sxdocPerson_'+f.key);
                if(input){input.value=data[f.key]||'';input.disabled=!selected();}
            }
        };
        const resolved = (employee,index,html) => D.render(html||current().html,employee,fieldSet.fields,
            valueFor(employee), {resolveField:fieldSet.resolveField,index: index});
        const preview = () => {
            const el=q('#sxdocPreview'),warning=q('#sxdocMissing');
            if(!el)return;
            if(!selected()) {
                el.textContent='Importa o agrega empleados para previsualizar documentos personalizados.';
                warning.hidden=true;return;
            }
            const html=sanitize(q('#sxdocEditor').innerHTML);
            const result=resolved(selected(),selectedIndex,html);
            el.innerHTML=result.html;
            warning.hidden=!result.missing.length;
            warning.textContent=result.missing.length?
                'Faltan datos: '+result.missing.join(', ')+'. Complétalos antes de imprimir.':'';
        };
        const saveRange = () => {
            const selection=window.getSelection(),editor=q('#sxdocEditor');
            if(selection && selection.rangeCount && editor && editor.contains(selection.anchorNode))
                savedRange=selection.getRangeAt(0).cloneRange();
        };
        const restoreRange=()=>{
            const el=q('#sxdocEditor'),sel=window.getSelection();
            if(!el)return;el.focus();
            try{
                if(savedRange && el.contains(savedRange.commonAncestorContainer)) {
                    sel.removeAllRanges();sel.addRange(savedRange);return;
                }
            }catch(_){}
            const range=document.createRange();
            range.selectNodeContents(el);range.collapse(false);
            sel.removeAllRanges();sel.addRange(range);
        };
        const insertField=()=>{
            const key=q('#sxdocFields').value;
            if(!/^[A-Za-z_][A-Za-z0-9_:]*$/.test(key))return;
            restoreRange();
            document.execCommand('insertText',false,'{{'+key+'}}');
            saveRange();snapshot();preview();
        };
        const format=kind=>{
            const commands={
                bold:['bold'],italic:['italic'],underline:['underline'],
                h2:['formatBlock','h2'],p:['formatBlock','p'],
                ul:['insertUnorderedList'],ol:['insertOrderedList'],
                center:['justifyCenter'],left:['justifyLeft']
            };
            const item=commands[kind];if(!item)return;
            restoreRange();
            document.execCommand(item[0],false,item[1]||null);
            saveRange();snapshot();preview();
        };
        const changePerson = el => {
            const employee=selected(),key=el.dataset.person;
            if(!employee || !D.PERSON_FIELDS.some(f => f.key===key))return;
            const id=D.personKey(employee);
            const record=state.people[id] || {};
            record[key]=String(el.value||'').slice(0,300);
            state.people[id]=record;
            try{save();preview();}catch(e){status('No se pudo guardar: '+e.message,true);}
        };
        const addTemplate=duplicate=>{
            if(state.templates.length >= D.MAX_TEMPLATES) {
                status('Máximo de '+D.MAX_TEMPLATES+' plantillas.',true);return;
            }
            snapshot();
            const id='doc_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);
            const item={id,name:duplicate?current().name+' (copia)':'Nuevo documento',
                html:duplicate?current().html:'<h2>Nuevo documento</h2><p>Escribe aquí e inserta campos del empleado.</p>'};
            state.templates.push(item);state.activeId=id;
            try{save();showActive();}catch(e){status('No se pudo guardar: '+e.message,true);}
        };
        const deleteTemplate=()=>{
            if(state.templates.length<=1){status('Conserva al menos una plantilla.',true);return;}
            if(!window.confirm('¿Eliminar esta plantilla?'))return;
            state.templates=state.templates.filter(t=>t.id!==state.activeId);
            state.activeId=state.templates[0].id;
            try{save();showActive();}catch(e){status('No se pudo guardar: '+e.message,true);}
        };
        const importFile=async file=>{
            if(!file)return;
            if(file.size>5*1024*1024){status('El archivo supera 5 MB.',true);return;}
            try{
                let html, warnings=0;
                if(file.name.toLowerCase().endsWith('.txt')){
                    html=(await file.text()).split(/\r?\n/).map(line=>'<p>'+D.escape(line||' ')+'</p>').join('');
                }else if(file.name.toLowerCase().endsWith('.docx')){
                    const mammoth=await loadMammoth();
                    const result=await mammoth.convertToHtml({arrayBuffer:await file.arrayBuffer()});
                    html=result.value;warnings=result.messages?.length||0;
                }else throw Error('Formato no admitido; utiliza .docx o .txt.');
                if(!html || !html.trim())throw Error('El documento no contiene texto legible.');
                const content=sanitize(html);
                if(content.length>D.MAX_HTML)throw Error('El contenido supera el límite de tamaño.');
                q('#sxdocEditor').innerHTML=content;
                snapshot();save();preview();
                status('Importado. Revisa títulos, tablas y campos.'+(warnings?' Advertencias de Word: '+warnings:''));
            }catch(e){status('No se pudo importar: '+e.message,true);}
            q('#sxdocFile').value='';
        };
        const print=all=>{
            if(!employees.length){status('Primero agrega o importa empleados.',true);return;}
            snapshot();
            const html=sanitize(current().html);
            const records=all?employees.map((e,i)=>({e,i})):[{e:selected(),i:selectedIndex}];
            const pages=records.map(({e,i})=>resolved(e,i,html));
            const errors=pages.filter(x=>x.missing.length);
            if(errors.length){
                status('Impresión bloqueada: faltan datos de '+errors.length+' empleado(s). Completa los campos marcados.',true);
                return;
            }
            const popup=window.open('','_blank');
            if(!popup){status('El navegador bloqueó la ventana de impresión.',true);return;}
            popup.opener=null;
            const sheets=pages.map(p=>'<section>'+p.html+'</section>').join('');
            const heading='<!doctype html><html lang="es"><head><meta charset="utf-8"><title>'+D.escape(current().name)+'</title>';
            const style='<style>@page{size:A4;margin:18mm}body{font:12pt/1.55 Arial,sans-serif;color:#111}section{page-break-after:always;break-after:page;overflow-wrap:anywhere}section:last-child{page-break-after:auto;break-after:auto}p{margin:10px 0}table{border-collapse:collapse;width:100%}td,th{border:1px solid #777;padding:5px}</style>';
            popup.document.open();popup.document.write(heading+style+'</head><body>'+sheets+'</body></html>');popup.document.close();
            popup.focus();
            popup.addEventListener('load',()=>popup.print(),{once:true});
            status('Preparados '+pages.length+' documentos. Usa «Guardar como PDF» o imprime.');
        };
        const onClick = e=>{
            const button=e.target.closest('[data-act],[data-format]');if(!button)return;
            if(button.dataset.format){format(button.dataset.format);return;}
            const action=button.dataset.act;
            if(action==='close'){snapshot();try{save();}catch(err){status(err.message,true);}api.close();}
            else if(action==='save'){
                snapshot();current().name=q('#sxdocName').value.trim().slice(0,100)||current().name;
                try{save();showActive();status('Plantilla guardada en este navegador.');}
                catch(err){status('No se pudo guardar: '+err.message,true);}
            }
            else if(action==='field')insertField();
            else if(action==='new')addTemplate(false);
            else if(action==='duplicate')addTemplate(true);
            else if(action==='delete')deleteTemplate();
            else if(action==='print-one')print(false);
            else if(action==='print-all')print(true);
        };
        const onChange = e=>{
            const el=e.target;
            if(el.id==='sxdocTemplates'){
                snapshot();state.activeId=el.value;
                try{save();showActive();}catch(err){status(err.message,true);}
            }else if(el.id==='sxdocEmployee'){
                selectedIndex=Number(el.value);refreshPerson();preview();
            }else if(el.id==='sxdocFile')void importFile(el.files?.[0]);
            else if(el.dataset.person)changePerson(el);
        };
        const onInput = e=>{
            const el=e.target;
            if(el.id==='sxdocEditor'){snapshot();preview();}
            else if(el.dataset.person)changePerson(el);
        };
        const paste = e=>{
            if(!e.target.closest('#sxdocEditor'))return;
            const rich=e.clipboardData?.getData('text/html');
            if(!rich)return;
            e.preventDefault();
            restoreRange();
            document.execCommand('insertHTML',false,sanitize(rich));
            snapshot();preview();
        };
        const bindEvents=()=>{
            if(bound)return;bound=true;
            rootEl.addEventListener('click',onClick);
            rootEl.addEventListener('change',onChange);
            rootEl.addEventListener('input',onInput);
            rootEl.addEventListener('paste',paste);
            rootEl.addEventListener('mouseup',e=>{if(e.target.closest('#sxdocEditor'))saveRange();});
            rootEl.addEventListener('keyup',e=>{if(e.target.closest('#sxdocEditor'))saveRange();});
        };
        const api={
            open:async()=>{
                if(!loaded){
                    const response=await fetch('document-studio.html');
                    if(!response.ok)throw Error('No se pudo cargar el editor de documentos.');
                    rootEl.innerHTML=await response.text();loaded=true;
                }
                load();employees=opts.getEmployees()||[];
                fieldSet=SF.createFieldSet({records:employees,getNetAmount:opts.getNetAmount});
                selectedIndex=0;
                rootEl.classList.add('sxdoc');rootEl.hidden=false;
                document.body.style.overflow='hidden';
                bindEvents();showActive();q('#sxdocTemplates').focus();
            },
            close:()=>{
                rootEl.hidden=true;
                document.body.style.overflow='';
            }
        };
        return api;
    };
    return {createStudio};
});
