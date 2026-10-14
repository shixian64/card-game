import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';

const previous=new Map(['window','navigator','document'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
afterEach(()=>{for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});
let serial=0;
class Parameter {
  value=0;events:Array<{method:string;value:number;time:number}>=[];
  setValueAtTime(value:number,time:number){this.value=value;this.events.push({method:'set',value,time});}
  linearRampToValueAtTime(value:number,time:number){this.value=value;this.events.push({method:'linear',value,time});}
  exponentialRampToValueAtTime(value:number,time:number){this.value=value;this.events.push({method:'exponential',value,time});}
  cancelScheduledValues(time:number){this.events.push({method:'cancel',value:this.value,time});}
}
class Gain {gain=new Parameter();connected=false;connect(){this.connected=true;}disconnect(){this.connected=false;}}
class Voice {type='sine';frequency=new Parameter();starts:number[]=[];stops:number[]=[];onended:(()=>void)|null=null;connect(){}disconnect(){}start(time:number){this.starts.push(time);}stop(time:number){this.stops.push(time);}}
async function setup(options:{saved?:string;active?:boolean;unsupported?:boolean;blockedStorage?:boolean;suspended?:boolean}={}){
  const storage=new Map<string,string>();if(options.saved)storage.set('asteria.audio.enabled',options.saved);
  const contexts:Context[]=[];
  class Context {
    state=options.suspended?'suspended':'running';currentTime=10;destination={};gains:Gain[]=[];oscillators:Voice[]=[];resumes=0;
    constructor(){contexts.push(this);}
    createGain(){const gain=new Gain();this.gains.push(gain);return gain;}
    createOscillator(){const voice=new Voice();this.oscillators.push(voice);return voice;}
    resume(){this.resumes++;this.state='running';return Promise.resolve();}
  }
  const activation={isActive:options.active!==false};
  Object.defineProperty(globalThis,'window',{configurable:true,value:{AudioContext:options.unsupported?undefined:Context,localStorage:{getItem(key:string){if(options.blockedStorage)throw new Error('storage blocked');return storage.get(key)??null;},setItem(key:string,value:string){if(options.blockedStorage)throw new Error('storage blocked');storage.set(key,value);}}}});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userActivation:activation}});
  Object.defineProperty(globalThis,'document',{configurable:true,value:{hidden:false}});
  const audio=await import(`../src/audio.ts?audio-test=${serial++}`);
  return {audio,contexts,storage,activation};
}

test('audio defaults to silent and never creates a context on import or disabled play',async()=>{
  const {audio,contexts}=await setup();assert.equal(audio.isSoundEnabled(),false);audio.playSound('summon');assert.equal(contexts.length,0);
});
test('enabled preference persists but context is lazy until a real gesture',async()=>{
  const {audio,contexts,storage,activation}=await setup({saved:'true',active:false});
  assert.equal(audio.isSoundEnabled(),true);audio.playSound('select');assert.equal(contexts.length,0);
  activation.isActive=true;audio.playSound('select');assert.equal(contexts.length,1);assert.equal(contexts[0].gains[0].gain.value,.16);
  audio.setSoundEnabled(false);assert.equal(storage.get(audio.AUDIO_STORAGE_KEY),'false');
});
test('every cue schedules finite, low-volume notes without external resources',async()=>{
  const {audio,contexts}=await setup();audio.setSoundEnabled(true);
  for(const cue of ['select','move','redraw','shuffle','confirm','score','combo','summon','upgrade','craft','success','error']){
    const before=contexts[0]?.oscillators.length??0;audio.playSound(cue);const context=contexts[0];
    assert.ok(context.oscillators.length>before,`${cue} schedules notes`);
    for(const voice of context.oscillators.slice(before)){assert.equal(voice.starts.length,1);assert.ok(voice.stops[0]>voice.starts[0]);assert.ok(voice.stops[0]-context.currentTime<1);assert.ok(voice.frequency.value>0&&voice.frequency.value<2000);voice.onended?.();}
    for(const gain of context.gains.slice(1))for(const event of gain.gain.events)assert.ok(event.value<=.2);
    context.currentTime+=1;
  }
  assert.equal(contexts.length,1,'all cues reuse one context');
});
test('mute fades the master and cancels previously scheduled tones',async()=>{
  const {audio,contexts}=await setup();audio.setSoundEnabled(true);audio.playSound('summon');const context=contexts[0];
  audio.setSoundEnabled(false);assert.equal(context.gains[0].gain.value,0);
  for(const voice of context.oscillators)assert.equal(voice.stops.at(-1),context.currentTime+.02);
  const before=context.oscillators.length;audio.playSound('select');assert.equal(context.oscillators.length,before);
});
test('suspended context resumes and rapid duplicate clicks are throttled',async()=>{
  const {audio,contexts}=await setup({suspended:true});audio.setSoundEnabled(true);audio.playSound('select');await Promise.resolve();
  const context=contexts[0];assert.equal(context.resumes,1);assert.equal(context.oscillators.length,2);
  audio.playSound('select');assert.equal(context.oscillators.length,2);context.currentTime+=.05;audio.playSound('select');assert.equal(context.oscillators.length,4);
});
test('unsupported Web Audio and blocked storage cannot break game actions',async()=>{
  const {audio,contexts}=await setup({unsupported:true,blockedStorage:true});assert.doesNotThrow(()=>{audio.setSoundEnabled(true);audio.playSound('success');audio.setSoundEnabled(false);});assert.equal(contexts.length,0);
});
