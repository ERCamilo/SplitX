const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SB = require('../js/SheetBuilder.js');
const SF = require('../js/SplitXSheetFields.js');
const CV = require('../js/SplitXVariables.js');

const record = {
    id: 20, employeeNumber: '001', name: 'Ana', amount: 900,
    payroll: { gross: 1000, bonuses: 50, discounts: 100 },
    workDays: {total:10}
};
const base = SF.createFieldSet({records:[record]});
const make = defs => {
    const custom = CV.createFieldSet(defs, base, SB);
    return SB.createEngine({
        fields: [...base.fields,...custom.fields],
        resolveField: base.resolveField,
        locale: 'en-US'
    });
};
const cell = id => ({ mode:'number',chips:[{kind:'field',key:'custom:'+id}]});
describe('custom printable sheet variables', () => {
    test('constant can be inserted into card and signatures without changing payroll', () => {
        const before = JSON.stringify(record);
        const eng = make([{id:'transporte',label:'Transporte',kind:'fixed',value:250}]);
        assert.equal(eng.evaluateCell(cell('transporte'),record,{index:0},null).value,250);
        assert.equal(JSON.stringify(record),before);
        assert.equal(eng.evaluateCell({mode:'number',chips:[{kind:'field',key:'gross'}]},record,{index:0},null).value,1000);
    });
    test('formula combines imported fields, constants and custom variables', () => {
        const eng = make([
            {id:'transporte',label:'Transporte',kind:'fixed',value:250},
            {id:'pago_extra',label:'Pago extra',kind:'formula',formula:'gross * 5% + transporte'}
        ]);
        assert.equal(eng.evaluateCell(cell('pago_extra'),record,{index:0},null).value,300);
    });
    test('employee overrides fall back to the global constant', () => {
        const eng = make([
            {id:'transporte',label:'Transporte',kind:'fixed',value:250,overrides:{'001':400}}
        ]);
        assert.equal(eng.evaluateCell(cell('transporte'),record,{index:0},null).value,400);
        assert.equal(eng.evaluateCell(cell('transporte'),{...record,employeeNumber:'002'},{index:1},null).value,250);
    });
    test('dynamic imported concept identifiers can be used in calculations', () => {
        const e = {...record, bonusDetails:[{id:'asistencia',concept:'Asistencia',amount:35}]};
        const source = SF.createFieldSet({records:[e]});
        const v = CV.createFieldSet([{id:'bono_especial',label:'Bono',kind:'formula',formula:'bonus:asistencia + 15'}],source,SB);
        const eng = SB.createEngine({fields:[...source.fields,...v.fields],resolveField:source.resolveField});
        assert.equal(eng.evaluateCell(cell('bono_especial'),e,{index:0},null).value,50);
    });
    test('rejects unknown, malicious and circular formulas', () => {
        assert.throws(()=>CV.validateDefinitions([{id:'x',label:'X',kind:'formula',formula:'gross.constructor'}],base));
        assert.throws(()=>CV.validateDefinitions([{id:'x',label:'X',kind:'formula',formula:'unknown + 1'}],base),/no encontrado/i);
        assert.throws(()=>CV.validateDefinitions([
            {id:'x',label:'X',kind:'formula',formula:'y + 1'},
            {id:'y',label:'Y',kind:'formula',formula:'x + 1'}
        ],base),/circular/i);
        assert.throws(()=>CV.validateDefinitions([{id:'gross',label:'X',kind:'fixed',value:2}],base),/importado/i);
    });
    test('division by zero becomes a visible cell error rather than silently zero', () => {
        const eng = make([{id:'ratio',label:'Razón',kind:'formula',formula:'gross / (days - 10)'}]);
        const res = eng.evaluateCell(cell('ratio'),record,{index:0},null);
        assert.equal(res.value,null);
        assert.match(res.error,/cero/i);
    });
    test('changes in the original imported fields recalculate formulas', () => {
        const eng = make([{id:'extra',label:'Extra',kind:'formula',formula:'gross * 0.05'}]);
        assert.equal(eng.evaluateCell(cell('extra'),record,{index:0},null).value,50);
        assert.equal(eng.evaluateCell(cell('extra'),{...record,payroll:{...record.payroll,gross:2000}},{index:0},null).value,100);
    });
});
