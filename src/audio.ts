/** Quiet, gesture-unlocked UI sounds. No downloads, tracking or background music. */
export type SoundCue =
  | 'select' | 'move' | 'redraw' | 'shuffle' | 'confirm' | 'score'
  | 'combo' | 'summon' | 'upgrade' | 'craft' | 'success' | 'error';

export const AUDIO_STORAGE_KEY = 'asteria.audio.enabled';
const MASTER_VOLUME = 0.16;
const MAX_VOICES = 28;
interface Note { frequency:number; delay:number; duration:number; volume:number; type?:OscillatorType }
const note=(frequency:number,delay=0,duration=.12,volume=.2,type:OscillatorType='sine'):Note=>({frequency,delay,duration,volume,type});
const CUES:Record<SoundCue,readonly Note[]>={
  select:[note(659.25,0,.085,.18),note(987.77,.025,.1,.08)],
  move:[note(523.25,0,.07,.16),note(783.99,.045,.095,.12)],
  redraw:[note(987.77,0,.1,.11),note(783.99,.045,.1,.13),note(659.25,.09,.15,.16)],
  shuffle:[note(987.77,0,.1,.11),note(783.99,.045,.1,.13),note(659.25,.09,.15,.16)],
  confirm:[note(523.25,0,.15,.19,'triangle'),note(659.25,.05,.16,.16),note(783.99,.1,.2,.16)],
  score:[note(659.25,0,.11,.16),note(783.99,.055,.14,.18),note(1046.5,.11,.21,.16)],
  combo:[note(523.25,0,.24,.16),note(783.99,.075,.25,.17),note(1046.5,.15,.3,.14),note(1567.98,.22,.24,.055)],
  summon:[note(392,0,.25,.17,'triangle'),note(587.33,.12,.28,.14),note(783.99,.26,.3,.16),note(1174.66,.42,.32,.11),note(1567.98,.54,.34,.065)],
  upgrade:[note(523.25,0,.2,.16,'triangle'),note(659.25,.09,.23,.14),note(783.99,.18,.28,.16),note(1046.5,.3,.35,.15),note(1318.51,.3,.34,.055)],
  craft:[note(440,0,.18,.15,'triangle'),note(659.25,.075,.23,.14),note(880,.16,.27,.17)],
  success:[note(523.25,0,.2,.16),note(659.25,.07,.24,.14),note(783.99,.14,.27,.16),note(1046.5,.24,.31,.11)],
  error:[note(220,0,.085,.15,'triangle'),note(196,.085,.12,.12,'triangle')],
};

function readEnabled():boolean {
  try{return typeof window!=='undefined'&&window.localStorage.getItem(AUDIO_STORAGE_KEY)==='true';}
  catch{return false;}
}
let enabled=readEnabled();
let context:AudioContext|null=null;
let master:GainNode|null=null;
const voices=new Set<OscillatorNode>();
const lastPlayed=new Map<SoundCue,number>();

export function isSoundEnabled():boolean{return enabled;}

function stopVoices():void {
  if(!context)return;
  for(const voice of voices){try{voice.stop(context.currentTime+.02);}catch{/* A voice may already have ended. */}}
}

/** Call from an explicit toggle. Muting fades and also cancels scheduled tones. */
export function setSoundEnabled(value:boolean):void {
  enabled=value;
  try{if(typeof window!=='undefined')window.localStorage.setItem(AUDIO_STORAGE_KEY,String(value));}catch{/* In-memory preference still works. */}
  lastPlayed.clear();
  if(context&&master){
    const now=context.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value,now);
    master.gain.linearRampToValueAtTime(value?MASTER_VOLUME:0,now+.018);
    if(!value)stopVoices();
  }
}

function getContext():AudioContext|null {
  if(context&&context.state!=='closed')return context;
  if(typeof window==='undefined')return null;
  // Nothing is initialized on page load. A restored preference still needs a gesture.
  if(typeof navigator!=='undefined'&&navigator.userActivation&&!navigator.userActivation.isActive)return null;
  const Constructor=window.AudioContext??(window as typeof window&{webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
  if(!Constructor)return null;
  try{
    context=new Constructor({latencyHint:'interactive'});
    master=context.createGain();master.gain.value=MASTER_VOLUME;master.connect(context.destination);
    return context;
  }catch{context=null;master=null;return null;}
}

function schedule(cue:SoundCue,audio:AudioContext):void {
  if(!enabled||!master||audio.state!=='running'||(typeof document!=='undefined'&&document.hidden))return;
  const now=audio.currentTime;
  const previous=lastPlayed.get(cue);
  if(previous!==undefined&&now-previous<.04)return;
  lastPlayed.set(cue,now);
  for(const tone of CUES[cue]??[]){
    if(voices.size>=MAX_VOICES)break;
    const oscillator=audio.createOscillator();const envelope=audio.createGain();
    const begin=now+.008+tone.delay;const end=begin+tone.duration;
    oscillator.type=tone.type??'sine';oscillator.frequency.setValueAtTime(tone.frequency,begin);
    envelope.gain.setValueAtTime(.0001,begin);
    envelope.gain.exponentialRampToValueAtTime(tone.volume,begin+.009);
    envelope.gain.exponentialRampToValueAtTime(.0001,end);
    oscillator.connect(envelope);envelope.connect(master);voices.add(oscillator);
    oscillator.onended=()=>{voices.delete(oscillator);oscillator.disconnect();envelope.disconnect();};
    oscillator.start(begin);oscillator.stop(end+.02);
  }
}

/** Invoke only from a user action; sound failure must never interrupt game logic. */
export function playSound(cue:SoundCue):void {
  if(!enabled)return;
  try{
    const audio=getContext();if(!audio)return;
    if(audio.state==='suspended'){
      void audio.resume().then(()=>{try{schedule(cue,audio);}catch{/* Optional audio. */}}).catch(()=>{});
    }else schedule(cue,audio);
  }catch{/* Unsupported or restricted audio is intentionally silent. */}
}
