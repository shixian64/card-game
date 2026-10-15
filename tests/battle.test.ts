import test from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, CARD_MAP } from '../src/data.ts';
import type { Affinity } from '../src/data.ts';
import { actBattle, affinityMultiplier, combatDistance, createBattle, DEFAULT_BATTLE_SLOTS, getCombatStats, getOvertimeModifiers, getSynergies } from '../src/battle.ts';
import type { BattleAction, BattleCard, BattleFrame, BattleOptions, BattleState, CombatRole, CombatUnit, Synergy } from '../src/battle.ts';

function card(defId:string,rank=1,uid=defId,stars?:1|2|3):BattleCard {return {uid,defId,rank,best:0,...(stars?{stars}:{})};}
function team(defs=CARDS.slice(0,6).map(c=>c.id)):BattleCard[] {return defs.map((id,i)=>card(id,1,'card-'+i));}
function affinityTeam(affinity:Affinity,count=4):BattleCard[] {
  const chosen=CARDS.filter(c=>c.affinity===affinity).slice(0,count);
  chosen.push(...CARDS.filter(c=>c.affinity!==affinity).slice(0,6-count));return team(chosen.map(c=>c.id));
}
function active(list:Synergy[],id:string):boolean {return list.some(s=>s.id===id&&s.active);}
function findUnit(player:CombatUnit[],enemy:CombatUnit[],id:string):CombatUnit {return [...player,...enemy].find(u=>u.id===id)!;}
function actorId(frame:BattleFrame):string {return frame.logs.find(l=>l.kind==='skill'||l.kind==='attack'||l.kind==='move')!.actorId!;}
function beforeFrame(battle:BattleState,index:number) {return index===0?battle:battle.frames[index-1];}
function decimal(value:number):number {return Math.round(value*10)/10;}
function powers(unit:CombatUnit):number[] {return [...unit.skillDescription.matchAll(/(\d+(?:\.\d+)?)%/g)].map(match=>Number(match[1])/100);}
function assertBounds(battle:BattleState):void {
  assert.equal(battle.version,3);assert.equal(battle.status,'playing');assert.equal(battle.round,1);
  assert.equal(battle.maxRounds,32);assert.ok(battle.player.length>=1&&battle.player.length<=6);assert.ok(battle.enemy.length>=1&&battle.enemy.length<=6);
  assert.ok(battle.frames.length>0&&battle.frames.length<=400);
  const ids=[...battle.logs,...battle.frames.flatMap(f=>f.logs)].map(l=>l.id);
  assert.equal(new Set(ids).size,ids.length);assert.deepEqual(ids,Array.from({length:ids.length},(_,i)=>i+1));
  for(const [index,frame] of battle.frames.entries()){
    assert.equal(frame.tick,index+1);assert.ok(frame.round>=1&&frame.round<=battle.maxRounds);
    const live=[...frame.player,...frame.enemy].filter(u=>u.hp>0);assert.equal(new Set(live.map(u=>u.row*7+u.col)).size,live.length);
    assert.ok(!frame.logs.some(l=>l.kind==='heal'),'五职业不应产生已移除的治疗机制');
    for(const [side,units] of [['player',frame.player],['enemy',frame.enemy]] as const){
      assert.equal(units.length,battle[side].length);assert.equal(new Set(units.map(u=>u.cardUid)).size,units.length);
      for(const unit of units){
        assert.ok(Number.isInteger(unit.hp)&&unit.hp>=0&&unit.hp<=unit.maxHp);
        assert.ok(Number.isInteger(unit.shield)&&unit.shield>=0&&unit.shield<=unit.maxHp);
        assert.ok(Number.isInteger(unit.energy)&&unit.energy>=0&&unit.energy<=100);
        assert.ok(Number.isInteger(unit.row)&&unit.row>=0&&unit.row<8);assert.ok(Number.isInteger(unit.col)&&unit.col>=0&&unit.col<7);
        assert.ok(Number.isInteger(unit.range)&&unit.range>=1&&unit.range<=4);assert.ok(Number.isInteger(unit.slot)&&unit.slot>=0&&unit.slot<28);
        assert.ok([1,2,3].includes(unit.stars));assert.equal(unit.cooldown,0);assert.ok(unit.speed>0&&unit.armor>=0&&unit.resistance>=0);
        if(unit.hp===0)assert.equal(unit.shield,0);
        const before=beforeFrame(battle,index)[side].find(u=>u.id===unit.id)!;
        assert.equal(unit.slot,before.slot);if(before.hp===0)assert.equal(unit.hp,0);
      }
    }
  }
  const final=battle.frames.at(-1)!;assert.equal(battle.frames.flatMap(f=>f.logs).filter(l=>l.kind==='result').length,1);
  assert.ok(final.logs.some(l=>l.kind==='result'));
  if(battle.reason==='elimination'){
    assert.equal(battle.outcome,final.player.some(u=>u.hp>0)?'won':'lost');
    assert.ok(final.player.every(u=>u.hp===0)||final.enemy.every(u=>u.hp===0));
  }else{
    assert.equal(battle.reason,'round-limit');assert.equal(final.round,battle.maxRounds);
    const ratio=(units:CombatUnit[])=>units.reduce((n,u)=>n+u.hp,0)/units.reduce((n,u)=>n+u.maxHp,0);
    assert.equal(battle.outcome,ratio(final.player)>ratio(final.enemy)?'won':'lost');
  }
}

test('同阵容、种子、星级、人数与站位可完整重放，输入不变',()=>{
  const cards=team(),slots=[0,3,6,21,24,27],options={enemyCount:4},before=structuredClone({cards,slots,options});
  const a=createBattle(cards,42,slots,options);assert.deepEqual(a,createBattle(cards,42,slots,options));assert.deepEqual({cards,slots,options},before);
  assert.equal(a.status,'playing');assert.ok(a.player.every(u=>u.hp===u.maxHp));
  assert.notEqual(a.id,createBattle(cards,43,slots,options).id);
  assert.notEqual(a.id,createBattle(cards,42,slots,{enemyCount:5}).id);
});

test('支持 1–6 人且默认敌我人口相同，非法人数被拒绝',()=>{
  for(let count=1;count<=6;count++){
    const battle=createBattle(team().slice(0,count),count);assert.equal(battle.player.length,count);assert.equal(battle.enemy.length,count);
    assert.deepEqual(battle.player.map(u=>u.slot),DEFAULT_BATTLE_SLOTS.slice(0,count));assertBounds(battle);
  }
  assert.throws(()=>createBattle([],1));assert.throws(()=>createBattle([...team(),card('star-deer')],1));
});

test('允许同定义不同实例同时上阵，但重复 uid 永远被拒绝',()=>{
  const copies=[card('moon-deer',1,'a'),card('moon-deer',1,'b')],battle=createBattle(copies,3);
  assert.equal(battle.player.length,2);assert.ok(battle.synergies.player.every(s=>!s.active));
  assert.throws(()=>createBattle([copies[0],copies[0]],3),/实例/);
});

test('敌方人口可独立指定 1–6，升人口不会同步给对方加人',()=>{
  const small=createBattle(team().slice(0,2),42,undefined,{enemyCount:3}),large=createBattle(team(),42,undefined,{enemyCount:3});
  assert.equal(small.enemy.length,3);assert.equal(large.enemy.length,3);assert.equal(small.player.length,2);assert.equal(large.player.length,6);
  assert.deepEqual(small.enemy,large.enemy);
  for(const count of [1,6])assert.equal(createBattle(team().slice(0,3),1,undefined,{enemyCount:count}).enemy.length,count);
  for(const count of [null,0,7,-1,.5,'3',NaN,Infinity])assert.throws(()=>createBattle(team(),1,undefined,{enemyCount:count} as BattleOptions));
  for(const value of [null,[],1,{other:1}])assert.throws(()=>createBattle(team(),1,undefined,value as BattleOptions));
});

test('卡牌、永久等级、局内星级和种子严格校验',()=>{
  for(const id of ['missing','constructor','__proto__'])assert.throws(()=>getCombatStats(card(id)));
  for(const rank of [0,6,-1,1.5,NaN,Infinity])assert.throws(()=>getCombatStats(card('moon-fawn',rank)));
  for(const stars of [null,0,4,-1,1.5,'2',NaN])assert.throws(()=>getCombatStats({...card('moon-fawn'),stars} as BattleCard));
  for(const uid of ['', 'x'.repeat(129)])assert.throws(()=>getCombatStats(card('moon-fawn',1,uid)));
  for(const seed of [-1,.5,NaN,Infinity,0x100000000])assert.throws(()=>createBattle(team(),seed));
  assert.throws(()=>createBattle(new Array(3),1));assert.doesNotThrow(()=>createBattle(team(),0xffffffff));
});

test('站位与人口等长，唯一的 0–27 整数格位；拒绝重复、越界和稀疏数组',()=>{
  const invalid:unknown[]=[[],[0,1],[0,1,2,3],[0,1,1],[-1,1,2],[28,1,2],[.5,1,2],[NaN,1,2],['0',1,2],null,{},[0,1,,]];
  for(const slots of invalid)assert.throws(()=>createBattle(team().slice(0,3),1,slots as number[]));
  assert.doesNotThrow(()=>createBattle(team().slice(0,3),1,[0,20,27]));
});

test('4×7 部署映射 8×7 六边形战场，错列格位与六边形距离真实对应',()=>{
  const battle=createBattle(team(),1,[0,6,7,20,21,27]);
  for(const unit of battle.player){assert.equal(unit.row,4+Math.floor(unit.slot/7));assert.equal(unit.col,unit.slot%7);}
  for(const unit of battle.enemy){assert.equal(unit.row,3-Math.floor(unit.slot/7));assert.equal(unit.col,unit.slot%7);}
  assert.equal(new Set([...battle.player,...battle.enemy].map(u=>u.row*7+u.col)).size,12);
  // 六边形距离：相邻为 1；错列后斜向相邻也是 1，同列隔行为 2。
  assert.equal(combatDistance({row:4,col:3},{row:3,col:3}),1);
  assert.equal(combatDistance({row:4,col:3},{row:3,col:2}),1);
  assert.equal(combatDistance({row:4,col:3},{row:4,col:5}),2);
  assert.equal(combatDistance({row:4,col:3},{row:2,col:3}),2);
  assert.equal(combatDistance({row:0,col:0},{row:7,col:6}),10);
});

const BASES:[string,CombatRole,number,number,number,number,number,number][]=[
  ['moon-deer','坦克',180,14,45,35,1,40],['forest-rabbit','战士',145,23,28,20,1,55],
  ['sun-cub','射手',100,24,12,15,4,78],['sun-fox','法师',95,22,12,25,3,50],
  ['forest-sprout','法师',95,22,12,25,3,50],['moon-fawn','刺客',105,28,15,15,1,90],
];
for(const [id,role,hp,attack,armor,resistance,range,speed] of BASES)
  test('职业基准精确匹配：'+id,()=>{
    const stats=getCombatStats(card(id));assert.deepEqual([stats.role,stats.hp,stats.attack,stats.armor,stats.resistance,stats.range,stats.speed],[role,hp,attack,armor,resistance,range,speed]);
  });

test('36 个独立技能名、五职业与五种视觉效果，没有医师辅助',()=>{
  const stats=CARDS.map(def=>getCombatStats(card(def.id)));
  assert.equal(new Set(stats.map(s=>s.skillName)).size,CARDS.length);
  assert.deepEqual(new Set(stats.map(s=>s.role)),new Set(['坦克','战士','射手','法师','刺客']));
  assert.deepEqual(new Set(stats.map(s=>s.effect)),new Set(['shield','slash','projectile','blast','dash']));
  assert.ok(stats.every(s=>s.skillDescription&&s.range>=1&&s.range<=4));
});

test('品质每阶 4% 生命、3% 攻击与 3% 技能系数，局内★每星 12%/8%，只计算一次',()=>{
  for(const def of CARDS){
    const base=getCombatStats(card(def.id));
    for(const rank of [1,2,3,4,5])for(const stars of [1,2,3] as const){
      const stats=getCombatStats(card(def.id,rank,'test',stars));
      assert.equal(stats.hp,Math.round(base.hp*(1+(rank-1)*.04)*(1+(stars-1)*.12)));
      assert.equal(stats.attack,decimal(base.attack*(1+(rank-1)*.03)*(1+(stars-1)*.08)));
      assert.equal(stats.skillPower,Number((base.skillPower*(1+(rank-1)*.03)).toFixed(4)));
      assert.equal(stats.skillSecondary,Number((base.skillSecondary*(1+(rank-1)*.03)).toFixed(4)));
      for(const key of ['range','armor','resistance','speed','skillName','effect'] as const)assert.equal(stats[key],base[key]);
    }
    assert.deepEqual(base,getCombatStats(card(def.id,1,'other',1)));
  }
  assert.ok(getCombatStats(card('sun-fox',5)).skillPower>getCombatStats(card('sun-fox',1)).skillPower);
  const battle=createBattle([card('sun-cub',2,'a',3)],8);assert.equal(battle.player[0].stars,3);assert.equal(battle.player[0].rank,2);
  assert.ok(battle.enemy.every(u=>u.stars===1));
});

test('局内星级改变真实战斗属性与回放 id，不影响羁绊人数',()=>{
  const a=[card('sun-cub',1,'a',1)],b=[card('sun-cub',1,'a',3)],low=createBattle(a,42),high=createBattle(b,42);
  assert.notEqual(low.id,high.id);assert.ok(high.player[0].hp>low.player[0].hp&&high.player[0].attack>low.player[0].attack);
  assert.deepEqual(low.synergies,high.synergies);assert.deepEqual(low.enemy,high.enemy);
});

test('羁绊预览 0–6 人，五职业共 11 条，重复定义不凑羁绊',()=>{
  const empty=getSynergies([]);assert.equal(empty.length,11);assert.ok(empty.every(s=>s.count===0&&!s.active));
  const duplicate=getSynergies([card('moon-deer',1,'a'),card('moon-deer',2,'b',3)]);
  assert.equal(duplicate.find(s=>s.id==='role-tank')!.count,1);assert.ok(duplicate.every(s=>!s.active));
  for(let n=0;n<=6;n++)assert.doesNotThrow(()=>getSynergies(team().slice(0,n)));
  assert.throws(()=>getSynergies([...team(),card('star-deer')]));
});

for(const affinity of ['moon','sun','forest'] as const)
  test(affinity+' 的 2/4 属性羁绊真实生效，4 人替代 2 人加成',()=>{
    for(const count of [1,2,4,6]){
      const cards=affinityTeam(affinity,count),list=getSynergies(cards),battle=createBattle(cards,count);
      assert.equal(list.find(s=>s.id==='affinity-'+affinity+'-2')!.active,count>=2);
      assert.equal(list.find(s=>s.id==='affinity-'+affinity+'-4')!.active,count>=4);
      for(const unit of battle.player.filter(u=>u.affinity===affinity)){
        const base=getCombatStats(card(unit.defId,unit.rank));
        if(affinity==='moon'){
          const hp=Math.round(base.hp*(unit.role==='坦克'&&active(list,'role-tank')?1.08:1));
          assert.equal(unit.maxHp,hp);assert.equal(unit.shield,Math.round(hp*(count>=4?.25:count>=2?.12:0)));
        }
        if(affinity==='sun')assert.equal(unit.attack,decimal(base.attack*(count>=4?1.18:count>=2?1.08:1)));
        if(affinity==='forest')assert.equal(unit.maxHp,Math.round(base.hp*(count>=4?1.22:count>=2?1.1:1)));
      }
    }
  });

test('双坦克和双战士加成只作用于对应职业',()=>{
  const moon=createBattle(affinityTeam('moon'),7),forest=createBattle(affinityTeam('forest'),7);
  for(const unit of moon.player.filter(u=>u.role==='坦克'))assert.equal(unit.maxHp,Math.round(getCombatStats(card(unit.defId)).hp*1.08));
  for(const unit of forest.player.filter(u=>u.role==='战士'))assert.equal(unit.attack,decimal(getCombatStats(card(unit.defId)).attack*1.12));
  for(const unit of forest.player.filter(u=>u.role==='法师'))assert.equal(unit.attack,getCombatStats(card(unit.defId)).attack);
});

test('月克日、日克森、森克月：正向 1.25 倍，逆向 0.85 倍，同色 1 倍',()=>{
  for(const [a,b] of [['moon','sun'],['sun','forest'],['forest','moon']] as [Affinity,Affinity][]){
    assert.equal(affinityMultiplier(a,b),1.25);assert.equal(affinityMultiplier(b,a),.85);assert.equal(affinityMultiplier(a,a),1);
  }
});

const cases=[...Array.from({length:10},(_,seed)=>createBattle(team(),seed)),
  ...(['moon','sun','forest'] as const).flatMap(affinity=>[11,29].map(seed=>createBattle(affinityTeam(affinity),seed))),
  createBattle(team(['moon-fawn','mist-deer','sun-cub','dawn-fox','sun-fox','moon-deer']),101),
  createBattle(team(),42,[21,22,23,24,25,26]),createBattle(team(),43,[0,1,2,3,4,5]),
  ...Array.from({length:8},(_,seed)=>createBattle([card('moon-deer')],seed))];
function steps() {
  return cases.flatMap(battle=>battle.frames.map((frame,index)=>{
    const before=beforeFrame(battle,index),id=actorId(frame),actor=findUnit(before.player,before.enemy,id),side:'player'|'enemy'=id.startsWith('player-')?'player':'enemy';
    const attackPosition=frame.logs.some(l=>l.movement==='blink')?findUnit(frame.player,frame.enemy,id):actor;
    return {battle,frame,before,actor,side,attackPosition};
  }));
}

test('按速度和部署顺序自动执行，每单位每轮一次，死者跳过',()=>{
  for(const battle of cases)for(let round=1;round<=battle.maxRounds;round++){
    const indexes=battle.frames.map((frame,index)=>({frame,index})).filter(x=>x.frame.round===round);if(!indexes.length)continue;
    const before=beforeFrame(battle,indexes[0].index),preferred=(battle.seed+round)%2===0?'player':'enemy';
    const order=[...before.player,...before.enemy].filter(u=>u.hp>0).sort((a,b)=>b.speed-a.speed||a.slot-b.slot||
      (a.id.split('-')[0]===b.id.split('-')[0]?0:a.id.startsWith(preferred)?-1:1)).map(u=>u.id);
    const actors=indexes.map(({frame,index})=>{const id=actorId(frame),old=beforeFrame(battle,index);assert.ok(findUnit(old.player,old.enemy,id).hp>0);return id;});
    assert.equal(new Set(actors).size,actors.length);const positions=actors.map(id=>order.indexOf(id));assert.deepEqual(positions,[...positions].sort((a,b)=>a-b));
  }
});

test('普通移动至多一格，不穿越单位、不与攻击同时发生，射程外才移动',()=>{
  let moved=0;
  for(const {frame,before,actor} of steps()){
    const move=frame.logs.find(l=>l.movement==='walk'),blink=frame.logs.some(l=>l.movement==='blink'),after=findUnit(frame.player,frame.enemy,actor.id);
    if(blink)continue;
    if(move){
      assert.ok(combatDistance(actor,findUnit(before.player,before.enemy,move.targetId!))>actor.range);
      assert.equal(combatDistance(actor,after),move.amount);assert.ok(move.amount===0||move.amount===1);
      assert.ok(!frame.logs.some(l=>l.kind==='attack'||l.kind==='skill'));assert.equal(after.energy,actor.energy);
      if(move.amount===1){assert.ok(![...before.player,...before.enemy].some(u=>u.hp>0&&u.id!==actor.id&&u.row===after.row&&u.col===after.col));moved++;}
    }else assert.equal(combatDistance(actor,after),0);
  }
  assert.ok(moved>0);
});

test('刺客首行动跳入后排空格，至多跳一次且不与存活单位重叠',()=>{
  let count=0;
  for(const battle of cases){
    const jumped=new Set<string>();
    for(const [index,frame] of battle.frames.entries())for(const event of frame.logs.filter(l=>l.movement==='blink')){
      const before=beforeFrame(battle,index),actor=findUnit(before.player,before.enemy,event.actorId!),after=findUnit(frame.player,frame.enemy,event.actorId!);
      assert.equal(actor.role,'刺客');assert.equal(frame.round,1);assert.ok(!jumped.has(actor.id));jumped.add(actor.id);
      assert.ok(![...before.player,...before.enemy].some(u=>u.hp>0&&u.id!==actor.id&&u.row===after.row&&u.col===after.col));count++;
    }
  }
  assert.ok(count>0);
});

test('有盾坦克优先吸引两格内的普攻；没有近坦时优先最近目标',()=>{
  let taunted=0,basic=0;
  for(const {frame,before,actor,side,attackPosition} of steps()){
    if(frame.logs.some(l=>l.kind==='skill')||!frame.logs.some(l=>l.kind==='attack'))continue;
    const enemies=before[side==='player'?'enemy':'player'].filter(u=>u.hp>0),target=enemies.find(u=>u.id===frame.logs.find(l=>l.kind==='attack')!.targetId)!;
    const tanks=enemies.filter(u=>u.role==='坦克'&&u.shield>0&&combatDistance(attackPosition,u)<=2);
    if(tanks.length){assert.ok(tanks.some(u=>u.id===target.id));taunted++;}
    else assert.equal(combatDistance(attackPosition,target),Math.min(...enemies.map(u=>combatDistance(attackPosition,u))));
    assert.ok(combatDistance(attackPosition,target)<=actor.range);basic++;
  }
  assert.ok(taunted>0&&basic>0);
});

test('普攻与战士/射手/刺客技能按护甲，仅法师技能按法抗',()=>{
  let physical=0,magic=0,mitigated=0;
  for(const {battle,frame,before,actor,side} of steps()){
    const skill=frame.logs.some(l=>l.kind==='skill'),hits=frame.logs.filter(l=>l.kind==='attack'),working=new Map<string,{hp:number;shield:number}>();
    for(const [index,event] of hits.entries()){
      const target=findUnit(before.player,before.enemy,event.targetId!);if(!working.has(target.id))working.set(target.id,{hp:target.hp,shield:target.shield});
      const values=working.get(target.id)!;let power=1;
      if(skill){
        power=powers(actor)[['法师','战士'].includes(actor.role)&&index>0?1:0];
        if(actor.role==='法师'&&active(battle.synergies[side],'role-mage'))power*=1.15;
        if(actor.role==='刺客'&&active(battle.synergies[side],'role-assassin'))power*=1.15;
      }
      const magicSkill=skill&&actor.role==='法师',defense=magicSkill?target.resistance:target.armor,raw=actor.attack*power*affinityMultiplier(actor.affinity,target.affinity),damage=Math.max(1,Math.round(raw*100/(100+defense)*(1+Math.max(0,frame.round-16)*.08)));
      const blocked=Math.min(values.shield,damage),loss=Math.min(values.hp,damage-blocked);values.shield-=blocked;values.hp-=loss;
      assert.equal(event.damageType,magicSkill?'magic':'physical');assert.equal(event.amount,loss);if(magicSkill)magic++;else physical++;if(Math.round(raw)>damage&&loss>0)mitigated++;
    }
  }
  assert.ok(physical>0&&magic>0&&mitigated>0);
});

test('攻击、受击自动攒能，双射手额外加能；满能自动技能且移动不加能',()=>{
  let skills=0,bonuses=0;
  for(const {battle,frame,before,actor,side} of steps()){
    const after=findUnit(frame.player,frame.enemy,actor.id),skill=frame.logs.some(l=>l.kind==='skill'),attacks=frame.logs.filter(l=>l.kind==='attack');
    if(skill){assert.equal(actor.energy,100);assert.equal(after.energy,0);skills++;}
    else if(attacks.length){
      assert.ok(actor.energy<100);const bonus=actor.role==='射手'&&active(battle.synergies[side],'role-marksman')?10:0;
      assert.equal(after.energy,Math.min(100,actor.energy+35+bonus));if(bonus)bonuses++;
    }else assert.equal(after.energy,actor.energy);
    for(const id of new Set(attacks.map(l=>l.targetId!))){
      const old=findUnit(before.player,before.enemy,id),next=findUnit(frame.player,frame.enemy,id),hits=attacks.filter(l=>l.targetId===id);
      assert.equal(next.energy,Math.min(100,old.energy+10*hits.filter(hit=>(hit.amount??0)>0).length));assert.equal(old.hp-next.hp,hits.reduce((n,l)=>n+(l.amount??0),0));
    }
  }
  assert.ok(skills>0&&bonuses>0);
});

test('坦克按最大生命比例开盾并受护盾上限约束',()=>{
  let count=0;
  for(const {frame,actor} of steps()){
    if(actor.role!=='坦克'||!frame.logs.some(l=>l.kind==='skill'))continue;
    const event=frame.logs.find(l=>l.kind==='shield')!;assert.equal(event.targetId,actor.id);
    assert.equal(event.amount,Math.min(actor.maxHp-actor.shield,Math.round(actor.maxHp*powers(actor)[0]*Math.max(.2,1-Math.max(0,frame.round-16)*.05))));
    assert.ok(!frame.logs.some(l=>l.kind==='attack'));count++;
  }
  assert.ok(count>0);
});

test('战士横扫自身邻格，法师爆发目标邻格；散开可避免范围波及',()=>{
  let warrior=0,mage=0;
  for(const {frame,before,actor,side,attackPosition} of steps()){
    if(!['战士','法师'].includes(actor.role)||!frame.logs.some(l=>l.kind==='skill'))continue;
    const enemies=before[side==='player'?'enemy':'player'],hits=frame.logs.filter(l=>l.kind==='attack'),primary=enemies.find(u=>u.id===hits[0].targetId)!;
    assert.ok(combatDistance(attackPosition,primary)<=actor.range);
    const center=actor.role==='战士'?attackPosition:primary,neighbors=enemies.filter(u=>u.hp>0&&u.id!==primary.id&&combatDistance(center,u)<=1);
    assert.deepEqual(hits.slice(1).map(l=>l.targetId),neighbors.map(u=>u.id));if(actor.role==='战士')warrior++;else mage++;
  }
  assert.ok(warrior>0&&mage>0);
});

test('射手技能连射并在后排部署时优先狙击后排，仍遵守射程',()=>{
  let count=0;
  for(const {frame,before,actor,side,attackPosition} of steps()){
    if(actor.role!=='射手'||!frame.logs.some(l=>l.kind==='skill'))continue;
    const enemies=before[side==='player'?'enemy':'player'],hits=frame.logs.filter(l=>l.kind==='attack'),target=enemies.find(u=>u.id===hits[0].targetId)!;
    assert.ok(hits.length===1||hits.length===2);assert.ok(hits.every(l=>l.targetId===target.id));assert.ok(combatDistance(attackPosition,target)<=actor.range);
    if(actor.slot>=14&&enemies.some(u=>u.hp>0&&u.slot>=14))assert.ok(target.slot>=14);
    if(hits.length===1)assert.equal(findUnit(frame.player,frame.enemy,target.id).hp,0);count++;
  }
  assert.ok(count>0);
});

test('刺客技能为单点爆发，双刺客加成已纳入伤害计算',()=>{
  let count=0,bonded=0;
  for(const {battle,frame,before,actor,side,attackPosition} of steps()){
    if(actor.role!=='刺客'||!frame.logs.some(l=>l.kind==='skill'))continue;
    const hits=frame.logs.filter(l=>l.kind==='attack');assert.equal(hits.length,1);
    assert.ok(combatDistance(attackPosition,findUnit(before.player,before.enemy,hits[0].targetId!))<=actor.range);
    if(active(battle.synergies[side],'role-assassin'))bonded++;count++;
  }
  assert.ok(count>0&&bonded>0);
});

test('帧数最多 400，日志唯一，各帧与开场对象不共享引用',()=>{
  for(const battle of cases)assertBounds(battle);
  const battle=createBattle(team(),42),openingHp=battle.player[0].hp,nextHp=battle.frames[1].player[0].hp;
  battle.frames[0].player[0].hp=0;assert.equal(battle.player[0].hp,openingHp);assert.equal(battle.frames[1].player[0].hp,nextHp);
});

test('调整站位改变路径与回放，不改变阵容羁绊或同种子敌人',()=>{
  const a=createBattle(team(),42),b=createBattle(team(),42,[21,23,25,0,3,6]);
  assert.deepEqual(a.synergies,b.synergies);assert.deepEqual(a.enemy,b.enemy);assert.notEqual(a.id,b.id);assert.notDeepEqual(a.frames,b.frames);
});

test('resolve 取最终帧，重复结算、旧版战斗、手动招式及额外伪造字段均拒绝',()=>{
  const battle=createBattle(team(),42),before=structuredClone(battle),last=battle.frames.at(-1)!,result=actBattle(battle,{type:'resolve'});
  assert.deepEqual(battle,before);assert.equal(result.status,battle.outcome);assert.equal(result.revision,1);
  assert.equal(result.round,last.round);assert.deepEqual(result.player,last.player);assert.deepEqual(result.enemy,last.enemy);assert.deepEqual(result.logs,last.logs);
  assert.throws(()=>actBattle(result,{type:'resolve'}));
  for(const action of [null,{}, {type:'attack',actorId:'player-0'}, {type:'resolve',outcome:'won'}])assert.throws(()=>actBattle(battle,action as BattleAction));
  assert.throws(()=>actBattle({...battle,version:1} as unknown as BattleState,{type:'resolve'}));assert.throws(()=>actBattle({...battle,frames:[]},{type:'resolve'}));
  result.player[0].row=0;assert.deepEqual(battle,before);
});

test('无货币奖励与实时时间副作用，保存与重载后结算相同',()=>{
  const battle=createBattle(team(),11),result=actBattle(battle,{type:'resolve'});
  for(const value of [battle,result]){
    for(const key of ['coins','dust','tickets','rewards','createdAt','completedAt'])assert.ok(!(key in value));
    assert.deepEqual(JSON.parse(JSON.stringify(value)),value);
  }
});

test('全部 36 卡、局内星级与可变人口均可完成战斗',()=>{
  for(const [index,def] of CARDS.entries()){
    const battle=createBattle([card(def.id,index%3+1,'a',(index%3+1) as 1|2|3)],index,undefined,{enemyCount:index%3+1});
    assertBounds(battle);assert.notEqual(actBattle(battle,{type:'resolve'}).status,'playing');
  }
});

for(const seed of [0,1,7,29,42,77,65535,0xffffffff])
  test('多种子、星级、人口与站位完整回放：'+seed,()=>{
    const count=seed%6+1,cards=Array.from({length:count},(_,i)=>card(CARDS[(seed+i*5)%CARDS.length].id,(seed+i)%3+1,'p-'+i,((seed+i)%3+1) as 1|2|3));
    const slots=Array.from({length:count},(_,i)=>(seed+i*5)%28),options={enemyCount:(seed+2)%6+1},battle=createBattle(cards,seed,slots,options);
    assertBounds(battle);assert.deepEqual(battle,createBattle(cards,seed,slots,options));
    assert.deepEqual(actBattle(battle,{type:'resolve'}),actBattle(JSON.parse(JSON.stringify(battle)) as BattleState,{type:'resolve'}));
  });

test('坦克盾系数缩至原值 65%，技能短句与双坦 8% 文案为真实数值',()=>{
  const expected:[string,number][]=[['moon-deer',19.5],['star-deer',18.85],['crescent-dancer',18.2],['moon-soloist',22.1],['eclipse-deer',20.15],['starlit-arch',18.85],['comet-tail',19.5]];
  for(const [id,percent] of expected)assert.ok(getCombatStats(card(id)).skillDescription.includes(percent+'%'));
  const bonds=getSynergies([card('moon-deer'),card('star-deer')]);assert.equal(bonds.find(s=>s.id==='role-tank')!.description,'坦克最大生命 +8%。');
});

test('护盾完全吸收时不回受击能量，只要实际掉血才每次加 10',()=>{
  let fullyBlocked=0,damaged=0;
  for(const {frame,before} of steps()){
    const attacks=frame.logs.filter(l=>l.kind==='attack');
    for(const id of new Set(attacks.map(l=>l.targetId!))){
      const old=findUnit(before.player,before.enemy,id),next=findUnit(frame.player,frame.enemy,id),hits=attacks.filter(l=>l.targetId===id);
      const hurt=hits.filter(l=>(l.amount??0)>0).length;
      assert.equal(next.energy,Math.min(100,old.energy+10*hurt));
      if(hurt===0&&old.energy<100){assert.equal(next.energy,old.energy);fullyBlocked++;}
      if(hurt>0&&old.energy<100)damaged++;
    }
  }
  assert.ok(fullyBlocked>0&&damaged>0);
});

test('决战从第 17 轮开始：每轮线性增伤 8%、新盾减少 5%，新盾最低 20%',()=>{
  assert.deepEqual(getOvertimeModifiers(1),{damage:1,shield:1});assert.deepEqual(getOvertimeModifiers(16),{damage:1,shield:1});
  assert.deepEqual(getOvertimeModifiers(17),{damage:1.08,shield:.95});assert.deepEqual(getOvertimeModifiers(18),{damage:1.16,shield:.9});
  assert.deepEqual(getOvertimeModifiers(32),{damage:2.28,shield:.2});assert.equal(getOvertimeModifiers(100).shield,.2);
  for(const invalid of [0,-1,1.5,NaN])assert.throws(()=>getOvertimeModifiers(invalid));
});

test('决战增伤减盾参与真实战斗，并逐轮记录简短说明',()=>{
  const battle=createBattle([card('moon-deer')],1);let attacks=0,shields=0;
  assert.ok(battle.frames.at(-1)!.round>=17);
  for(const [index,frame] of battle.frames.entries()){
    if(frame.round<17)continue;
    const before=beforeFrame(battle,index),actor=findUnit(before.player,before.enemy,actorId(frame));
    const multiplier=getOvertimeModifiers(frame.round);
    for(const event of frame.logs){
      if(event.kind==='attack'){
        const target=findUnit(before.player,before.enemy,event.targetId!),damage=Math.round(actor.attack*100/(100+target.armor)*multiplier.damage);
        assert.equal(event.amount,Math.min(target.hp,Math.max(0,damage-target.shield)));attacks++;
      }
      if(event.kind==='shield'){assert.equal(event.amount,Math.min(actor.maxHp-actor.shield,Math.round(actor.maxHp*.195*multiplier.shield)));shields++;}
    }
  }
  for(const round of new Set(battle.frames.filter(f=>f.round>=17).map(f=>f.round))){
    const events=battle.frames.filter(f=>f.round===round).flatMap(f=>f.logs);
    assert.equal(events.filter(l=>l.kind==='round'&&l.text.startsWith('决战：')).length,1);
  }
  assert.ok(attacks>0&&shields>0);
});
