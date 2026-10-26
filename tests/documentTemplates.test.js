const {test,describe} = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/SplitXDocuments.js');
const SF = require('../js/SplitXSheetFields.js');

const employee = () => ({
  id:1,employeeNumber:'001',name:'Ana & María <Ejemplo>',
  employeeName:'Ana & María <Ejemplo>',
  amount:8700,workDays:{total:10,regular:10},
  payroll:{gross:10000,bonuses:300,discounts:500},
  positions:[{id:'maestro',name:'Maestro de obra'}],
  exportContext:{companyName:'Constructora Norte',projectName:'Obra Centro',
    projectId:'project-one',currency:'DOP'}
});
const fields = () => SF.createFieldSet({records:[employee()]});
const render=(html, person={})=>{
  const f=fields();
  return D.render(html,employee(),f.fields,person,{
    resolveField:f.resolveField,index:0,today:'2026-10-26'
  });
};

describe('employee Word-like document templates',()=>{
 test('letter of entry reuses text and substitutes name, position, project, monthly salary',()=>{
   const original=employee(),before=JSON.stringify(original);
   const f=SF.createFieldSet({records:[original]});
   const html='<h2>Ingreso</h2><p>{{name}} · {{company}} · {{position}} · {{project}}. '+
      'Cédula {{idNumber}}, ingreso {{startDate}}, salario {{monthlySalary}}.</p>';
   const result=D.render(html,original,f.fields,
     {idNumber:'001-1234567-1',startDate:'2026-10-26',monthlySalary:'30000'},
     {resolveField:f.resolveField,index:0,today:'2026-10-26'});
   assert.deepEqual(result.missing,[]);
   assert.match(result.html,/Ana &amp; María &lt;Ejemplo&gt;/);
   assert.match(result.html,/Constructora Norte/);
   assert.match(result.html,/Maestro de obra/);
   assert.match(result.html,/RD\$|DOP/);
   assert.match(result.html,/30[,.]000/);
   assert.equal(JSON.stringify(original),before,'document generation must not alter original imported payroll');
 });
 test('monthly contractual salary must not be inferred from payroll gross or period net',()=>{
   const result=render('<p>{{gross}} · {{monthlySalary}}</p>');
   assert.equal(result.missing.includes('monthlySalary'),true);
   assert.match(result.html,/FALTA: Sueldo mensual contractual/);
   assert.match(result.html,/10[,.]000/);
 });
 test('missing or undefined fields are flagged rather than silently replaced',()=>{
   const result=render('{{name}} {{idNumber}} {{startDate}} {{fooNotFound}}');
   assert.deepEqual(result.missing,['idNumber','startDate','fooNotFound']);
   assert.match(result.html,/data-missing="idNumber"/);
   assert.match(result.html,/FALTA: fooNotFound/);
 });
 test('currency escapes suspicious personal data without HTML injection',()=>{
   const result=render('{{idNumber}} {{address}}', {
     idNumber:'<img src=x onerror=alert(1)>',address:'Calle & Principal'
   });
   assert.ok(!result.html.includes('<img'));
   assert.match(result.html,/&lt;img/);
   assert.match(result.html,/Calle &amp; Principal/);
 });
 test('document money fields differ from numeric days',()=>{
   const r=render('{{gross}} · {{days}} · {{dailyRate}}');
   assert.equal(r.missing.length,0);
   assert.match(r.html,/10[,.]000/);
   assert.match(r.html,/· 10 ·/);
 });
 test('person data uses source ID or a project-scoped number to avoid collision',()=>{
   const r=employee();
   assert.equal(D.personKey(r),'project:project-one:no:001');
   assert.notEqual(D.personKey(r),D.personKey({...r,exportContext:{projectId:'project-two'}}));
   assert.equal(D.personKey({...r,sourceEmployeeId:'sa-123'}),'source:sa-123');
 });
 test('only valid saved templates and supported personal fields survive loading',()=>{
   const result=D.safeState({
     activeId:'ok',templates:[
       {id:'ok',name:'Contrato',html:'<p>{{name}}</p>'},
       {id:'ok',name:'Duplicate',html:'test'},
       {id:'bad!',name:'Bad',html:'test'}
     ],people:{'project:project-one:no:001':{
       idNumber:'A123',monthlySalary:'32000',__proto__:'bad',other:'DROP'
     }}
   });
   assert.equal(result.templates.length,1);
   assert.equal(result.templates[0].name,'Contrato');
   assert.equal(result.people['project:project-one:no:001'].idNumber,'A123');
   assert.equal(result.people['project:project-one:no:001'].other,undefined);
 });
 test('tampered saved state falls back to a valid starter template',()=>{
   const result=D.safeState({templates:[{id:'x',name:'Too long',html:'a'.repeat(D.MAX_HTML+1)}]});
   assert.equal(result.templates.length,1);
   assert.match(result.templates[0].html,/constancia/i);
 });
 test('double-brace field inventory is distinct from static text',()=>{
   const names=D.placeholders('Ingreso {{name}}. {{name}} {{startDate}} {{gross}}');
   assert.deepEqual(names,['name','startDate','gross']);
 });
});
