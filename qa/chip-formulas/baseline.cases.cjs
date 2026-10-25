/**
 * Baseline (must PASS on current main): imported data and legacy text formulas.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SF = require('../../js/SplitXSheetFields.js');
const SB = require('../../js/SheetBuilder.js');
const CV = require('../../js/SplitXVariables.js');
const Studio = require('../../js/SheetStudio.js');

const employee = () => ({
    id: 1, employeeNumber: '001', name: 'Ana Ejemplo',
    amount: 8900, payroll: { gross: 10000, loans: 300 },
    bonusDetails: [{id:'asistencia',concept:'Bono de asistencia',amount:100}]
});
const standard = () => SF.createFieldSet({ records: [employee()] });
const buildEngine = (defs, base = standard()) => {
    const c = CV.createFieldSet(defs, base, SB);
    return SB.createEngine({fields:[...base.fields,...c.fields],resolveField:base.resolveField});
};
const result = (engine, id, record = employee()) =>
    engine.evaluateCell({ mode:'number', chips:[{kind:'field',key:'custom:'+id}] },
        record, {index:0}, null);

test('C01: existing text formulas still compute with saved IDs', () => {
    const defs = [
        {id:'transporte', label:'Transporte',kind:'fixed',value:250},
        {id:'extra',label:'Pago extra',kind:'formula',formula:'gross * 5% + transporte'}
    ];
    assert.equal(result(buildEngine(defs),'extra').value,750);
});

test('C03: imported concept references work without user code changes', () => {
    const defs = [{id:'bono',label:'Bono',kind:'formula',formula:'bonus:asistencia + 10'}];
    assert.equal(result(buildEngine(defs),'bono').value,110);
});

test('C05: recursion and unknown references cannot be saved', () => {
    const base = standard();
    assert.throws(()=>CV.validateDefinitions([
        {id:'a',label:'A',kind:'formula',formula:'b + 1'},
        {id:'b',label:'B',kind:'formula',formula:'a + 1'}
    ], base), /circular/i);
    assert.throws(()=>CV.validateDefinitions([
        {id:'other',label:'Other',kind:'formula',formula:'not_a_field + 1'}
    ],base), /no encontrado/i);
});

test('C09: evaluation does not mutate original imported payroll', () => {
    const e=employee(),before=JSON.stringify(e);
    const eng=buildEngine([{id:'t',label:'T',kind:'formula',formula:'gross * 5%'}]);
    assert.equal(result(eng,'t',e).value,500);
    assert.equal(JSON.stringify(e),before);
});

test('C13: SheetStudio migration preserves saved formula variable', () => {
    const vars=[{id:'extra',label:'Extra',kind:'formula',formula:'gross * 5%'}];
    const store=Studio.migrateStore({version:2,variables:vars});
    assert.deepEqual(store.variables,vars);
});

test('C14: existing formula engine rejects executable JavaScript', () => {
    assert.throws(()=>CV.tokenize('gross.constructor'),/símbolo|inválid/i);
    assert.throws(()=>CV.tokenize('window.alert(1)'),/símbolo|inválid/i);
    assert.throws(()=>CV.tokenize('gross; alert(1)'),/símbolo|inválid/i);
});
