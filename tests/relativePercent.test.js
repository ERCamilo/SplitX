/**
 * Regression for the user-reported visual formula:
 * (Sueldo por día - 3%) × 26 returned -0.78 when daily rate was empty,
 * because the custom-variable evaluator subtracted literal 0.03.
 * SheetBuilder already uses calculator-style relative percentage for +/-.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const CV = require('../js/SplitXVariables.js');
const SB = require('../js/SheetBuilder.js');
const SF = require('../js/SplitXSheetFields.js');

const chips = (rate = 'dailyRate', percent = 3, days = 26) => [
    {kind:'paren',paren:'('}, {kind:'field',key:rate},
    {kind:'op',op:'-'}, {kind:'number',value:percent,percent:true},
    {kind:'paren',paren:')'}, {kind:'op',op:'*'},
    {kind:'number',value:days}
];

describe('calculator-style percentage parity across variable and printable engines', () => {
    const cases = [
        ['dailyRate - 3%', 970],
        ['(dailyRate - 3%) * 26', 25220],
        ['dailyRate + 3%', 1030],
        ['(dailyRate + 3%) * 26', 26780],
        ['dailyRate * 3%', 30],
        ['dailyRate - 0.03', 999.97],
        ['dailyRate - (3%)', 999.97],
        ['dailyRate - 3% * 26', 999.22],
        ['dailyRate - 3% - 2%', 950.6],
        ['dailyRate - 3% + 2%', 989.4],
        ['gross * 5% + transporte', 750],
    ];
    for (const [formula, expected] of cases) {
        test('evaluates '+formula+' with its intended relative/absolute meaning', () => {
            const value = CV.evaluate(formula, key => ({
                dailyRate:1000, gross:10000, transporte:250
            })[key]);
            assert.ok(Math.abs(value - expected) < 0.000001,
                formula+' expected '+expected+', got '+value);
        });
    }
    test('exact screenshot structure converts from chips to text and yields equivalent print result', () => {
        const tokens = chips();
        const formula = CV.chipsToFormula(tokens);
        const employee = {dailyRate:1000};
        const field = [{key:'dailyRate',type:'number',label:'Sueldo por día',get:r=>r.dailyRate}];
        const engine = SB.createEngine({fields:field});
        const actual = engine.evaluateCell({mode:'number',chips:tokens},employee,{index:0},null);
        assert.equal(actual.value,25220);
        assert.equal(CV.evaluate(formula,key=>employee[key]),25220);
        assert.deepEqual(CV.formulaToChips(formula,{fields:field}),tokens);
    });
    test('zero daily wage results in zero rather than -0.78 (the screenshot regression)', () => {
        const formula=CV.chipsToFormula(chips());
        assert.equal(CV.evaluate(formula,() => 0),0);
        const field=[{key:'dailyRate',type:'number',get:()=>0,label:'Sueldo por día'}];
        const SBResult=SB.createEngine({fields:field}).evaluateCell({mode:'number',chips:chips()},{},{},null);
        assert.equal(SBResult.value,0);
    });
    test('saved named formula and rendered print cell use the same percentage rule', () => {
        const record = {
            employeeNumber:'001',name:'Empleado ficticio',
            workDays:{total:26,regular:26},payroll:{gross:26000}
        };
        const base = SF.createFieldSet({records:[record]});
        const defs = [{id:'pago_ajustado',label:'Pago ajustado',kind:'formula',
            formula:CV.chipsToFormula(chips())}];
        const own = CV.createFieldSet(defs,base,SB);
        const engine=SB.createEngine({fields:[...base.fields,...own.fields],resolveField:base.resolveField});
        const fromVariable=engine.evaluateCell({
            mode:'number',chips:[{kind:'field',key:'custom:pago_ajustado'}]
        },record,{index:0},null);
        const fromChips=engine.evaluateCell({mode:'number',chips:chips()},record,{index:0},null);
        assert.equal(fromVariable.value,25220);
        assert.equal(fromVariable.value,fromChips.value);
    });
    test('unavailable dailyRate is treated as zero, never as an accidental negative amount', () => {
        const record={name:'Empleado sin tarifa',payroll:{gross:0},workDays:{total:26}};
        const base=SF.createFieldSet({records:[record]});
        const own=CV.createFieldSet([{id:'pago',label:'Pago',kind:'formula',
            formula:'(dailyRate - 3%) * 26'}],base,SB);
        const field=own.fields.find(f=>f.key==='custom:pago');
        assert.equal(field.get(record,{index:0}),0);
    });
    test('division-by-zero and invalid formulas remain blocked', () => {
        assert.throws(()=>CV.evaluate('dailyRate / 0',()=>1000),/cero/i);
        assert.throws(()=>CV.evaluate('dailyRate - 3%%',()=>1000),/fórmula|inválid|sobra|valor/i);
        assert.throws(()=>CV.evaluate('dailyRate.constructor',()=>1000),/inválid/i);
    });
});