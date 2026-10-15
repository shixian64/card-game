import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true});
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, issuer TEXT NOT NULL, client_id TEXT NOT NULL, subject TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_login INTEGER NOT NULL, UNIQUE(issuer,client_id,subject));
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS transactions(token_hash TEXT PRIMARY KEY,state TEXT NOT NULL,verifier TEXT NOT NULL,nonce TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS linuxdo_transactions(token_hash TEXT PRIMARY KEY,state TEXT NOT NULL,verifier TEXT NOT NULL,nonce TEXT NOT NULL,client_id TEXT NOT NULL,redirect_uri TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,visitor TEXT NOT NULL,user_id TEXT,kind TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,dev INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS event_time ON events(created_at);
    CREATE INDEX IF NOT EXISTS event_kind ON events(kind,created_at);
  `);
  return {
    db,
    clean() {const now=Date.now();db.prepare('DELETE FROM transactions WHERE expires_at<?').run(now);db.prepare('DELETE FROM linuxdo_transactions WHERE expires_at<?').run(now);db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);db.prepare('DELETE FROM events WHERE created_at<?').run(now-90*86400000);},
    shortTransaction(fn) {db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}},
    transaction(token, values) {db.prepare('INSERT INTO transactions VALUES(?,?,?,?,?)').run(hash(token),values.state,values.verifier,values.nonce,Date.now()+600000);},
    consumeTransaction(token) {return db.prepare('DELETE FROM transactions WHERE token_hash=? RETURNING *').get(hash(token));},
    linuxdoTransaction(token, values) {db.prepare('INSERT INTO linuxdo_transactions VALUES(?,?,?,?,?,?,?)').run(hash(token),values.state,values.verifier,values.nonce,values.clientId,values.redirectUri,Date.now()+600000);},
    consumeLinuxdoTransaction(token) {return db.prepare('DELETE FROM linuxdo_transactions WHERE token_hash=? RETURNING *').get(hash(token));},
    login(identity) {
      const now=Date.now();
      let user=db.prepare('SELECT * FROM users WHERE issuer=? AND client_id=? AND subject=?').get(identity.issuer,identity.clientId,identity.subject);
      if(!user) {const id=randomUUID();db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(id,identity.issuer,identity.clientId,identity.subject,identity.name.slice(0,80),now,now);user=db.prepare('SELECT * FROM users WHERE id=?').get(id);}
      else {db.prepare('UPDATE users SET name=?,last_login=? WHERE id=?').run(identity.name.slice(0,80),now,user.id);user={...user,name:identity.name.slice(0,80),last_login:now};}
      const token=randomToken();db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),user.id,now+8*3600000);return {token,user};
    },
    user(token) {return token ? db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?').get(hash(token),Date.now()) : null;},
    logout(token) {if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));},
    event(visitor,user,event) {
      return db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?)').run(hash(visitor+':'+event.id),visitor,user?.id??null,event.type,JSON.stringify(event.data),Date.now(),user?.issuer==='local-development'?1:0).changes;
    },
  };
}
const TYPES=new Set(['page_view','run_start','turn_complete','talent_pick','run_complete','run_abandon','summon','strengthen','craft','recycle']);
export function validateEvent(input) {
  if(!input||typeof input!=='object'||!TYPES.has(input.type)||typeof input.id!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.id)) throw new Error('事件格式不正确');
  const raw=input.data??{};if(typeof raw!=='object'||Array.isArray(raw))throw new Error('事件数据格式不正确');
  const data={};
  for(const key of ['score','coins','dust','rank','count','turn']) if(raw[key]!==undefined) {
    if(!Number.isSafeInteger(raw[key])||Math.abs(raw[key])>1000000||(!['coins','dust'].includes(key)&&raw[key]<0))throw new Error('事件数值超出范围');data[key]=raw[key];
  }
  for(const key of ['card','combo','page','runId','talent','grade']) if(raw[key]!==undefined) {
    if(typeof raw[key]!=='string'||raw[key].length>100||!/^[-a-zA-Z0-9_.]*$/.test(raw[key]))throw new Error('事件标识格式不正确');data[key]=raw[key];
  }
  if(raw.cards!==undefined) {if(!Array.isArray(raw.cards)||raw.cards.length>6||raw.cards.some(v=>typeof v!=='string'||!/^[a-z0-9-]{1,64}$/.test(v)))throw new Error('卡牌事件格式不正确');data.cards=raw.cards;}
  return {id:input.id,type:input.type,data};
}
export function summary(store,days=7,includeDev=false) {
  const since=Math.floor((Date.now()+8*3600000)/86400000)*86400000-8*3600000-(days-1)*86400000;
  const rows=store.db.prepare('SELECT * FROM events WHERE created_at>=? AND (dev=0 OR ?=1) ORDER BY created_at').all(since,includeDev?1:0);
  const kinds=Object.create(null),dayMap=Object.create(null),cards=Object.create(null),combos=Object.create(null),runs=new Map(),visitors=new Set(),accounts=new Set();
  const grades={S:0,A:0,B:0,C:0};const resources={coinsIn:0,coinsOut:0,dustIn:0,dustOut:0};let totalScore=0,completed=0;
  for(const row of rows) {
    const d=JSON.parse(row.data),day=new Date(row.created_at+8*3600000).toISOString().slice(0,10);
    kinds[row.kind]=(kinds[row.kind]??0)+1;visitors.add(row.visitor);if(row.user_id)accounts.add(row.user_id);
    dayMap[day]??={date:day,events:0,visitors:new Set(),completed:0,summons:0};dayMap[day].events++;dayMap[day].visitors.add(row.visitor);
    if(row.kind==='summon')dayMap[day].summons++;
    if(row.kind==='run_start'&&d.runId)runs.set(row.visitor+':'+d.runId,false);
    if(row.kind==='run_complete'){completed++;totalScore+=d.score??0;dayMap[day].completed++;if(Object.hasOwn(grades,d.grade))grades[d.grade]++;if(d.runId&&runs.has(row.visitor+':'+d.runId))runs.set(row.visitor+':'+d.runId,true);}
    if(row.kind==='turn_complete'&&d.combo)combos[d.combo]=(combos[d.combo]??0)+1;
    if(row.kind==='run_start')for(const card of d.cards??[])cards[card]=(cards[card]??0)+1;
    for(const key of ['coins','dust']) {const delta=d[key]??0;resources[key+(delta>=0?'In':'Out')]+=Math.abs(delta);}
  }
  const timeline=[];const today=Date.now();
  for(let n=days-1;n>=0;n--){const date=new Date(today-n*86400000+8*3600000).toISOString().slice(0,10);const d=dayMap[date];timeline.push(d?{...d,visitors:d.visitors.size}:{date,events:0,visitors:0,completed:0,summons:0});}
  return {days,timezone:'Asia/Shanghai',generatedAt:new Date().toISOString(),source:'client-reported',retentionDays:90,includeDev,
    totals:{visitors:visitors.size,accounts:accounts.size,events:rows.length,starts:runs.size,completed,completionRate:runs.size?Math.round([...runs.values()].filter(Boolean).length/runs.size*100):0,averageScore:completed?Math.round(totalScore/completed):0,summons:kinds.summon??0},
    kinds,grades,resources,timeline,
    cards:Object.entries(cards).map(([id,count])=>({id,count})).sort((a,b)=>b.count-a.count).slice(0,12),
    combos:Object.entries(combos).map(([id,count])=>({id,count})).sort((a,b)=>b.count-a.count),
    recent:rows.slice(-30).reverse().map(r=>({id:r.id.slice(0,10),user:r.user_id?'玩家 '+r.user_id.slice(0,8):'游客 '+r.visitor.slice(0,8),type:r.kind,data:JSON.parse(r.data),at:new Date(r.created_at).toISOString(),dev:!!r.dev})),
  };
}
