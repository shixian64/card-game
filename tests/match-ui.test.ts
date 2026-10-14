import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import ts from 'typescript';
import {CARDS,CARD_MAP} from '../src/data.ts';

// Execute real source helpers/effects with controlled clocks, not copied game logic.
// No browser, network, React renderer, or additional dependency is needed.
const sourceText=readFileSync(new URL('../src/MatchArena.tsx',import.meta.url),'utf8');
const source=ts.createSourceFile('MatchArena.tsx',sourceText,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const appText=readFileSync(new URL('../src/CombatApp.tsx',import.meta.url),'utf8');
const appSource=ts.createSourceFile('CombatApp.tsx',appText,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function nodes(root:ts.Node,predicate:(node:ts.Node)=>boolean){
  const found:ts.Node[]=[];
  function visit(node:ts.Node){if(predicate(node))found.push(node);ts.forEachChild(node,visit);}
  visit(root);return found;
}
function functionNode(root:ts.Node,name:string){
  const found=nodes(root,node=>ts.isFunctionDeclaration(node)&&node.name?.text===name)[0];
  assert.ok(found&&ts.isFunctionDeclaration(found),'missing production function: '+name);
  return found;
}
const component=functionNode(source,'MatchArena');
function declaration(name:string){
  const found=nodes(source,node=>ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text===name)[0];
  assert.ok(found&&ts.isVariableDeclaration(found)&&found.initializer,'missing declaration: '+name);
  return 'const '+name+'='+found.initializer.getText(source)+';';
}
function compile(code:string,scope:Record<string,unknown>={}){
  const context=createContext(scope);
  const compiled=ts.transpileModule(code,{fileName:'test-source.tsx',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}});
  runInContext(compiled.outputText,context);
  return context;
}
function plain<T>(value:T):T{return JSON.parse(JSON.stringify(value));}
const moduleContext=compile(sourceText,{exports:{},require:(name:string)=>name==='./data'?{CARD_MAP}: {}});
const helpers=moduleContext.exports;
const roster=[
  {uid:'m1',defId:'sun-cub',rank:1,best:0,stars:1},
  {uid:'m2',defId:'sun-cub',rank:1,best:0,stars:1},
  {uid:'m3',defId:'moon-fawn',rank:2,best:0,stars:2},
];

// The original eleven ad-hoc assertions are now persistent regression tests.
test('match clock formats the full ten-minute duration',()=>assert.equal(helpers.formatMatchClock(600000),'10:00'));
test('match clock rounds a remaining partial second up',()=>assert.equal(helpers.formatMatchClock(1),'00:01'));
test('match clock displays zero at the deadline',()=>assert.equal(helpers.formatMatchClock(0),'00:00'));
test('match clock never displays negative time',()=>assert.equal(helpers.formatMatchClock(-1000),'00:00'));
test('match clock handles the minute boundary',()=>assert.equal(helpers.formatMatchClock(59001),'01:00'));
test('formation keys are order-independent and do not mutate the input',()=>{
  const formation=[{uid:'m2',slot:27},{uid:'m1',slot:0}];const before=structuredClone(formation);
  assert.equal(helpers.matchFormationKey(formation),'m1@0|m2@27');assert.deepEqual(formation,before);
});
test('an empty formation has an empty stable key',()=>assert.equal(helpers.matchFormationKey([]),''));
test('different instances of the same hero may occupy slots 0 and 27',()=>{
  const formation=[{uid:'m1',slot:0},{uid:'m2',slot:27}];
  assert.deepEqual(plain(helpers.cleanMatchFormation(formation,roster,3)),formation);
});
test('formation cleaning rejects removed units, duplicate units/slots, invalid positions and population overflow',()=>{
  const formation=[{uid:'gone',slot:1},{uid:'m1',slot:0},{uid:'m1',slot:2},{uid:'m2',slot:0},{uid:'m2',slot:28},{uid:'m2',slot:-1},{uid:'m2',slot:1.5},{uid:'m2',slot:27},{uid:'m3',slot:5}];
  const before=structuredClone(formation);
  assert.deepEqual(plain(helpers.cleanMatchFormation(formation,roster,2)),[{uid:'m1',slot:0},{uid:'m2',slot:27}]);
  assert.deepEqual(formation,before);
});
test('the UI permits saving an empty formation',()=>assert.deepEqual(plain(helpers.cleanMatchFormation([],roster,3)),[]));
test('population zero never retains a unit',()=>assert.deepEqual(plain(helpers.cleanMatchFormation([{uid:'m1',slot:0}],roster,0)),[]));

const timingCode=['serverTime','phaseRemaining','totalRemaining','active','planning','canPlan'].map(declaration).join('\n');
function timing(overrides:Record<string,unknown>={}){
  const scope={anchor:{server:100000,client:500000},clock:501234,match:{id:'match-1',status:'playing',phase:'planning',phaseEndsAt:140000,endsAt:700000},busy:false,pending:false,...overrides};
  return compile(timingCode+'\nglobalThis.result={serverTime,phaseRemaining,totalRemaining,canPlan};',scope).result;
}
test('countdown follows the server offset instead of the local wall-clock epoch',()=>{
  assert.deepEqual(plain(timing()),{serverTime:101234,phaseRemaining:38766,totalRemaining:598766,canPlan:true});
});
test('the exact phase deadline disables planning and elapsed clocks clamp to zero',()=>{
  assert.equal(timing({clock:540000}).canPlan,false);assert.equal(timing({clock:540000}).phaseRemaining,0);
  assert.equal(timing({clock:1200000}).totalRemaining,0);
  assert.equal(timing({busy:true}).canPlan,false);assert.equal(timing({pending:true}).canPlan,false);
});

const effects=nodes(component,node=>ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='useEffect') as ts.CallExpression[];
function intervalEffect(delay:number){
  const effect=effects.find(call=>nodes(call.arguments[0],node=>ts.isCallExpression(node)&&node.expression.getText(source)==='setInterval'&&node.arguments[1]?.getText(source)===String(delay)).length>0);
  assert.ok(effect,'missing '+delay+'ms effect');return effect.arguments[0].getText(source);
}
function effectContaining(identifier:string){
  const found=effects.find(call=>nodes(call.arguments[0],node=>ts.isIdentifier(node)&&node.text===identifier).length>0);
  assert.ok(found,'missing effect: '+identifier);return found.arguments[0].getText(source);
}
function fakeDocument(){
  const listeners=new Map<string,Set<()=>void>>();
  return {
    visibilityState:'visible',listeners,
    addEventListener(event:string,fn:()=>void){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event)!.add(fn);},
    removeEventListener(event:string,fn:()=>void){listeners.get(event)?.delete(fn);},
    dispatch(event:string){for(const fn of [...(listeners.get(event)??[])])fn();},
  };
}
function runEffect(body:string,scope:Record<string,unknown>){
  const context=compile('globalThis.effect='+body+';',scope);
  return {context,cleanup:context.effect()};
}
test('one-second clock ticks stay local, pause in hidden tabs and clean up listeners',()=>{
  const document=fakeDocument();let now=500000;const clocks:number[]=[];let callback=()=>{};let cleared=false;
  const {cleanup}=runEffect(intervalEffect(1000),{document,Date:{now:()=>now},setClock:(value:number)=>clocks.push(value),setInterval:(fn:()=>void,delay:number)=>{assert.equal(delay,1000);callback=fn;return 11;},clearInterval:(id:number)=>{assert.equal(id,11);cleared=true;}});
  callback();assert.deepEqual(clocks,[500000]);document.visibilityState='hidden';now+=1000;callback();assert.equal(clocks.length,1);
  document.visibilityState='visible';document.dispatch('visibilitychange');assert.deepEqual(clocks,[500000,501000]);
  cleanup();assert.equal(cleared,true);assert.equal(document.listeners.get('visibilitychange')?.size,0);
});
test('new server snapshots re-anchor the countdown against the current local time',()=>{
  let anchor:unknown,clock:unknown;
  runEffect(effectContaining('setAnchor'),{match:{serverNow:200000},Date:{now:()=>900000},setAnchor:(value:unknown)=>{anchor=value;},setClock:(value:unknown)=>{clock=value;}});
  assert.deepEqual(plain(anchor),{server:200000,client:900000});assert.equal(clock,900000);
});
test('active matches refresh every five seconds only while visible and use the latest refresh callback',()=>{
  const document=fakeDocument();let refreshes=0;let latestRefreshes=0;let callback=()=>{};let cleared=false;
  const refreshRef={current:()=>{refreshes++;}};
  const {cleanup}=runEffect(intervalEffect(5000),{active:true,document,refreshRef,setInterval:(fn:()=>void,delay:number)=>{assert.equal(delay,5000);callback=fn;return 22;},clearInterval:(id:number)=>{assert.equal(id,22);cleared=true;}});
  callback();assert.equal(refreshes,1);document.visibilityState='hidden';callback();document.dispatch('visibilitychange');assert.equal(refreshes,1);
  document.visibilityState='visible';document.dispatch('visibilitychange');assert.equal(refreshes,2);
  refreshRef.current=()=>{latestRefreshes++;};callback();assert.equal(latestRefreshes,1);
  cleanup();assert.equal(cleared,true);assert.equal(document.listeners.get('visibilitychange')?.size,0);
});
test('finished or absent matches do not install the active refresh timer',()=>{
  let installed=0;runEffect(intervalEffect(5000),{active:false,setInterval:()=>{installed++;}});assert.equal(installed,0);
});
test('each phase deadline requests one refresh, with a new key for the next phase',()=>{
  const document=fakeDocument();let refreshes=0;const deadlineSeen={current:''};
  const context=compile('globalThis.effect='+effectContaining('deadlineSeen')+';',{active:true,match:{id:'match-1',round:1,phase:'planning',phaseEndsAt:140000},serverTime:139999,document,deadlineSeen,refreshRef:{current:()=>{refreshes++;}}});
  context.effect();assert.equal(refreshes,0);context.serverTime=140000;context.effect();context.effect();assert.equal(refreshes,1);
  context.serverTime=140001;context.effect();assert.equal(refreshes,1);
  context.match={id:'match-1',round:1,phase:'combat',phaseEndsAt:175000};context.serverTime=175000;context.effect();context.effect();assert.equal(refreshes,2);
  context.match={id:'match-1',round:2,phase:'planning',phaseEndsAt:215000};context.serverTime=215000;document.visibilityState='hidden';context.effect();assert.equal(refreshes,2);
  document.visibilityState='visible';context.effect();assert.equal(refreshes,3);context.active=false;context.match={...context.match,id:'match-2'};context.effect();assert.equal(refreshes,3);
});
test('refresh failures are contained and the visible polling timer remains usable for retries',async()=>{
  const document=fakeDocument();let callback=()=>{};let attempts=0;
  const refreshRef={current:()=>{attempts++;return Promise.reject(new Error('offline'));}};
  const {cleanup}=runEffect(intervalEffect(5000),{active:true,document,refreshRef,setInterval:(fn:()=>void)=>{callback=fn;return 1;},clearInterval(){}});
  assert.doesNotThrow(callback);await Promise.resolve();assert.equal(attempts,1);
  refreshRef.current=()=>{attempts++;throw new Error('sync offline');};assert.doesNotThrow(callback);assert.equal(attempts,2);cleanup();
});

function matchCommandScope(onCommand:(action:string,args:Record<string,unknown>)=>Promise<boolean>){
  return {busy:false,pendingRef:{current:false},currentId:{current:'match-1'},mounted:{current:true},setPending(){},setError(){},setNotice(){},onCommand};
}
test('every MatchArena command traverses the actual parent pipeline with exactly one match prefix',async()=>{
  const adapter=nodes(appSource,node=>ts.isJsxAttribute(node)&&node.name.getText(appSource)==='onCommand')[0] as ts.JsxAttribute;
  assert.ok(adapter?.initializer&&ts.isJsxExpression(adapter.initializer)&&adapter.initializer.expression);
  const actions=[...new Set(nodes(source,node=>ts.isStringLiteral(node)&&/^match\./.test(node.text)).map(node=>(node as ts.StringLiteral).text))].sort();
  assert.deepEqual(actions,['match.abandon','match.buy','match.deploy','match.lock','match.reroll','match.sell','match.start','match.xp']);
  const requests:Array<{url:string;options:{method:string;headers:Record<string,string>;body:string}}> = [];
  let sequence=0;
  const parent=compile(functionNode(appSource,'command').getText(appSource)+'\nglobalThis.adapter='+adapter.initializer.expression.getText(appSource)+';',{
    identityRef:{current:'match-ui-user'},busyRef:{current:false},operationRef:{current:0},setBusy(){},setToast(){},playSound(){},accept(){},refreshGame:async()=>{},
    makeRequestId:()=> 'fixture-request-'+(++sequence),responseData:async()=>({state:{cards:[]},revision:1}),
    fetch:async(url:string,options:{method:string;headers:Record<string,string>;body:string})=>{requests.push({url,options});return {};},
  });
  const child=compile(functionNode(component,'command').getText(source)+'\nglobalThis.commandForTest=command;',matchCommandScope(parent.adapter));
  for(const action of actions){
    assert.equal(await child.commandForTest(action,{marker:action}),true);
    const request=requests.at(-1)!;
    assert.equal(request.url,'/api/game/'+action);assert.equal(request.options.method,'POST');
    assert.equal(request.options.headers['X-Asteria-User'],'match-ui-user');
    assert.equal(JSON.parse(request.options.body).marker,action);
    assert.equal(JSON.parse(request.options.body).requestId,'fixture-request-'+sequence);
    assert.ok(!request.url.includes('match.match.'));
  }
  assert.equal(requests.length,8);
});
test('the synchronous match command guard prevents a duplicate request while the first one is pending',async()=>{
  let calls=0;let finish:(result:boolean)=>void=()=>{};
  const context=compile(functionNode(component,'command').getText(source)+'\nglobalThis.commandForTest=command;',matchCommandScope(async()=>{calls++;return new Promise<boolean>(resolve=>{finish=resolve;});}));
  const first=context.commandForTest('match.buy',{offerId:'offer-1'});
  assert.equal(await context.commandForTest('match.buy',{offerId:'offer-1'}),false);assert.equal(calls,1);
  finish(true);assert.equal(await first,true);assert.equal(context.pendingRef.current,false);
});
test('replay-only BattleArena callbacks cannot settle, abandon or restart a server battle',async()=>{
  const arena=nodes(component,node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)==='BattleArena'&&node.attributes.properties.some(prop=>ts.isJsxAttribute(prop)&&prop.name.getText(source)==='replayOnly'))[0] as ts.JsxSelfClosingElement;
  assert.ok(arena);let commands=0;
  for(const name of ['onAction','onAbandon','onStart']){
    const attribute=arena.attributes.properties.find(prop=>ts.isJsxAttribute(prop)&&prop.name.getText(source)===name) as ts.JsxAttribute;
    assert.ok(attribute?.initializer&&ts.isJsxExpression(attribute.initializer)&&attribute.initializer.expression);
    const context=compile('globalThis.callback='+attribute.initializer.expression.getText(source)+';',{command:()=>{commands++;},onCommand:()=>{commands++;}});
    assert.equal(await context.callback({type:'resolve'}),undefined);
  }
  assert.equal(commands,0);
});
test('sell preview uses rarity cost times three to the star power and not permanent rank',()=>{
  const context=compile(declaration('PRICE')+'\n'+functionNode(source,'saleValue').getText(source)+'\nglobalThis.preview=saleValue;',{CARD_MAP});
  for(const [rarity,cost] of [['R',1],['SR',2],['SSR',3]] as const){
    const def=CARDS.find(card=>card.rarity===rarity)!;
    for(const stars of [1,2,3])for(const rank of [1,3])assert.equal(context.preview({uid:'m',defId:def.id,rank,best:0,stars}),cost*3**(stars-1));
  }
});

test('a newly received match cannot transiently show more than ten minutes or its phase budget',()=>{
  const future={id:'new-match',status:'playing',phase:'planning',phaseEndsAt:200000,endsAt:760000};
  const view=timing({match:future,clock:500000});
  assert.equal(view.totalRemaining,600000);assert.equal(view.phaseRemaining,40000);
  const fight=timing({match:{...future,phase:'combat'},clock:500000});assert.equal(fight.phaseRemaining,35000);
});
