import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import ts from 'typescript';
import {CARDS} from '../src/data.ts';
import {getCombatStats} from '../src/battle.ts';

const app=readFileSync(new URL('../src/CombatApp.tsx',import.meta.url),'utf8');
const arena=readFileSync(new URL('../src/BattleArena.tsx',import.meta.url),'utf8');

test('MatchArena adapter uses the actual authenticated command pipeline without a double match prefix',async()=>{
  const source=ts.createSourceFile('CombatApp.tsx',app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let commandSource='',adapterSource='';
  function visit(node:ts.Node){
    if(ts.isFunctionDeclaration(node)&&node.name?.text==='command')commandSource=node.getText(source);
    if(ts.isJsxAttribute(node)&&node.name.getText(source)==='onCommand'&&node.initializer&&ts.isJsxExpression(node.initializer)&&node.initializer.expression)adapterSource=node.initializer.expression.getText(source);
    ts.forEachChild(node,visit);
  }
  visit(source);assert.ok(commandSource&&adapterSource);
  const requests:Array<{url:string;options:{method:string;headers:Record<string,string>;body:string}}>=[];
  const context=createContext({
    identityRef:{current:'ui-path-test'},busyRef:{current:false},operationRef:{current:0},
    setBusy(){},setToast(){},playSound(){},makeRequestId:()=> 'request-fixture',accept(){},refreshGame:async()=>{},
    responseData:async()=>({state:{cards:[]},revision:1}),
    fetch:async(url:string,options:{method:string;headers:Record<string,string>;body:string})=>{requests.push({url,options});return {};},Error,JSON,
  });
  runInContext(ts.transpile(commandSource+'\nglobalThis.invoke='+adapterSource,{target:ts.ScriptTarget.ES2022}),context);
  for(const action of ['match.start','match.xp','match.deploy','match.buy','match.sell']){
    await context.invoke(action,{fixture:true});
    const request=requests.at(-1)!;
    assert.equal(request.url,'/api/game/'+action);
    assert.equal(request.options.method,'POST');
    assert.equal(request.options.headers['X-Asteria-User'],'ui-path-test');
    assert.equal(JSON.parse(request.options.body).requestId,'request-fixture');
    assert.ok(!request.url.includes('match.match.'));
  }
});

test('recommendation respects 28 slots, population limits, strongest permanent copy, and temporary duplicate copies',()=>{
  const source=arena.slice(arena.indexOf('const EMPTY_SLOTS:'),arena.indexOf('function AffinityMark('));
  const context=createContext({getCombatStats});
  runInContext(ts.transpile(source+'\nglobalThis.api={bestCopies,recommend};',{target:ts.ScriptTarget.ES2022}),context);
  const cards=CARDS.slice(0,12).map((def,index)=>({uid:'test-'+index,defId:def.id,rank:1,best:0,stars:1}));
  for(let size=1;size<=6;size++){
    const slots=context.api.recommend(cards,size,true);
    assert.equal(slots.length,28);
    assert.equal(slots.filter(Boolean).length,size);
    assert.equal(new Set(slots.filter(Boolean)).size,size);
  }
  const copies=[{...cards[0],uid:'a',rank:1},{...cards[0],uid:'b',rank:3},{...cards[0],uid:'c',rank:2}];
  assert.equal(context.api.bestCopies(copies).length,1);
  assert.equal(context.api.bestCopies(copies)[0].uid,'b');
  assert.equal(context.api.recommend(copies,3,true).filter(Boolean).length,3);
  assert.equal(context.api.recommend(copies,6,false).filter(Boolean).length,1);
  const slots=context.api.recommend(cards,6,true);
  for(let slot=0;slot<28;slot++){
    const card=cards.find(item=>item.uid===slots[slot]);if(!card)continue;
    const role=getCombatStats(card).role;
    if(role==='坦克')assert.ok(slot<14);
    if(role==='射手'||role==='法师')assert.ok(slot>=14);
  }
});

test('collection artwork stays free of rarity, affinity and level corner labels',()=>{
  const body=app.slice(app.indexOf('function Card('),app.indexOf('function Confirmation('));
  for(const className of ['className="rank-badge"','className="card-rarity"','className="card-affinity"'])assert.ok(!body.includes(className));
  assert.ok(body.includes('data-rarity={def.rarity}'));
  assert.ok(body.includes('data-rank={rank}'));
  assert.ok(!app.includes('className="portrait-rarity"'));
  assert.ok(!app.includes('className="portrait-affinity"'));
});
