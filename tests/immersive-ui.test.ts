import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import ts from 'typescript';

const file=new URL('../src/MatchArena.tsx',import.meta.url);
const sourceText=readFileSync(file,'utf8');
const source=ts.createSourceFile('MatchArena.tsx',sourceText,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function productionFunction(name:string,scope:Record<string,unknown>={}){
 let found:ts.FunctionDeclaration|undefined;
 const visit=(node:ts.Node)=>{if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node;ts.forEachChild(node,visit);};visit(source);
 assert.ok(found,'missing production handler: '+name);
 const context=createContext(scope);
 const code=ts.transpile(found.getText(source)+'\nglobalThis.handler='+name+';',{target:ts.ScriptTarget.ES2022});
 runInContext(code,context);return context.handler;
}
test('the illustrated arena is project-local, wide and valid PNG',()=>{
 const png=readFileSync(new URL('../public/art/arena-forest-v1.png',import.meta.url));
 assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 assert.ok(png.readUInt32BE(16)>=1200);assert.ok(png.readUInt32BE(16)/png.readUInt32BE(20)>1.6);
});
test('returning to the lobby does not end, pause, or mutate the server match',()=>{
 let back=0,commands=0;
 const goBack=productionFunction('goBack',{onBack:()=>back++,active:true,dirty:false,command:()=>commands++,setConfirmation:()=>{throw Error('unexpected confirmation');}});
 goBack();assert.equal(back,1);assert.equal(commands,0);
});
test('unsaved positions require confirmation before returning to the lobby',()=>{
 let back=0;let pending:any;
 productionFunction('goBack',{onBack:()=>back++,active:true,dirty:true,setConfirmation:(value:any)=>pending=value})();
 assert.equal(back,0);assert.equal(pending.kind,'back');
});
test('confirmed lobby navigation is independent of the abandon command',async()=>{
 let back=0,commands=0;let closed:any='not closed';
 const confirm=productionFunction('confirmAction',{confirmation:{kind:'back'},setConfirmation:(value:any)=>closed=value,onBack:()=>back++,command:()=>{commands++;throw Error('must not mutate match');}});
 await confirm();assert.equal(back,1);assert.equal(commands,0);assert.equal(closed,null);
});
test('the fullscreen handler enters native fullscreen only when invoked',async()=>{
 let calls=0;
 const action=productionFunction('toggleFullscreen',{document:{fullscreenElement:null,documentElement:{requestFullscreen:async()=>{calls++;}}},setError:()=>{}});
 assert.equal(calls,0);await action();assert.equal(calls,1);
});
test('the fullscreen handler exits an existing fullscreen session',async()=>{
 let exits=0;
 await productionFunction('toggleFullscreen',{document:{fullscreenElement:{},exitFullscreen:async()=>{exits++;}},setError:()=>{}})();
 assert.equal(exits,1);
});
test('a browser fullscreen rejection produces feedback, not a broken navigation path',async()=>{
 const messages:string[]=[];
 await productionFunction('toggleFullscreen',{document:{fullscreenElement:null,documentElement:{requestFullscreen:async()=>{throw new Error('permission denied');}}},mounted:{current:true},setError:(value:string)=>messages.push(value)})();
 assert.ok(messages.some(value=>value.length>0));
});

const appText=readFileSync(new URL('../src/CombatApp.tsx',import.meta.url),'utf8');
const appSource=ts.createSourceFile('CombatApp.tsx',appText,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function appNodes(predicate:(node:ts.Node)=>boolean){const found:ts.Node[]=[];const visit=(node:ts.Node)=>{if(predicate(node))found.push(node);ts.forEachChild(node,visit);};visit(appSource);return found;}
function execute(code:string,scope:Record<string,unknown>){const context=createContext(scope);runInContext(ts.transpile(code,{target:ts.ScriptTarget.ES2022}),context);return context;}
test('only a loaded, signed-in battle view enables the immersive shell',()=>{
 const declaration=appNodes(node=>ts.isVariableDeclaration(node)&&node.name.getText(appSource)==='immersive')[0] as ts.VariableDeclaration;
 assert.ok(declaration?.initializer);const expression=declaration.initializer.getText(appSource);
 for(const [page,snapshot,expected] of [['battle',null,false],['collection',{},false],['community',{},false],['battle',{},true]])assert.equal(execute('globalThis.value='+expression,{page,snapshot}).value,expected);
});
test('immersive overflow locking restores the exact lobby scroll state',()=>{
 const call=appNodes(node=>ts.isCallExpression(node)&&node.expression.getText(appSource)==='useEffect'&&!!node.arguments[0]?.getText(appSource).includes('if (!immersive)'))[0] as ts.CallExpression;
 assert.ok(call?.arguments[0]);const effect=call.arguments[0].getText(appSource);
 const document={body:{style:{overflow:'auto'}},documentElement:{style:{overflow:'scroll'}}};
 const context=execute('globalThis.cleanup=('+effect+')();',{document,immersive:true});
 assert.equal(document.body.style.overflow,'hidden');assert.equal(document.documentElement.style.overflow,'hidden');
 context.cleanup();assert.equal(document.body.style.overflow,'auto');assert.equal(document.documentElement.style.overflow,'scroll');
 const inactive=execute('globalThis.cleanup=('+effect+')();',{document,immersive:false});assert.equal(inactive.cleanup,undefined);assert.equal(document.body.style.overflow,'auto');
});
