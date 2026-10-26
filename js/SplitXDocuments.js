/**
 * Document templates for SplitX. Pure formatting and employee data resolution;
 * no external requests and no modification of payroll or SA records.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SplitXDocuments = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const KEY = 'Split_documents_v1';
    const MAX_TEMPLATES = 20;
    const MAX_HTML = 150000;
    const PERSON_FIELDS = [
        { key: 'idNumber', label: 'Cédula / documento de identidad', type: 'text' },
        { key: 'startDate', label: 'Fecha de ingreso', type: 'date' },
        { key: 'monthlySalary', label: 'Sueldo mensual contractual', type: 'money' },
        { key: 'address', label: 'Dirección', type: 'text' }
    ];
    const escape = value => String(value ?? '').replace(/[&<>"']/g,
        c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\u0027':'&#39;'}[c]));
    const example = () => ({
        id: 'carta-ingreso', name: 'Carta de ingreso',
        html: '<h2 style="text-align:center">CONSTANCIA DE INGRESO</h2>' +
            '<p>Fecha: {{today}}</p>' +
            '<p>Por medio de la presente, <strong>{{company}}</strong> deja constancia de ' +
            'que <strong>{{name}}</strong>, portador(a) del documento de identidad ' +
            '<strong>{{idNumber}}</strong>, ingresa a prestar servicios en el puesto de ' +
            '<strong>{{position}}</strong>, dentro del proyecto <strong>{{project}}</strong>, ' +
            'a partir del día <strong>{{startDate}}</strong>.</p>' +
            '<p>La remuneración mensual acordada es de <strong>{{monthlySalary}}</strong>.</p>' +
            '<p>Este documento es un modelo editable. Se deben revisar y confirmar todos los datos ' +
            'y las condiciones laborales aplicables antes de firmarlo.</p>' +
            '<p style="margin-top:50px">__________________________________</p>' +
            '<p>Firma autorizada</p>'
    });
    const defaultState = () => ({ version: 1, activeId: 'carta-ingreso', templates: [example()], people: {} });
    const validKey = key => /^[A-Za-z_][A-Za-z0-9_:]*$/.test(key);
    const placeholders = html => {
        const values = new Set(), re = /\{\{\s*([A-Za-z_][A-Za-z0-9_:]*)\s*\}\}/g;
        for (const match of String(html || '').matchAll(re)) values.add(match[1]);
        return [...values];
    };
    const safeState = input => {
        const state = defaultState();
        if (!input || typeof input !== 'object') return state;
        const list = Array.isArray(input.templates) ? input.templates : [];
        const seen = new Set();
        const accepted = [];
        for (const template of list.slice(0, MAX_TEMPLATES)) {
            if (!template || typeof template.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(template.id) ||
                typeof template.name !== 'string' || typeof template.html !== 'string' ||
                !template.name.trim() || template.name.length > 100 ||
                template.html.length > MAX_HTML || seen.has(template.id)) continue;
            seen.add(template.id);
            accepted.push({id:template.id,name:template.name,html:template.html});
        }
        if (accepted.length) state.templates = accepted;
        state.activeId = state.templates.some(t=>t.id===input.activeId) ? input.activeId : state.templates[0].id;
        if (input.people && typeof input.people === 'object' && !Array.isArray(input.people)) {
            const people = {};
            for (const [employeeKey,values] of Object.entries(input.people).slice(0,3000)) {
                if (!/^[A-Za-z0-9:_-]{1,100}$/.test(employeeKey) ||
                    !values || typeof values !== 'object' || Array.isArray(values)) continue;
                people[employeeKey] = {};
                for (const {key} of PERSON_FIELDS) {
                    const raw = values[key];
                    if (typeof raw === 'string' && raw.length <= 300) people[employeeKey][key] = raw;
                }
            }
            state.people = people;
        }
        return state;
    };
    const personKey = employee =>
        employee?.sourceEmployeeId ? 'source:'+String(employee.sourceEmployeeId) :
        employee?.employeeNumber ? 'no:'+String(employee.employeeNumber) :
        employee?.id !== undefined ? 'id:'+String(employee.id) : null;

    const numberMoney = (value, currency='DOP') => {
        const n = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(n)) return '';
        try { return new Intl.NumberFormat('es-DO', {style:'currency',currency,minimumFractionDigits:2}).format(n); }
        catch (_) { return n.toLocaleString('es-DO',{minimumFractionDigits:2,maximumFractionDigits:2})+' '+currency; }
    };
    const dateString = raw => {
        const value=String(raw||'').trim();
        const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (!m) return value;
        const d=new Date(Number(m[1]),Number(m[2])-1,Number(m[3]));
        if (d.getFullYear()!==Number(m[1])||d.getMonth()!==Number(m[2])-1||d.getDate()!==Number(m[3]))return value;
        return new Intl.DateTimeFormat('es-DO',{day:'2-digit',month:'long',year:'numeric'}).format(d);
    };
    /**
     * @param {string} html Sanitized template HTML containing {{placeholder}} values
     * @param {object} employee One imported SplitX employee
     * @param {Array<{key:string,label:string,type:string,get:function}>} fields
     * @param {object} values User-authored values for the specific employee
     * @param {object} config
     */
    const render = (html, employee, fields, values={}, config={}) => {
        const missing = new Set(), fieldByKey = new Map((fields||[]).map(f=>[f.key,f]));
        const currency = employee?.exportContext?.currency || 'DOP';
        const now = config.today || new Date().toISOString().slice(0,10);
        const output = String(html||'').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_:]*)\s*\}\}/g, (_,key) => {
            let raw, type='text', label=key;
            const local = PERSON_FIELDS.find(f=>f.key===key);
            if (key === 'today') { raw=now;type='date';label='Fecha actual'; }
            else if (local) { raw=values[key];type=local.type;label=local.label; }
            else {
                const f=fieldByKey.get(key)||config.resolveField?.(key);
                if (f) {
                    type=f.type;
                    label=f.label;
                    try {raw=f.get(employee,{index:config.index||0});}catch (_) {raw=undefined;}
                }
            }
            if (raw===null || raw===undefined || (typeof raw==='string'&&!raw.trim()) ||
                (key==='monthlySalary' && (!Number.isFinite(Number(raw)) || Number(raw)<=0))) {
                missing.add(key);
                return '<span class="sxdoc-missing" data-missing="'+escape(key)+'">[FALTA: '+escape(label)+']</span>';
            }
            if (type==='money' || type==='number') {
                if (typeof raw==='string' && !raw.trim()) {missing.add(key);return '[FALTA: '+escape(label)+']';}
                const money=numberMoney(raw,currency);
                if (!money) {missing.add(key);return '[FALTA: '+escape(label)+']';}
                return escape(money);
            }
            if (type==='date')return escape(dateString(raw));
            return escape(raw);
        });
        return {html:output,missing:[...missing]};
    };
    // Imported Word documents are not trusted HTML. Strip scripts, URLs,
    // foreign nodes, inline events, images and unapproved CSS before editing.
    const sanitize = (html, documentObject) => {
        if (!documentObject || !documentObject.createElement) throw new Error('Se requiere un documento del navegador.');
        const outer=documentObject.createElement('div');
        outer.innerHTML=String(html||'').slice(0,MAX_HTML);
        const allowed = new Set(['P','DIV','BR','H1','H2','H3','H4','B','STRONG','I','EM','U','S','UL','OL','LI','BLOCKQUOTE','SPAN','TABLE','THEAD','TBODY','TR','TH','TD','HR']);
        const blocked = new Set(['SCRIPT','STYLE','IFRAME','SVG','MATH','OBJECT','EMBED','FORM','INPUT','BUTTON','LINK','META','IMG','VIDEO','AUDIO']);
        const cleanNodes = parent => {
            for (const node of [...parent.childNodes]) {
                if (node.nodeType===8) {node.remove();continue;}
                if (node.nodeType!==1) {if(node.nodeType!==3)node.remove();continue;}
                const tag=node.tagName.toUpperCase();
                if (blocked.has(tag)) {node.remove();continue;}
                cleanNodes(node);
                if (!allowed.has(tag)) {
                    const frag=documentObject.createDocumentFragment();
                    while(node.firstChild)frag.appendChild(node.firstChild);
                    node.replaceWith(frag);continue;
                }
                const align=(node.style?.textAlign||'').toLowerCase();
                const originalAlign=align==='center'||align==='right'||align==='left'||align==='justify'?align:null;
                const colSpan=(tag==='TD'||tag==='TH')?Math.min(10,Math.max(1,Number(node.getAttribute('colspan'))||1)):1;
                for(const attr of [...node.attributes])node.removeAttribute(attr.name);
                if(originalAlign)node.style.textAlign=originalAlign;
                if(colSpan>1)node.setAttribute('colspan',String(colSpan));
            }
        };
        cleanNodes(outer);
        return outer.innerHTML;
    };
    return {KEY,MAX_HTML,MAX_TEMPLATES,PERSON_FIELDS,defaultState,safeState,personKey,
        placeholders,render,sanitize,escape,numberMoney,dateString};
});
