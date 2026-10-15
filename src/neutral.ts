// 野怪营地 → 中立战斗单位（供 duel-sim 消费）。
// 中立实体只有普攻 / 移动：不套用玩家职业羁绊、永久品质成长、开局护盾或图鉴掉落；
// 营地配置由规则版本与轮次决定，不随玩家平均品质 / 付费 / 连胜动态增强。
import { duelNeutralCamp, type NeutralCampDef } from './duel-rules.ts';

export interface NeutralUnitSpec {
  unitId: string; name: string;
  hp: number; attack: number; armor: number; resistance: number; range: number; speed: number;
  localSlot: number; // 中立方本地 slot，经与 B 侧相同的 180° 上半场映射落位
}
/** 展开营地配置：按怪物数量与 neutralLocalSlots 生成实例；同名怪物带 -1/-2 后缀。 */
export function buildNeutralUnits(round: number, camp?: NeutralCampDef): NeutralUnitSpec[] {
  const config = camp ?? duelNeutralCamp(round);
  const units: NeutralUnitSpec[] = [];
  for (const monster of config.monsters) {
    if (monster.neutralLocalSlots.length !== monster.count) throw new Error('营地站位配置与数量不一致：' + monster.id);
    monster.neutralLocalSlots.forEach((slot, index) => {
      units.push({
        unitId: 'neutral:' + config.id + ':' + monster.id + ':' + index,
        name: monster.count > 1 ? monster.name + '·' + (index + 1) : monster.name,
        hp: monster.stats.hp, attack: monster.stats.attack, armor: monster.stats.armor,
        resistance: monster.stats.resistance, range: monster.stats.range, speed: monster.stats.initiative,
        localSlot: slot,
      });
    });
  }
  return units;
}
