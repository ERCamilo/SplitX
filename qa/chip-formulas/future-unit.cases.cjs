/**
 * RED contract: code needed to turn current SheetBuilder chips into reusable
 * variables. These tests are intentionally failing on current main.
 * Run separately: node --test qa/chip-formulas/future-unit.cases.cjs
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const CV = require('../../js/SplitXVariables.js');
const SF = require('../../js/SplitXSheetFields.js');
const SB = require('../../js/SheetBuilder.js');
const sample = (n, gross) => ({
    id: n, employeeNumber: String(n).padStart(3,'0'), name:'Empleado '+n,
    amount:gross-100, payroll:{gross,discounts:100},
    bonusDetails:[{id:'asistencia',concept:'Bono de asistencia',amount:75}]
});
const base=SF.createFieldSet({records:[sample(1,10000),sample(2,10250)]});
const vars=[
    {id:'transporte',label:'Transporte',kind:'fixed',value:250,overrides:{'001':400}},
    {id:'pago_extra',label:'Pago extra',kind:'formula',formula:'gross * 5% + transporte'}
];
const catalog={fields:base.fields,resolveField:base.resolveField,variables:vars};
const F=key=>({kind:'field',key});
const O=op=>({kind:'op',op});
const N=(value,percent=false)=>({kind:'number',value,percent});
const P=paren=>({kind:'paren',paren});
const need=(name)=> {
    assert.equal(typeof CV[name], 'function',
        'PENDIENTE: SplitXVariables.'+name+' debe reutilizar chips de SheetBuilder');
    return CV[name];
};
const engineValue=(formula,record) => {
    const valueDefs=[...vars,{id:'evaluacion',label:'Evaluación',kind:'formula',formula}];
    const custom=CV.createFieldSet(valueDefs,base,SB);
    const field=custom.fields.find(v=>v.key==='custom:evaluacion');
    return field.get(record,{index:Number(record.employeeNumber)-1});
};

test('C02: chips de campos y porcentajes se convierten a una expresión reutilizable',()=>{
    const chips=[F('gross'),O('*'),N(5,true),O('+'),F('custom:transporte')];
    const txt=need('chipsToFormula')(chips);
    assert.equal(engineValue(txt,sample(1,10000)),900);
    assert.equal(engineValue(txt,sample(2,10250)),762.5);
});

test('C02: texto anterior se abre con los mismos chips sin alterar claves internas',()=>{
    const chips=need('formulaToChips')('gross * 5% + transporte',catalog);
    assert.deepEqual(chips,[F('gross'),O('*'),N(5,true),O('+'),F('custom:transporte')]);
});

test('C04: paréntesis, negativos y orden de operadores sobreviven ida/vuelta',()=>{
    const formula='-(gross - 200) * (5% + transporte / 10000)';
    const chips=need('formulaToChips')(formula,catalog);
    const rebuilt=need('chipsToFormula')(chips);
    assert.equal(engineValue(rebuilt,sample(1,10000)),engineValue(formula,sample(1,10000)));
    assert.ok(chips.some(c=>c.kind==='paren'));
});

test('C03: conceptos importados dinámicos conservan su identificador aunque se muestren traducidos',()=>{
    const chips=need('formulaToChips')('bonus:asistencia + transporte',catalog);
    assert.equal(chips[0].key,'bonus:asistencia');
    assert.equal(chips.at(-1).key,'custom:transporte');
    assert.equal(engineValue(need('chipsToFormula')(chips),sample(1,10000)),475);
});

test('C02: una fórmula guardada antigua soporta ciclos texto→visual→texto',()=>{
    const str=vars[1].formula;
    const chips=need('formulaToChips')(str,catalog);
    const roundtrip=need('chipsToFormula')(chips);
    assert.equal(engineValue(roundtrip,sample(1,10000)),engineValue(str,sample(1,10000)));
    assert.equal(vars[1].formula,str,'la conversión no muta la fórmula preexistente');
});

test('C05: campo desconocido no se convierte silenciosamente en texto o cero',()=>{
    assert.throws(()=>need('formulaToChips')('gross + campo_inexistente',catalog),/campo|desconocido|encontrado/i);
});

test('C14: rechaza chips no matemáticos y entradas que podrían ejecutar código',()=>{
    assert.throws(()=>need('chipsToFormula')([{kind:'text',value:'alert(1)'}]),/chip|campo|fórmula|inválid/i);
    assert.throws(()=>need('formulaToChips')('gross.constructor',catalog),/símbolo|inválid|campo/i);
});

test('C04: porcentaje se mantiene como porcentaje y no se convierte en 5 unidades',()=>{
    const txt=need('chipsToFormula')([F('gross'),O('*'),N(5,true)]);
    assert.match(txt,/%/);
    assert.equal(engineValue(txt,sample(1,10000)),500);
});

test('C15: impide crear fórmulas enormes más allá del límite del motor',()=>{
    const huge=Array.from({length:120},()=>N(1)).flatMap((n,i)=>i?[O('+'),n]:[n]);
    assert.throws(()=>need('chipsToFormula')(huge),/límite|largo|muchos|máximo/i);
});
