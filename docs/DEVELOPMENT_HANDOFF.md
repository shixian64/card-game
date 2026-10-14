# 星序 ASTERIA｜开发规格与技术交接文档

> 更新日期：2026-10-14（Asia/Shanghai）  
> 用途：交给其他模型或开发者，在现有代码上继续开发，而不是重新做一套。  
> 当前阶段：可本地试玩的全栈原型；不是已正式上线、已完成平衡的商业游戏。  
> 当前包版本：`0.3.0`，版本号尚未反映全部后续功能。  
> 本次交接核验：`npm test` **407 / 407 通过**，`npm run build` 通过。

## 阅读导航

- 先接手项目：第 1～4 节、第 18～21 节。
- 改玩法或数值：第 5～9 节、第 16～17 节。
- 改界面：第 10 节、第 15 节。
- 改市场、社交、账户：第 11～14 节。
- 开发任务安排：第 20 节。
- 直接交给下一模型：[NEXT_MODEL_PROMPT.md](NEXT_MODEL_PROMPT.md)。

本文中的“已实现”表示当前代码有实现，不等于生产已验收。后续建议均单独标记，不能当成已经存在的功能。源码变化后，应同步修订本文；运行行为与本文不一致时，先复现，再核对源码和测试。

---

## 1. 项目位置、现状与接手注意事项

### 1.1 本地目录

| 内容 | 当前绝对路径 |
| --- | --- |
| 外层工作目录 | `D:\project\game\game-1011` |
| 真正应用 / Git 根目录 | `D:\project\game\game-1011\web` |
| 本文 | `D:\project\game\game-1011\web\docs\DEVELOPMENT_HANDOFF.md` |
| 持久数据库默认位置 | `D:\project\game\game-1011\web\data\asteria.sqlite` |
| 截图、测试与平衡证据 | `D:\project\game\game-1011\artifacts` |
| 较早设计文档 | `D:\project\game\game-1011\docs` |

以下代码目录以 **web 为基准**书写；迁移到其他机器时替换上述根路径即可。

注意：外层目录不是 Git 仓库。当前大量功能仍处于修改 / 未跟踪状态，**不能执行 `git reset --hard`、`git clean`，也不能只打包 Git 已跟踪文件**。交接前先在 web 内执行 `git status --short`，保全整个工作树。不要把数据库、`.env` 或密钥提交到仓库。

### 1.2 当前本地服务

| 地址 | 用途 | 数据性质 |
| --- | --- | --- |
| `http://127.0.0.1:3000/` | 推荐的本地游戏入口 | SQLite 持久化 |
| `http://127.0.0.1:3000/admin` | 本地管理后台 | A 账号为管理员 |
| `http://localhost:3001/` | 上一轮界面验收 / 用户当前预览 | 独立 QA，使用内存数据库，重启丢失 |

本次交接时 3000 / 3001 均监听在 `127.0.0.1`，健康接口可访问。以上是交接时状态，不保证后续进程始终存在。不要为了换端口或测试直接杀掉正在供用户试玩的服务。

### 1.3 最重要的真实边界

- 当前是 **10 分钟经营 + 卡牌站位自动战斗的 PvE**，敌人是电脑。
- 不是实时 PvP；没有八名真人房间、共享卡池、排名匹配、玩家生命淘汰或装备系统。
- 市场、赠送、好友、聊天和资产保存有后端，不是纯前端假数据。
- 目前有 **36 种卡牌配置，只有 6 幅基础星灵插画**；其他卡复用插画。
- ChatGPT 登录已有代码与配置入口，**没有真实 Client ID，未完成真实登录联调**。
- Docker / Caddy 配置已写，**尚未远程部署，也未完成 Docker 实机验收**。
- 代码留在本地，自托管到用户服务器；不要默认发布到之前的 Sites 私有站。

## 2. 产品方向与不可回退的用户决定

### 2.1 一句话定义

**收集星灵卡牌，用经营和站位组出好阵容，自动战斗获得资源，再强化、交换和收藏。**

重点体验是“组合发现”和“培养成果”，不依赖编写大量剧情。文案直接、操作清楚，不用长篇术语解释基础玩法。

### 2.2 已确认方向

1. 保留抽卡、长期养成、重复卡处理、自由交易。
2. 用户已否定早期算分培养，以及逐个点击普攻 / 技能的轮流战斗。
3. 采用参考金铲铲的站位自走棋：**棋子是卡牌，不做 3D 英雄角色**。
4. 真正的移动、射程、护甲、魔抗、技能和组合效果必须参与计算，不能只做视觉假动作。
5. 五职业：**坦克、战士、射手、法师、刺客**。前两者为前排，射手 / 法师为远程；不要悄悄加回旧医师、辅助、游侠、守护体系。
6. 一局约定为 **10 分钟**；当前实现固定 8 轮，不提前淘汰。
7. 局内经济借鉴利息、刷新、锁店、经验 / 人口、连胜连败、三同卡合星，不承诺复刻原作赛季规则。
8. 永久升级主要增强边框、光泽、动效与展示，属性只微量增强。
9. 收藏及详情插画不叠放左上等级、右上属性、右下 Lv 等角标；等级、稀有度、属性放在详情信息区。
10. 合成 / 分解页不显示未获得的卡；收藏页仍可主动开启“显示未拥有”。
11. 市场以交易列表、筛选、行情、记录为重点，不能退回纯卡片展示墙。
12. 对战全视口沉浸显示：场景铺满、固定 HUD、底部商店，不展示大厅网页侧栏。
13. 需要音效和动效，但不能让动效决定战果或经济结算。
14. 本地代码可部署到用户自己的服务器；账号权限和后台由服务端校验。

### 2.3 不是用户已批准的需求

装备、赛季通行证、付费、现金交易、拍卖竞价、订单簿、八人 PvP、复杂剧情、全新职业都**没有完成也没有自动获得实施授权**。可作为下一阶段提案，不应在没有说明的情况下大幅扩张范围。

## 3. 功能完成度矩阵

| 模块 | 当前实现 | 验证 / 限制 |
| --- | --- | --- |
| 收藏与详情 | 36 定义、筛选、稀有边框、永久等级信息 | 6 幅复用插画；没有 36 套独立美术 |
| 抽卡 / 强化 / 制作 / 分解 | 服务端更新永久资产 | 自动测试覆盖；没有跨包 SSR 保底 |
| 十分钟对局 | 服务器计时、8 轮、商店、人口、利息、合星 | 一整局实机走完；当前 PvE |
| 自动战斗 | 8×7 移动战场、五职业技能、羁绊、防御 | 确定性测试与 540 局冒烟；正式平衡未完成 |
| 沉浸对战 UI | 原创森林场景、下半区部署、固定 HUD / 商店 | 桌面与小横屏检查；不是所有手机 / 浏览器均已验收 |
| 音效 / 动效 | Web Audio、抽卡 / 强化 / 攻击 / 技能等效果 | 本地生成音，不是完整音频资产库或背景音乐系统 |
| 市场 | 上架、买入、撤单、分页、筛选、真实报价、历史 | A→B 交易实测；没有求购单 / 拍卖 / 批量撮合 |
| 赠送 | 按玩家编号转移卡牌 | 有确认，原子转移；不要求双方先成为好友 |
| 好友 / 聊天 | 申请、接受、拒绝、删除、世界 / 私聊 | 短轮询；无完备举报封禁、未读、在线状态 |
| 本地账号 | A / B / C、A 管理员 | 仅开发；不能当成真实 ChatGPT 账户 |
| ChatGPT 登录 | OAuth / OIDC 路由、安全校验、身份映射 | 缺真实注册客户端；未真实联调 |
| 管理后台 | 权威流水、市场 / 战斗 / 社交计数、周期筛选 | 基础监控；不是完整运营系统 |
| 自托管 | Node 服务、SQLite、Docker / Caddy 模板 | 未部署用户服务器；备份恢复 / 压测待做 |

## 4. 技术架构与代码地图

### 4.1 技术选型

- 前端：React 19 + TypeScript + Vite，Lucide 图标，普通 CSS。
- 后端：Node.js 原生 HTTP，ES Modules，`node:sqlite`。
- 身份验证：`jose` 验证 OpenID Connect ID token。
- 测试：Node 内置 test runner，直接运行 TS 纯规则测试和 `.mjs` 服务测试。
- 部署：单 Node 进程，同域提供 `dist` 和 API；可在 Caddy 后运行。
- 运行要求：**Node.js ≥24**；已在 Node `24.15.0` 验证。依赖实际版本由 `package-lock.json` 固定，安装用 `npm ci`。
- 不需要 Redis、外部数据库、模型 API 或外部音频服务才能本地试玩。

### 4.2 请求与状态流

```text
浏览器 React
  ├─ GET /api/auth/me → 当前会话 / 权限 / 登录可用性
  ├─ GET /api/game → 服务器快照 + 按时钟补齐对局阶段
  ├─ POST /api/game/* → 幂等操作 → 事务 → 新快照
  ├─ GET /api/market → SQL 筛选 / 行情 / 历史
  ├─ POST /api/market/* → 托管 / 扣款 / 转卡 / 流水同一事务
  └─ /api/social + /api/chat → 好友鉴权 / 消息

Node HTTP → 认证 / Origin / 身份绑定 / 限流
          → game.mjs / social.mjs
          → match.mjs / battle.ts / engine.ts
          → SQLite（资产、对局、挂单、幂等记录、账本、社交）
```

浏览器只负责输入、草稿和回放。**不接受浏览器上传余额、胜负或完整存档作为权威资产**。

### 4.3 当前文件职责

| 相对 web 路径 | 职责 |
| --- | --- |
| `src/main.tsx` | `/admin` → Admin；其余页面 → CombatApp |
| `src/CombatApp.tsx` | 大厅、收藏、抽卡、合成分解、详情、身份与资产快照协调 |
| `src/MatchArena.tsx` | 十分钟局 HUD、经营操作、阵容草稿、阶段计时、全屏 |
| `src/BattleArena.tsx` | 28 格部署、点击 / 拖拽站位、自动战斗回放与技能特效 |
| `src/battle.ts` | 纯战斗模拟、职业 / 技能配置、属性、移动、羁绊、判胜 |
| `server/match.mjs` | 开局、商店、经济、合星、阶段推进、公开对局视图 |
| `src/engine.ts` | 永久收藏经济；同时保留旧培养兼容代码 |
| `src/data.ts` | 卡牌定义、属性 / 稀有度、永久制作 / 回收费用；含旧字段 |
| `src/Community.tsx` | 市场、赠送、好友、世界聊天 / 私聊 |
| `src/AccountMenu.tsx` | 登录状态、OAuth 入口、本地账号切换 |
| `src/Admin.tsx` | 服务端权威基础监控后台 |
| `src/audio.ts` | Web Audio 合成提示音、音效偏好 |
| `server/index.mjs` | HTTP、静态资源、Origin、安全头、OAuth、会话、路由 |
| `server/store.mjs` | SQLite 身份 / 会话 / OAuth 事务；旧匿名埋点 |
| `server/game.mjs` | 权威资产、快照、经济事务、幂等、市场和终局结算 |
| `server/market-query.mjs` | 市场 SQL 筛选、分页、报价与个人历史 |
| `server/social.mjs` | 好友、私聊鉴权、消息、社交限频 |
| `server/local.mjs` | 固定本机 3000 开发登录启动器 |
| `src/App.tsx` / `src/analytics.ts` | **历史**算分版 / 客户端埋点，不是当前主玩法入口 |

`web/docs` 在实际 Git 根目录内。外层旧 `docs`、`artifacts` 不会自动随仅推送 web 仓库而交接，必要时另行打包。

## 5. 关键数据模型与三个身份层级

### 5.1 永久卡、定义与局内卡

```ts
// 静态定义：来自 data.ts
type Affinity = 'moon' | 'sun' | 'forest';
type Rarity = 'R' | 'SR' | 'SSR';

// 永久收藏实例：来自 engine.ts
interface OwnedCard {
  uid: string;       // 账号内实例编号，如 c1，不是全球唯一卡号
  defId: string;     // 稳定卡牌定义 ID
  rank: number;     // 永久 Lv，当前合法范围 1～3
  best: number;     // 旧培养纪录字段，不是当前竞技排名
}

// 局内独立投影：来自 MatchArena / match.mjs
type MatchUnit = OwnedCard & { stars: 1 | 2 | 3 };
type MatchFormation = { uid: string; slot: number };
```

- `defId`：一种卡，例如 `moon-deer`。用于配置、合星和羁绊去重。
- `uid`：某账号内具体实例；交易接收方会获得新的 `c...` ID。
- 局内投影 ID 为 `m...`，不直接对应可交易永久卡。
- **永久 rank 与局内 stars 是独立成长层**，不能混用。

### 5.2 账号身份

- `users.id`：本游戏内部 UUID，API 身份绑定使用它。
- `subject` / OpenAI `sub`：外部身份提供者标识，不等于本游戏 UUID。
- `profiles.code`：公开玩家编号，格式 `AST-` + 8 位大写十六进制，用于赠送 / 加好友。
- OAuth 账号唯一键是 `(issuer, client_id, subject)`，不按昵称或邮箱合并。
- 聊天私聊 `channel` 传对方内部用户 ID，不传玩家编号。

### 5.3 游戏快照

```ts
type GameSnapshot = {
  state: GameState;               // 永久资产；保留部分历史字段
  battle: BattleState | null;    // 旧单场兼容数据，不是当前经营局入口
  match: MatchState | null;      // 当前 / 最近一局十分钟经营局
  revision: number;              // profiles.revision，忽略迟到旧响应
  code: string;
};
```

当前 `GameState.version=1`；`BattleState.version=2`；`MatchState.version=1`。这些是不同结构的版本，不能全局直接互换。外层 revision 与 match / battle 内部 revision 也不是同一个计数器。

公开快照将永久抽卡 `rng` 置 0，移除 match 的 `pool/rng/nextId`。**battle 内仍有完整回放、outcome 等信息**，不要误称所有随机 / 战果信息都已隐藏。

### 5.4 对局与战斗视图的关键字段

```ts
interface MatchState {
  version: 1; id: string;
  status: 'playing' | 'finished';
  startedAt: number; endsAt: number; serverNow: number;
  round: number; phase: 'planning' | 'combat' | 'finished'; phaseEndsAt: number;
  gold: number; level: number; xp: number; xpToNext: number | null;
  shop: {id:string; defId:string; cost:number; rank:number}[];
  locked: boolean; roster: MatchUnit[]; formation: MatchFormation[];
  battle: BattleState | null;
  wins: number; losses: number; streak: number;
  history: {round:number; status:'won'|'lost'; gold:number}[];
  lastIncome?: {base:number; interest:number; streak:number; win:number; total:number};
  reward?: {coins:number; dust:number};
  // 运行时还可能有 revision、abandoned；前端当前未全部声明。
}

interface BattleFrame {
  tick: number; round: number;
  player: CombatUnit[]; enemy: CombatUnit[];
  logs: BattleLog[]; // 仅该行动新增日志
}

// 以下列关键字段，完整类型以 battle.ts 为准。
interface BattleView {
  version: 2; id: string; status: 'playing' | 'won' | 'lost';
  round: number; maxRounds: number; revision: number;
  player: CombatUnit[]; enemy: CombatUnit[];
  frames: BattleFrame[]; outcome: 'won' | 'lost';
  reason?: 'elimination' | 'round-limit';
  synergies: {player: Synergy[]; enemy: Synergy[]};
}
```

时间戳均为毫秒。Match 的 round 是八个经营回合，battle 的 round 是最多三十二个模拟轮，frame.tick 是回放行动序号；HUD、统计与日志不能混用。

## 6. 永久收藏、抽卡与重复卡处理

### 6.1 初始资源

新账号首次创建 profile 时：**23 张实例 / 8 种卡、1280 星币、360 星尘、3 张抽卡券**。profile 只初始化一次；重新登录不重复领取。旧浏览器 localStorage 存档不导入交易账户。

### 6.2 抽卡

- 一次 3 张；优先扣 1 张券，没有券才扣 180 星币。
- 每抽基础选档概率：R 60%、SR 30%、SSR 10%。
- 如果前两张都是 R，第三张原本仍抽中 R，则改为 SR。因此每包至少有 SR / SSR，最终整包分布不是三个完全独立基础概率。
- 同稀有度定义中随机抽取；没有跨包 SSR 保底、定轨、活动池或每日免费抽。
- 收藏上限 10000 张；空间不足拒绝整包操作，不部分扣费。

### 6.3 强化 / 制作 / 分解

| 操作 | 成本 / 结果 |
| --- | --- |
| Lv1 → Lv2 | 消耗另外 2 张同名 Lv1 + 90 星币 |
| Lv2 → Lv3 | 消耗另外 3 张同名 Lv1 + 180 星币 |
| 定向制作 R / SR / SSR | 60 / 180 / 480 星尘，得到一张 Lv1 |
| 分解 R / SR / SSR | 一张获得 10 / 30 / 80 星尘 |

- 主卡按 `rank` 降序、旧 `best` 降序、`uid` 排序选择，强化保留主卡实例。
- 分解保护最后一张、已强化卡和历史活跃培养实例，只处理额外 Lv1 卡。
- 当前 HTTP `recycle` 一次分解 1 张，不要误写为已实现批量分解。
- **UI 制作页只显示已拥有定义**；分解页只显示可分解重复卡。
- 细节：底层 `craft()` / HTTP 目前允许制作任意已知定义，拥有性限制在 UI，不是服务端规则。用户原需求是“不显示未获得卡”，若未来要禁止服务端制作未拥有卡，属于需明确的新规则。

### 6.4 长期循环现状

```text
抽卡 / 市场购买 → 扩展本局可用定义
→ 经营 / 站位 / 羁绊尝试 → 完成十分钟局获得星币与星尘
→ 抽卡 / 强化 / 制作 → 重复卡强化或分解
→ 多余卡卖给玩家或赠送 → 继续收集与尝试
```

这个循环已连通，但**尚未证明可长期无通胀地运行**。没有入场成本、全败也有基础奖励、新账号初始资产可转移，均是公开运营前必须评估的问题。

## 7. 十分钟经营局：状态机与经济规则

### 7.1 总时长与推进方式

```text
开局 → 第1轮经营40s → 战斗35s
     → 第2轮经营40s → 战斗35s
     → … → 第8轮战斗结束 → 终局
8 × 75s = 600s = 10分钟
```

- 每账号最多一局进行中。
- 时间使用服务端 `startedAt / phaseEndsAt / endsAt`，截止点锚定开局时间，不因网络延迟顺延。
- **惰性推进**：`GET /api/game` 或经济命令调用 `syncMatch()`，根据当前服务端时间补齐阶段。当前没有后台定时器 / 常驻比赛调度器。
- 离线后回来可一次补完多个回合，刷新不会暂停或重复奖励。
- 客户端倒计时只是显示；本机改时钟、暂停 / 快进回放不能提前拿奖励。
- 返回大厅不弃局、不暂停；“退出本局”是独立服务端操作。

### 7.2 开局

- 初始 12 **局内金币**、人口 3、XP 0。
- 从开局永久收藏建立去重池；同 def 只取最高永久 Lv。
- 免费给 1～2 张 ★1 投影，优先坦克及不同职业。只有一种定义时只给一张，不凭空补第二张同卡。
- 开局后的永久交易 / 赠送 / 强化不改变本局池，也不会移走局内投影。
- 备战总库存上限 15，包含上阵单位，不是上阵之外再额外 15 格。

### 7.3 商店

| 人口 | R 选档 | SR 选档 | SSR 选档 |
| --- | ---: | ---: | ---: |
| 3 | 60% | 32% | 8% |
| 4 | 45% | 40% | 15% |
| 5 | 30% | 45% | 25% |
| 6 | 20% | 45% | 35% |

- 商店 5 格，R / SR / SSR 售价 1 / 2 / 3 局内金币。
- 选中的档位没有已拥有定义时，回退整个本局池随机；表内是选档概率，不一定等于最终出货比例。
- 购买后移除该 offer，不即时补货；前端以空格补足五格布局。
- 手动刷新 2 金币；锁店免费并跨轮持续，直到手动解锁。
- 未锁时进入下一轮经营免费刷新；锁店仍允许手动付费刷新。
- 没有多人共享卡池、稀缺库存或其他玩家抢卡。

### 7.4 人口与合星

- 4 金币买 4 XP；3→4 需 6 XP，4→5 需 10 XP，5→6 需 14 XP。
- 每次进入下一轮经营自然 +2 XP，共最多 7 次。溢出 XP 保留；人口 6 时 XP 清零。
- 上阵数 ≤ 当前人口；最多 6 个单位。
- 3 张**同定义、同星**自动合成高一星，最高 ★3，可连锁合成。
- 优先保留已部署实例，其余实例及其站位删除。
- 购买先合星再检查库存容量，满 15 张时仍可能通过买第三张合星成功。
- 出售返还 `稀有度单价 × 3^(stars−1)`，即完整合成张数成本，同时移除站位。

### 7.5 阵容提交与阶段边界

`match.deploy` 提交 `{uid, slot}[]`：UID 必须属于本局库存，UID / slot 唯一，slot 为 0～27 整数，数量不超过人口。

允许同定义不同实例上阵。允许保存空阵，但战斗开始时若库存非空，服务端会自动推荐布阵；库存也为空才自动判败。不要以为空阵能持续选择不上场。

除放弃外，买卡、卖卡、刷新、XP、锁店、部署都只允许经营阶段；**到截止时刻即拒绝迟到操作**，不以按钮点击时间为准。

### 7.6 对手与收入

- 第 1～3 轮敌人 3 张；第 4～6 轮 4 张；第 7～8 轮 5 张。
- 对手从全部 36 定义中随机选不同卡，永久 Lv 为玩家上阵平均 Lv 四舍五入，局内始终 ★1。
- 敌人数不会随玩家买人口同步增加；这是当前运营收益的重要边界。

```text
每轮收入 = 5 基础
         + min(5, floor(结算前局内金币 / 10)) 利息
         + 连胜 / 连败（连续2～3轮 +1；连续≥4轮 +2）
         + 获胜 +1
```

利息按本轮收入到账前余额算，不利滚利套算。胜败切换后连续计数重置符号。

### 7.7 终局

- 正常完成：星币 `80 + 20 × 胜场`；星尘 `20 + 5 × 胜场`。
- 全败仍为 80 星币 / 20 星尘；全胜为 240 / 60。
- 主动放弃：0 奖励。
- 不提前淘汰，固定走完八轮；没有玩家血量、排名名次奖励。
- 局内金币、投影、星级**不转换为永久资产**。
- `syncMatch()` 在同一事务中保存阶段、终局奖励和流水；已结束状态不再次发奖。

## 8. 自动战斗：属性、职业、技能与站位

### 8.1 职业基础值

| 职业 | HP | ATK | 护甲 | 魔抗 | 射程 | 先手 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 坦克 | 180 | 14 | 45 | 35 | 1 | 40 |
| 战士 | 145 | 23 | 28 | 20 | 1 | 55 |
| 射手 | 100 | 24 | 12 | 15 | 4 | 78 |
| 法师 | 95 | 22 | 12 | 25 | 3 | 50 |
| 刺客 | 105 | 28 | 15 | 15 | 1 | 90 |

每张卡有技能名及轻量系数 / 射程 / 防御变体，实际请调用 `getCombatStats()`。稀有度不自动提供额外属性倍率。

**先手 speed 当前决定每轮行动顺序，不是每秒攻击次数。** 所有存活单位一轮最多行动一次。不要把展示文案改成攻速而不改变模拟。

当前职业通过卡牌 `art` 映射。换插画可能意外换职业，这是配置耦合，下一步应在保留行为的前提下解耦。

### 8.2 成长与伤害公式

```text
HP = round(基础HP × (1 + (rank−1)×0.03) × (1 + (stars−1)×0.12))
ATK = 保留1位小数(基础ATK × (1 + (rank−1)×0.02) × (1 + (stars−1)×0.08))

伤害 = max(1, round(
  ATK × 技能系数 × 属性克制 × 100/(100+对应防御) × 决战倍率
))
```

羁绊在入场 / 技能计算时另行施加。UI 不要对 `getCombatStats()` 结果重复乘等级 / 星级倍率。等级与星级不提高射程、护甲、魔抗、先手或羁绊计数。

- 月克日、日克森、森克月：正向 ×1.25，反向 ×0.85，同属性 ×1。
- 普攻都为物理；战士 / 射手 / 刺客技能走护甲，法师技能走魔抗。
- 先扣盾再扣血；生命伤害不超过目标剩余生命。
- 没有暴击、闪避、装备、治疗系统；残留 `cooldown=0` / `heal` 日志类型不表示已经实现。

### 8.3 能量与五类技能

- 开场 30 能量；普攻后 +35；真正受到生命伤害每次 +10，上限 100。
- 完全被护盾吸收的攻击**不增加受击能量**，移动不回能。
- 轮到行动时能量满则自动放技能，释放后清零。
- 坦克满能可以原地开盾，其他职业仍需目标进入射程。

| 职业 | 当前机制 | 效果类型 |
| --- | --- | --- |
| 坦克 | 自身护盾；有盾时吸引 2 格内近敌；各卡盾为最大生命约 18.2%～22.1%，总盾上限最大生命 | `shield` |
| 战士 | 目标物理伤害 + 自身身旁 1 格其他敌人横扫 | `slash` |
| 射手 | 同目标连射两次；首发击杀不继续打尸体；后两排部署时技能优先狙击敌后排，仍受射程限制 | `projectile` |
| 法师 | 目标法术伤害 + 目标周围 1 格溅射 | `blast` |
| 刺客 | 第一次行动突入敌后排附近空格，随后可攻击；技能单点物理爆发 | `dash` |

36 个不同技能名，当前本质仍是五类模板加数值 / 射程变体，**不是 36 套独立复杂机制**。

### 8.4 棋盘与寻路

- 部署：4×7 共 28 格；slot 0～6 为我方最前排，21～27 为最后排。
- 全战场：8×7；我方 `row=4+floor(slot/7)`，敌方 `row=3-floor(slot/7)`，`col=slot%7`。
- `slot` 保留原始部署位，实际移动使用 `row / col`；回放不能只画 slot。
- 距离为**曼哈顿距离**，不是金铲铲六边形距离。
- 射程外 BFS 找到进入攻击范围的空格路径，每次走一格；普通移动和普通攻击不在同一次行动同时发生。
- 存活单位不能重叠；刺客闪现也必须落到空格。
- 每轮按先手降序、部署格升序；跨阵营同速同格根据 seed / round 交替先后，避免固定单边优势。
- 一般优先最近目标；同距时参考原前排、剩余生命比例、格位。有盾近坦、后排射手、刺客有各自目标规则。

### 8.5 羁绊

按**不同 defId**计数。同名多实例可以上阵，但不重复凑羁绊；效果只施加给对应属性 / 职业单位。

| 条件 | 效果 |
| --- | --- |
| 2 / 4 月 | 开场获得最大生命 12% / 25% 护盾 |
| 2 / 4 日 | 攻击 +8% / +18% |
| 2 / 4 森 | 最大生命 +10% / +22% |
| 双坦克 | 坦克生命 +8% |
| 双战士 | 战士攻击 +12% |
| 双射手 | 射手普攻额外 +10 能量 |
| 双法师 | 法师技能伤害 +15% |
| 双刺客 | 刺客技能伤害 +15% |

4 属性档**替代**2 属性档，不相加。预览里达到 4 后两条 `active` 可能均为 true，但实际数值只取高档，不要看到两条激活就再乘一次。

### 8.6 决战、判胜与回放

- 最多 32 个模拟轮，与经营局八轮不是同一个“轮”。
- 第 17 模拟轮开始，每轮累计伤害 +8%，新生成护盾 −5%，新盾最低保留 20%。
- 第 17 轮伤害 ×1.08 / 新盾 ×0.95；第 32 轮 ×2.28 / ×0.20。
- 不直接衰减已有盾；不要回退“纯盾吸收不回能”修复，否则容易重新形成无限盾循环。
- 一方全灭即时判胜；32 轮仍未分胜负，比较全队剩余 HP / 全队最大 HP，不计盾；相等时玩家败。

```ts
createBattle(team, seed, slots?, { enemyCount? });
actBattle(battle, { type: 'resolve' });
getCombatStats(card);
getSynergies(team);
```

`createBattle()` 同步预计算全部帧和 `outcome`，初始返回仍为 `status:'playing'`。`actBattle()` 应用最终帧；纯函数不发钱。完整 6v6 ×32 最多约 384 次单位行动，回放校验上限 400 帧。

`frame.logs` 只包含当前行动新增事件；需要全场日志时合并各帧，不能当累计日志重复追加。当前 Match 回放 `replayOnly` 只展示，客户端没有可提前终局结算的指令。

## 9. 目前的策略空间与玩法欠缺

### 9.1 已有可思考的取舍

- 存 10 / 20 / … / 50 金拿利息，还是立即刷新找合星。
- 提人口增加上阵数 / 商店高稀有档，还是保留经济。
- 同名合星提高单体，还是增加不同定义触发羁绊。
- 坦克保护后排、分散防法师、调整后排防刺客、远程射程覆盖。
- 低人口早期稳连败或投入稳连胜，避免无规划地一胜一败。

### 9.2 不能被“完整系统”描述掩盖的问题

- 当前只是随机电脑对手，不具备玩家间直接竞技闭环。
- 属性与职业较强绑定：月偏坦克 / 刺客，日偏射手 / 法师，森偏战士 / 法师，跨体系组合空间有限。
- 36 定义机制差异不够大，简单扩卡名 / 数字不能替代有趣组合。
- 敌人始终 ★1，后期合星 / 人口压制的难度曲线未完成系统验证。
- 可以开局后离线补完并领取全败基础资源，存在挂机 / 多账号经济风险。
- 没有长期目标系统、赛季、任务、竞技排名、活动轮换；不要声称已建立无限耐玩闭环。

建议先解决“玩家每轮有值得做的决定”和关键阵容克制，再扩充数量。新增机制必须有简短说明、可见效果和规则测试，避免重新变成大段算分说明。

## 10. 前端组件、请求状态与 UI 约束

### 10.1 CombatApp：权威快照协调

- 页面为 collection / battle / summon / forge / community，当前不是完整路由器。
- `readAuth()` → 得到内部用户 ID → `GET /api/game`。
- CombatApp 的游戏请求及 Community 的市场 / 社交请求发 `X-Asteria-User: 当前内部用户ID`，避免同浏览器其他标签切号后误操作；Admin 暂未统一这套绑定与迟到响应保护。
- `identityRef / authRequestRef / gameRequestRef / operationRef` 隔离迟到响应。
- 只接受不小于当前 `revision` 的快照；切号清除旧资产、弹窗和进行中的 UI 状态。
- 游戏命令生成稳定 requestId，首次网络抛错后用**同一请求体**重试一次，不重新生成 ID。
- 401 清空身份 / 资产并提示登录；身份不匹配 409 重新读取账号。
- 可见状态约 15 秒刷新资产，focus / visibilitychange 也同步。
- 旧 localStorage 不作为资产来源；可以保存音效等无经济风险偏好。

重要接线：MatchArena 已传 `match.start` 等完整 action，父级不要再次拼 `match.`，否则请求变为 `match.match.*`。

### 10.2 MatchArena：受控阵容与经营 HUD

- props：`match / busy / cards / onCommand / onRefresh / onBack`。
- 经营站位用本地 draft，点击“保存阵容”才提交服务端；不要把拖动即视为已保存。
- 以 serverNow + 本地时间差显示计时；最大显示时长限制为 10:00 / 00:40 / 00:35，防瞬间多一秒。
- 可见页每 5 秒刷新；到阶段截止另触发一次去重刷新。
- 出售、放弃、未保存阵容离开有确认。
- 回放速度 / 暂停 / 跳过仅影响展示，不改变经营局截止点。
- 返回大厅只调用 onBack，不能顺带发 abandon。

### 10.3 BattleArena：复用边界

- 支持 collection 和 match 库存模式。collection 默认每定义只取最强一张；match 必须保留全部不同 UID 投影。
- 点击、拖拽放置、换位、推荐布阵、羁绊预览、备战出售。
- 经营完整战场上半四行为空 / 不可部署，下半四行接受 slot。
- 战斗按 row / col 绘制，SVG / CSS 表现弹道、斩击、爆炸、护盾、闪现、血条和能量。
- `replayOnly` 不调用旧单场结算接口；Match 必须保持这个模式。
- 伤害排行与日志用于解释战果，不得反向决定服务端输赢。
- 回放只在 `battle.id` 改变时重置，不能依赖轮询返回的整个 battle 对象引用；同轮轮询也不能覆盖玩家未保存的阵容草稿。

### 10.4 沉浸布局不可破坏项

- `.app-shell.combat-app.is-battle-immersive` 隐藏普通侧栏与页头。
- 战场占满视口，左羁绊、顶部回合计时、右真实八轮战况、底部固定备战 / 商店 / 经济。
- 右侧不是假的真人排行榜；不要伪造八个实时玩家。
- 对战时 body / html overflow 锁定；离开时恢复原值，不能让大厅永久不能滚动。
- 系统全屏只在用户点击后调用；不支持时仍保留全视口布局，失败给中文提示。
- 返回大厅若正在浏览器全屏则退出；不能因退出失败卡住导航。
- 经营和战斗共用棋盘高度 / 网格标尺，切阶段卡牌不能突然跳到错误半区。
- 小横屏棋子最低约 26×36px；底栏不可被视口裁切。
- 规则说明用弹窗，不用长文占掉棋盘。
- 未拥有卡的占位和信息不得混进合成 / 分解页面。

### 10.5 CSS 与视觉资源

| 文件 | 范围 |
| --- | --- |
| `src/style.css` | 基础 / 大厅 / 一些历史残留 |
| `src/combat-app.css` | 当前收藏、详情、抽卡、锻造 |
| `src/match.css` | 对局全屏 HUD / 商店 / 经营布局 |
| `src/battle.css` | 部署棋盘、战斗卡、回放和特效 |
| `src/immersive-battle.css` | 森林场景、透明棋盘、沉浸壳与响应式覆盖 |
| `src/community.css` | 市场 / 社交 |
| `src/admin.css` | 后台及账号相关 |

样式存在历史叠加，改动前先看 import 顺序和选择器优先级，不要无限追加重复 `!important`。重构应逐页做视觉回归，不建议第一步全删旧 CSS。

### 10.6 音效和外观成长

- `audio.ts` 使用 Web Audio 本地合成，不需要模型服务或网络音频。
- 偏好 key：`asteria.audio.enabled`，未显式启用时默认关闭；用户交互后才可可靠播放。
- 按 cue 节流，失败静默降级，不能让音频异常阻塞资产操作。
- 有选择 / 成功 / 错误 / 抽卡 / 强化 / 制作及战斗音效和动效，不是完整背景音乐 / 技能采样库。
- 等级与稀有度通过 `data-rank / data-rarity` 等驱动边框 / 光泽；**不要把等级徽标重新叠回插画角上**。
- 后续视觉升级建议做明确可辨的三阶差异，但必须支持 reduced-motion，低性能 / 小屏也要清楚可读。

## 11. HTTP 接口契约

### 11.1 通用约定

- 同域 Cookie 会话；请求 JSON 使用 `Content-Type: application/json`。
- 所有写请求的 `Origin` 必须精确等于 `APP_ORIGIN`，命令行测试也要显式发送。
- 主应用游戏 / 市场 / 社交请求发送 `X-Asteria-User`；服务端目前允许省略，但提供后必须匹配。它是当前身份绑定提示，**不是认证凭证**，Cookie 才是登录凭证。
- 请求体上限 16KB；游戏 / 市场写请求必须有 `requestId`。
- `requestId` 为 8～80 位 `[a-zA-Z0-9-]`；推荐 UUID。
- 成功游戏 / 市场写请求返回最新 `GameSnapshot`；不是 `{ok:true}`。
- 社交写请求返回 `{ok:true}` 或 `{ok:true,message}`，**没有统一经济幂等机制**。
- 错误通常 `{error:string}`。400 参数 / 规则错误；401 未登录；403 来源 / 权限；404 不存在；409 状态冲突；410 已停用；413 过大；429 限流。

### 11.2 身份和基础接口

| 方法 / 路径 | 请求 | 返回 / 说明 |
| --- | --- | --- |
| GET `/api/health` | 无 | `{ok:true}`，不是深度数据库 / 性能探针 |
| GET `/api/auth/me` | Cookie 可选 | `{user,loginEnabled,devLogin,analytics}` |
| POST `/api/auth/logout` | 同源 | 清除本地会话，`{ok:true}` |
| POST `/api/auth/dev-login` | `{profile:'admin'|'playerB'|'playerC'}` | 仅本机开发；默认 admin；返回 `{ok:true}` 后再读 auth |
| GET `/auth/openai` | 无 | 开始 OAuth；未配置重定向带 not_configured |
| GET `/auth/openai/callback` | code / state | 校验后建立会话，302 返回首页 |
| GET `/api/game` | 登录 | GameSnapshot；可能推进并结算到期对局 |

`user` 为 `{id,name,subject,admin,development}` 或 null。`loginEnabled` 只表示已配置 Client ID，不代表真实提供者联调成功。

### 11.3 永久资产命令

以下路径均为 POST，表内参数之外都要加 requestId。

| 路径 | 参数 |
| --- | --- |
| `/api/game/summon` | 无额外参数 |
| `/api/game/strengthen` | `{defId}` |
| `/api/game/craft` | `{defId}` |
| `/api/game/recycle` | `{defId}`，当前一次一张 |

不要给这些接口添加客户端 `coins / dust / rank / outcome` 输入作为可信结果。

### 11.4 对局命令

| 路径 | 参数 / 阶段 |
| --- | --- |
| `/api/game/match.start` | 无额外参数；无进行中对局 |
| `/api/game/match.buy` | `{offerId}`，不是 defId |
| `/api/game/match.sell` | `{uid}`，局内 m... ID |
| `/api/game/match.reroll` | 无额外参数 |
| `/api/game/match.xp` | 无额外参数 |
| `/api/game/match.lock` | `{locked:boolean}` |
| `/api/game/match.deploy` | `{formation:[{uid,slot},...]}` |
| `/api/game/match.abandon` | 无额外参数；任意进行中阶段 |

除了 start / abandon，其余仅经营期。**所有 `/api/game/battle.*` HTTP 路由返回 410**：单场试玩停用，不能重新打开来绕过十分钟奖励限制。

### 11.5 市场写接口

| 路径 | 参数 |
| --- | --- |
| POST `/api/market/list` | `{uid,price,requestId}`，永久 c... ID |
| POST `/api/market/buy` | `{listingId,requestId}` |
| POST `/api/market/cancel` | `{listingId,requestId}` |
| POST `/api/market/gift` | `{uid,toCode,requestId}`，toCode 为 AST-... |

### 11.6 市场查询

`GET /api/market` 参数：

| 参数 | 合法值 |
| --- | --- |
| search | 卡名子串，≤80 字符 |
| rarity | 空 / R / SR / SSR |
| affinity | 空 / moon / sun / forest |
| role | 空 / 坦克 / 战士 / 射手 / 法师 / 刺客 |
| rank | 空 / 1 / 2 / 3 |
| minPrice / maxPrice | 空或 0～100000 整数；min ≤ max |
| sort | newest / oldest / low / high / level |
| scope | all / mine |
| page | 正整数；超过末页会截到末页 |

固定 pageSize=20。筛选发生在服务端 SQL，不是只取前几百条后在浏览器筛。

```ts
type MarketResponse = {
  listings: Listing[]; mine: Listing[];
  page: number; pageSize: 20; total: number; feePercent: 5;
  stats: { activeListings:number; sellers:number; trades24h:number; volume24h:number };
  quote: { lowestPrice:number|null; medianPrice24h:number|null;
           lastPrice:number|null; sales24h:number };
  recentTrades: PublicTrade[]; // 当前卡筛选的最近20笔
  history: PersonalTrade[];  // 当前账号最近30条买 / 卖 / 撤单
  quotes: CardQuote[];       // 按 defId + rank 分组报价
};
```

`Listing` 含 `id,sellerId,sellerName,card,price,createdAt`；CardQuote 含 `defId,rank,activeCount,lowestPrice,lastPrice,medianPrice7d,sales7d`。

统计口径不同：stats 为全市场；quote 受卡名 / 属性 / 职业 / 稀有度 / 等级筛选，**不受价格范围和 mine 限制**；quotes 为全市场同卡同永久等级。空报价用 null / “—”，不能补随机假行情。

### 11.7 好友与聊天

| 方法 / 路径 | 参数 | 返回 |
| --- | --- | --- |
| GET `/api/social` | 无 | `{self,friends,incoming,outgoing}`，Person 为 `{id,code,name}` |
| POST `/api/social/friend.request` | `{code}` | `{ok:true}` |
| POST `/api/social/friend.accept` | `{userId}` | `{ok:true}` |
| POST `/api/social/friend.decline` | `{userId}` | `{ok:true}` |
| POST `/api/social/friend.remove` | `{userId}` | `{ok:true}` |
| GET `/api/chat?channel=world` | 或 channel=对方内部 UUID | `{messages:[...]}`，最近50条，正序 |
| POST `/api/social/chat.send` | `{channel,text}` | `{ok:true,message}` |

Message 为 `{id:string,senderId,senderName,text,at:number}`，at 是毫秒时间戳。好友 API 的 userId 是对方内部 ID，不是 OpenAI sub。

### 11.8 管理与历史接口

- GET `/api/admin/economy?days=1|7|30`：当前后台，需管理员，权威 ledger + 社交数量。
- POST `/api/events`：旧客户端匿名行为埋点，客户端自报，不参与资产结算。
- GET `/api/admin/summary?days=1|7|30&includeDev=1`：旧客户端埋点统计，不等于新版权威经济后台。

不要混用两个 summary 的统计来源，也不要把旧客户端上报当作发钱依据。

## 12. 市场交易、赠送与社交服务规则

### 12.1 市场所有权与手续费

- 售价必须为 10～100000 整数星币；每人最多 20 条 active 挂单。
- 上架把永久卡从玩家收藏移到 listing 托管；不是只加一个“在售”标签。
- 买入同一事务完成：确认在售 → 校验非本人 / 余额 → 买家扣全价 → 卖家得净价 → 买家获得新 UID → 挂单 sold → 双方流水。
- 手续费 `floor(price×0.05)`，从卖家收入扣；100 星币买入时买家 −100、卖家 +95、系统回收 5。
- 只允许卖家撤自己的在售单；撤单返回卡，接收时会生成新的永久实例 ID。
- 交易保留 defId / rank 等卡数据；新 Match 用独立投影，所以永久卡在本局中使用也可交易。
- 余额安全整数 0～10 亿，收藏≤10000，任何一方超限整笔回滚。
- 没有充值、提现、现金定价、真实支付。

### 12.2 赠送

- 精确玩家编号，trim 后大写查找；不允许送自己。
- 不要求先成为好友；会真实转移卡牌，接收方生成新 UID。
- 不可撤回，前端确认后执行；网络重试使用同 requestId。

### 12.3 好友 / 消息

- 只接受 / 拒绝发给自己的申请；重复申请和反向已有申请给明确冲突提示。
- 好友关系保存双向 rows；私聊读取和发送均要求当前仍是双向好友。
- 删除好友会删除双方关系 / 申请；历史消息仍存库，但失去好友身份后不能通过私聊接口读取。
- 好友上限 200，待处理申请有限制。
- 好友申请至少间隔 3 秒、每分钟最多 10 次；聊天至少间隔 1.2 秒、每分钟最多 20 次。
- 文本 trim 后 1～300 Unicode 字符，拒控制字符；React 纯文本渲染，不渲染 HTML。
- 管理后台只统计私聊数量，不展示私聊正文。
- 社交没有完整 requestId 去重；不要像经济命令一样在网络异常时无脑重发消息。
- 前端社区可见页约 3 秒轮询，绑定用户和频道，防止切号 / 切频道后旧响应覆盖。
- 私聊正文目前为数据库明文，不是端到端加密；前端不提供给管理员查看，并不等于服务器上没有这些数据。

## 13. 数据库、原子性、幂等与迁移

### 13.1 当前表

| 表 | 关键字段 / 用途 |
| --- | --- |
| users | id PK；issuer / client_id / subject 唯一；name、created_at、last_login |
| sessions | token_hash PK；user_id FK；expires_at |
| transactions | OAuth token_hash PK；state、verifier、nonce、expires_at；不是经济交易表 |
| events | 旧埋点：visitor、user_id、kind、data JSON、created_at、dev |
| profiles | user_id PK；code UNIQUE；state JSON；revision |
| battles | user_id PK；旧单场 state JSON |
| matches | user_id PK；当前 / 最近十分钟局 state JSON |
| listings | id PK；seller_id、card JSON、price、status、created_at、buyer_id、closed_at |
| operations | (user_id,request_id) PK；kind、input JSON、result、created_at |
| ledger | id PK；user_id、kind、coins / dust 增减、data JSON、created_at |
| friendships | (user_id,friend_id) PK；双向好友关系 |
| friend_requests | (sender_id,recipient_id) PK；created_at |
| social_messages | id 自增；sender / recipient、world / private、text、created_at |
| social_rates | (user_id,kind) PK；window_start、last_at、count |

开启 WAL、foreign_keys、busy_timeout=5000。当前使用 `CREATE TABLE IF NOT EXISTS` 初始化，**没有完整迁移框架 / schema version 管理**。

### 13.2 经济事务

- `game.mjs` 使用 `BEGIN IMMEDIATE`，异常 rollback；内层调用通过标记避免嵌套 BEGIN。
- profile 保存都会递增 revision，包括不改变永久余额的对局命令。
- 阶段推进、轮结果流水、终局奖励在同一事务内写入。
- 市场扣款 / 转卡 / 卖家收入 / 手续费记录不可拆成多个异步写步骤。
- social 使用 SAVEPOINT 保证好友关系和限流状态的局部原子性。

### 13.3 requestId 规则

```text
同 user + 同 requestId + 同 kind + 完全相同 JSON.stringify(input)
→ 不重复执行，返回当前最新 snapshot

同 requestId 但换 kind / payload → 409
```

不是重放第一次的旧响应；JSON 属性顺序变化也会被认为载荷不同。重试必须复用最初序列化 body。不同 ID 被认为新操作，不能仅依赖按钮 disabled 防重复扣款。

当前 revision 用来过滤旧响应，**不是必传的乐观锁前置条件**。将来增加 `expectedRevision` 要设计清楚与 requestId / 多标签的兼容关系。

### 13.4 数据与历史兼容风险

- `currentMatch()` 目前直接 JSON.parse，没有完整结构迁移 / 校验；配置改动需要版本方案。
- 旧 `parseSave()` 校验的是早期 `GameState.version=1` 培养存档，不校验 match / battle 数据库 JSON。
- 旧存档校验要求至少 6 张卡；线上合法交易后可能少于 6 张，不能直接用它校验所有新资产账号。
- 旧 v2 单场也使用过 version=2，当前加载 battle 还检查 role / row / col / range / stars，版本号本身不够。
- **遗留锁卡风险**：旧 battles 若仍有合法 `playing` 记录，`checkUnlocked()` 会继续锁对应永久卡；旧 HTTP 已 410，用户没有正常清除入口。升级旧库前应备份并制定迁移 / 清理策略，不直接删整个数据目录。
- operations、ledger、聊天、挂单目前没有完整归档 / 保留策略。清幂等记录前必须定义重试窗口，避免重新执行旧请求。
- 当前 matches 每账号只保留当前 / 最近局的完整 JSON，过往完整回放没有历史归档；ledger 只保存摘要。

## 14. 登录、权限与管理后台

### 14.1 本地开发账户

- A：`local-admin`，管理员；B / C：普通账号。
- 仅 `ALLOW_DEV_LOGIN=1` 且非 production、loopback 来源时可用，服务强制监听 127.0.0.1，并检查请求 socket 为 loopback。
- 它们不是 ChatGPT 账户，不能展示“已经接入真实 GPT 登录”。
- 同源标签共享 Cookie，切 A / B 会影响其他同源标签；前端 X-Asteria-User + 身份 epoch 用于拦截误操作。

### 14.2 ChatGPT OAuth / OIDC 现有实现

- issuer 固定 `https://auth.openai.com`；读取 discovery，端点限制在该 issuer origin。
- Authorization Code + PKCE S256 + state + nonce。
- 登录事务 10 分钟有效，SQLite 原子一次性消费；成功 / 失败都清临时 Cookie。
- `jose` 校验 RS256 / ES256、issuer、audience、exp、iat、sub、nonce，多 audience 校验 azp。
- 只取验证后的身份，映射本地账号并建立随机会话；不把提供者 access token 保存到前端。
- 会话约 8 小时；库里存 token hash，不存明文会话 token。
- Cookie HttpOnly、SameSite=Lax，HTTPS 配置启用 Secure 和 `__Host-` 命名。
- 支持 token 认证 `none` 或 `client_secret_basic`；secret 仅服务端。
- 管理员按 OpenAI subject 白名单、issuer / 当前 client ID 判定，不把第一个注册用户自动设管理员。

**外部前置条件**：截至本次核验，网站登录文档仍说明面向选定商业合作伙伴有限试用，需要注册网站 OAuth 客户端及精确回调；不是拿普通 ChatGPT 账号或 API Key 就能完成第三方网站登录。身份登录与 ChatGPT 套餐用于模型请求是不同授权，本游戏当前只做身份登录。[OpenAI 官方网站登录文档](https://developers.openai.com/siwc/website)

用户已明确“没有 Client ID，先完成本地功能与接入配置”，因此下一模型不要冒充联调成功，也不要索要用户密码或在聊天中接收 secret。拿到真实客户端后按第 18 节做联调。

### 14.3 当前安全边界与待补项

已实现：同源写请求校验、HttpOnly 会话、管理员鉴权、请求体限制、基础限流、参数化 SQL、消息纯文本、安全头、静态路径边界。

未完成：可信代理方案、账户封禁 / 举报、完整审计后台、自动化密钥轮换、正式威胁建模、压力 / 渗透验收。

特别注意：登录 / 旧埋点 IP 限流使用 `req.socket.remoteAddress`。放在 Caddy 后可能所有用户共用代理 IP，导致共享登录限额。不能简单信任任意 `X-Forwarded-For`；应明确可信代理来源 / hops，并加伪造头与多人测试。

### 14.4 后台统计口径

- 当前入口 `/admin`，数据来自 `/api/admin/economy`，`source:'server-authoritative'`。
- 1 / 7 / 30 天按北京时间自然日计算，不是简单从当前减 N×24 小时。
- players：累计 profiles 数；activePlayers：所选期内出现 ledger 操作的用户，不等于登录 DAU。
- battles：开局操作数，包含历史 battle.start / 当前 match.start；wins / losses：轮结果，不是玩家最终排名。
- transactions / volume / fees：market.buy 对应笔数 / 总成交价 / 手续费。
- resources：ledger 正负增减汇总。市场双方转账也会计入流入 / 流出，**不能直接当净铸币 / 销毁**。
- activeListings、社交好友 / 消息数量为当前全量，不全部受 days 过滤。
- 最近 40 条 ledger；不展示好友私聊正文。
- 尚缺：新局 match.* 的完整人类可读标签、真正 DAU / 留存 / 漏斗、按卡胜率、来源 / 去向分离、经济净发行监控、告警和运营账号管理。
- Admin 当前请求没有主应用同等的身份头 / 请求序列保护；服务端仍校验管理员，但前端切号、切周期的迟到响应显示也应补回归，不能因为它是只读就忽略。

## 15. 美术、设计与验收证据

### 15.1 运行时素材

`public/art/`：

```text
moon-deer.png       moon-fawn.png
sun-fox.png         sun-cub.png
forest-rabbit.png   forest-sprout.png
arena-forest-v1.png
```

- 前六幅是所有星灵共用的基础插画。
- 森林场景为原创二维背景，实际 1672×941，约 2.7MB；UI、网格、卡牌由代码叠加，不是把截图当成整个可点击界面。
- 背景使用内置图像生成工具生成，运行时不依赖图像 API 或生成缓存路径。
- 完整背景 prompt / 约束在外层 `artifacts/arena-forest-v1-prompt.md`。
- 用户金铲铲截图只用于布局参考；不要直接搬运原作人物、地图、Logo 当生产资产。
- 当前 PNG 合计较大，后续应评估 WebP / AVIF、缩略图、尺寸分档和缓存，不以牺牲卡面清晰度为代价。

### 15.2 推荐先看的截图

绝对证据目录：`D:\project\game\game-1011\artifacts`。

| 文件 | 内容 |
| --- | --- |
| `asteria-immersive-final.png` | 最近沉浸经营界面，下半四行部署 |
| `asteria-immersive-combat-final.png` | 最近沉浸战斗界面 |
| `asteria-current-market.png` | 真实挂牌 / 行情列表 |
| `asteria-current-collection.png` | 无等级角标收藏 |
| `test-handoff-20261014.log` | 本次交接重新执行 407 测试日志 |
| `test-immersive-final.log` | 上一轮沉浸版 407 测试日志 |
| `balance-smoke-comparison.json` | 同种子 / 阵容前后平衡对比 |

旧 `asteria-v03-battle.png` 是早期手动战斗，不代表当前玩法。其他 compact / mobile / landscape 截图可能是中间版本，不以它们覆盖最后设计。

### 15.3 已有手工验证，及其范围

- 1280×900、1366×768：对战页面尺寸等于视口，没有整页滚动。
- 844×390 横屏：无页面水平溢出，固定底栏可见；之后补了最小棋子尺寸。
- 进入 / 退出浏览器全屏、返回大厅恢复侧栏和滚动；未观察到 console error / warn。
- 招募、买 XP、推荐布阵、保存、三合星曾实机操作。
- 一完整真实十分钟局走完 8 轮，2 胜 6 负，奖励 120 星币 / 30 星尘，与公式一致。
- A 挂 100 → B 买 → A 收 95 / 手续 5，及好友申请 / 接受、世界 / 私聊、赠送曾实机操作。

这些是已发生的验收记录，**不是全部流程都已在每次 UI 修改后重复跑过**。本次交接重新跑的是自动测试与构建，不重新声称做过所有浏览器端到端操作。

## 16. 测试体系与质量基线

### 16.1 本次重新执行结果

```powershell
cd D:\project\game\game-1011\web
npm.cmd test
npm.cmd run build
```

结果：**407 tests，407 pass，0 fail / skipped / todo**；TypeScript + Vite 生产构建通过。日志在外层 artifacts。没有新增业务代码。

不要引用前期 374 / 397 / 404 / 406 等阶段数字作为当前总数；它们只是不同阶段记录。

### 16.2 测试文件用途

| 测试 | 主要覆盖 |
| --- | --- |
| `tests/battle.test.ts` | 确定性、人数 / 站位、射程 / 移动、防御 / 克制、五职业、羁绊、等级 / 星级、盾与决战 |
| `server/match.test.mjs` | 商店经济、合星、服务器时钟、离线补算、幂等、永久 / 局内隔离 |
| `server/game.test.mjs` | 永久资产、原子买卖、赠送、权限 / 请求编号边界 |
| `server/market-query.test.mjs` | SQL 筛选、排序、分页、真实行情、同卡同等级报价 |
| `server/social.test.mjs` | 双向好友、私聊授权、消息限制、社交限频 |
| `server/identity.test.mjs` / `server.test.mjs` | OIDC token 校验、会话、配置、Origin、管理员等 |
| `server/workflow.test.mjs` | 服务接口组合工作流 |
| `tests/combat-ui.test.ts` / `match-ui.test.ts` / `immersive-ui.test.ts` | 当前 UI / 接线的部分静态与纯函数回归 |
| `tests/catalog.test.ts` | 36 卡目录与基础定义稳定性 |
| `tests/engine.test.ts` / `property.test.ts` / `save.test.ts` | 永久经济与历史培养 / 存档兼容性质 |
| `tests/audio.test.ts` | 音效开关与安全降级 |

**测试通过不代表完整浏览器 E2E、玩法平衡、真实 OAuth、Docker 或性能已验收。** UI 测试中存在源码约束检查，不能代替视觉查看和真实点击。

### 16.3 平衡冒烟的已知结果

540 局同阵容 / 同 seeds 对比：

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 达到模拟轮上限 | 115 / 540（21.30%） | 15 / 540（2.78%） |
| 最后8轮持续动作不掉血 | 14 | 0 |
| 平均模拟轮 | 19.52 | 17.28 |
| 死锁 / 异常 / 存活单位重叠 | 0 | 0 |

全坦仍有 20% 超时；三坦三射在这组样本胜率 83.3%。这是严重问题冒烟，不是公平竞技的结论。扩展平衡时需覆盖人口、星级、永久 Lv、经济策略、站位、全部卡组合与不同敌阵。

## 17. 已知问题与技术债优先级

| 优先级 | 问题 | 处理方向 |
| --- | --- | --- |
| P0，上线前 | 无真实可用登录客户端，生产关 dev 后可能无登录入口 | 获得注册客户端并真实联调，或经用户确认增设其他正规登录方式 |
| P0，上线前 | 旧 battles playing 会继续锁永久卡 | 备份、显式迁移、回归旧库升级，不能恢复秒结算入口 |
| P0，上线前 | 反向代理下 socket IP 共享限流 | 建立可信代理与防伪造来源测试 |
| P0，上线前 | 挂机补算 + 全败奖励 + 多账号初始资产转移 | 先模拟经济与记录数据，再确认限额 / 成本 / 防滥用策略 |
| P0，上线前 | 未验收备份恢复 / Docker / 服务器部署 | 隔离环境完整走通并留操作记录 |
| P1 | 五模板差异有限，阵容胜率和后期曲线不稳 | 机制原型 + 固定种子对照 + 经济全局模拟 |
| P1 | art 与职业耦合；新旧字段同文件 | 分离 battle catalog，兼容旧 defId / 存档与测试 |
| P1 | match 缺结构校验 / 迁移版本 | 版本化 schema / migration，保留回滚与备份 |
| P1 | 后台 match.* 标签缺失、口径容易误读 | 新局人类可读分类；净发行 / 转账 / 销毁分开 |
| P1 | 社交缺举报、封禁、屏蔽、未读与分页 | 先权限 / 治理再实时化 |
| P1 | 全帧 JSON / 同步模拟 / 同步 SQLite 阻塞 | 测量 payload、CPU 和延迟后优化，必要时 worker |
| P2 | CSS 覆盖多、HMR 同源联调不方便 | 分模块整理；统一开发代理 / Origin 策略 |
| P2 | 图片大、缺独立卡美术、移动端覆盖有限 | 图片优化 / 视觉档位 / 设备验收 |
| P2 | 缺 CI、自动 E2E、版本发布记录 | 建基线后逐步自动化 |

没有实测容量上限，不要承诺“SQLite 支持 X 万并发”。当前同步规则计算、轮询和市场聚合都可能成为瓶颈，应先压测。

## 18. 启动、环境配置与部署

### 18.1 推荐本地试玩

```powershell
cd D:\project\game\game-1011\web
npm.cmd ci
npm.cmd run dev:local
```

它先构建再用 Node 提供同域 3000；**不是 HMR**。修改 UI 后需要重新 build，服务静态读取 dist；规则模块 / 服务端改动需要重启相应进程。已有服务在运行时先确认端口，不重复占用。

Windows 如 PowerShell 阻止 npm.ps1，用 `npm.cmd`。根目录 package.json 不是游戏启动入口。

### 18.2 常用命令

| 命令（web 内） | 用途 |
| --- | --- |
| `npm.cmd test` | 自动测试 |
| `npm.cmd run build` | tsc -b + Vite 生产构建 |
| `npm.cmd run dev:local` | 本机 3000、A/B/C 开发账号 |
| `npm.cmd start` | 按 .env 启动普通服务 |
| `npm.cmd run dev:server` | 后端按 .env 启动 |
| `npm.cmd run dev` | Vite 127.0.0.1:5173，代理 /api 和 /auth 到 3000 |
| `npm.cmd run preview` | 静态预览 4173，**不是完整后端替代** |

Vite 5173 联调注意：写请求仍严格校验 Origin，默认后端 origin=3000 时会拒绝 5173。需要按开发入口设置 APP_ORIGIN 并核对 OAuth 回调 / Cookie，或继续使用推荐同域 3000，不能全局删除 Origin 校验。

### 18.3 环境变量

复制 `.env.example` 为 `.env`；不要放密钥进 `VITE_*`。

| 变量 | 当前含义 |
| --- | --- |
| NODE_ENV | production 时强制 HTTPS origin，禁止开发登录 |
| HOST / PORT | 监听；开发登录开启时 host 强制 127.0.0.1 |
| APP_ORIGIN | 无路径来源，如 `https://game.example.com`；写请求 / OAuth 回调依据 |
| DATABASE_PATH | 默认 ./data/asteria.sqlite；`:memory:` 仅临时测试 |
| ALLOW_DEV_LOGIN | 默认 / 模板 0；本地启动器强制 1 |
| OPENAI_CLIENT_ID | 真实注册网站客户端，缺少则 OAuth 不可用 |
| OPENAI_TOKEN_AUTH_METHOD | none / client_secret_basic，按注册配置 |
| OPENAI_CLIENT_SECRET | confidential client 服务端 secret |
| ADMIN_OPENAI_SUBJECTS | 管理员 sub，逗号分隔；不自动提升首个用户 |
| DOMAIN | Compose / Caddy 使用的域名 |

`localhost` 和 `127.0.0.1` 是不同来源 / Cookie 环境，不能随意混用 URL 与 APP_ORIGIN。

### 18.4 隔离 QA 启动示例

在**独立终端**中，确认 3001 空闲后：

```powershell
cd D:\project\game\game-1011\web
$env:NODE_ENV='development'
$env:HOST='127.0.0.1'
$env:PORT='3001'
$env:APP_ORIGIN='http://localhost:3001'
$env:ALLOW_DEV_LOGIN='1'
$env:DATABASE_PATH=':memory:'
node server/index.mjs
```

环境变量只作用当前终端及其子进程；终止 / 关闭终端即结束 QA。内存库不是备份、不是持久游戏账号，也不要拿 QA 假数据当生产真实统计。不要用 `dev:local` 来改端口，因为 local.mjs 固定 3000。

### 18.5 普通服务器部署

```sh
cd /path/to/web
npm ci
npm run build
cp .env.example .env
# 编辑 .env，配置 production / HTTPS APP_ORIGIN / 登录 / 管理员
npm start
```

由 Caddy / Nginx 将同一 HTTPS 域名反代到 Node。不要仅上传 dist；必须包含 `dist/`、`server/`、运行时使用的 `src/engine.ts`、`src/data.ts`、`src/battle.ts`、package 文件和生产依赖。若未来引入新共享规则模块，Docker runtime COPY 必须同步更新。

建议由 systemd / 容器管理进程、结构化日志和重启；这些完整运维流程目前没有验收。使用单实例 SQLite 时，不要直接无设计横向扩多个独立库实例。

### 18.6 Docker + Caddy

现有 `Dockerfile` 为 Node24 multi-stage，非 root node 用户运行，持久 data volume；`compose.yaml` 含 game + Caddy，固定 production 且关闭 dev login。

```sh
# web/.env 中填写 DOMAIN、OAuth 和管理员配置
docker compose up -d --build
```

需要域名 DNS、80 / 443 放行。game-data 为数据库卷，caddy-data / caddy-config 为证书与代理持久配置；**不要用 down -v 清数据**。此命令为部署方案，不代表已在用户服务器执行成功。

### 18.7 真实 OAuth 联调清单

1. 取得真实网站客户端和注册认证方式。
2. 精确注册 `APP_ORIGIN/auth/openai/callback`，分别区分开发与生产环境。
3. 服务端配置 Client ID，confidential client 另配 Secret。
4. 验证新用户登录、重复登录同账号、退出、过期 / 重放 / 错误 state 回调。
5. 核对 HTTPS Cookie、反代来源、失败时中文提示。
6. 将自己的 verified sub 加入管理员白名单，重启后验证普通用户 403 / 管理员 200。
7. 验证跨标签换号不误扣另一个用户资产。
8. 不申请模型请求权限，不假设用户套餐可直接给此游戏提供模型 API。

### 18.8 数据备份与恢复

- SQLite WAL 活跃时不能只复制 `asteria.sqlite` 主文件。
- 优先使用 SQLite 在线备份接口；或停服后备份整个 data 目录，再确认恢复健康与资产一致。
- Docker 备份 game-data 卷；密钥配置独立安全备份，不混进公开交接压缩包。
- 恢复演练至少核对用户、余额、卡数、在售托管卡、幂等记录、当前对局和好友权限。
- 跨版本部署前先备份，再迁移，再验收；失败回滚代码和对应库版本，不能只回滚代码不顾结构。

## 19. 下一模型容易踩的坑

1. 导入旧 App.tsx，以为它才是主界面。
2. 用 data.ts 的旧 description 显示“+分”而不是当前战斗技能。
3. 把 rank 与 stars 混为一个等级，重复乘属性。
4. 调整 card.art 后悄悄换了职业。
5. Match action 再加一次 match. 前缀。
6. 用永久 c... UID 调用局内 sell，或用 m... UID 上架市场。
7. 回放结束直接结算终局，绕过十分钟服务器时钟。
8. 恢复已 410 的 battle.* 单场奖励接口。
9. 返回大厅时顺手 abandon，或离开后 body 仍 overflow:hidden。
10. 把下半区部署改成全八行可放，导致战斗位置错位。
11. 合星时删除了正在部署的主 UID，没有同步清理站位。
12. 同名多卡重复计入羁绊。
13. 玩家升人口时敌人也同步增加，抵消运营收益。
14. 网络重试重新生成 requestId，重复扣费 / 上架 / 赠送。
15. 以为社交消息也已有幂等，可以无限自动重试。
16. 切号后接受旧请求响应，污染另一个账号 UI。
17. 把后台 resources 的市场转账汇总当作净增发。
18. 将 localhost:3001 内存库当作用户永久资产。
19. 只部署 dist，导致登录 / 市场 / 对局后端全部缺失。
20. 只打包已提交文件，漏掉尚未跟踪的 server / 新 UI / 部署文件。

## 20. 后续开发路线：按小任务交付

以下为建议，不是已实现功能，也不意味着用户已经批准所有扩展。每个任务应先给简短方案，再改代码、测试、截图；不要同时大改玩法、经济、UI、账号和数据库。

### 阶段 A：可安全继续开发 / 小范围测试

| 任务 | 涉及模块 | 验收标准 |
| --- | --- | --- |
| A1 保存交接基线 | Git、本文、tests | 保全未提交文件；407 基线可复现；不打包 secret / 真实库 |
| A2 旧库迁移与校验 | game / match / store | 合法旧库可升级；旧 playing 不锁死卡；新 match 版本校验；有回滚 |
| A3 修正后台新事件显示 | Admin + ledger 口径 | match.start / round / finish / abandon 人类可读；区分局数 / 轮胜败 |
| A4 可信代理与部署演练 | index / compose / Caddy | 多用户不共用错误 IP 限额；伪造头无效；Docker构建/持久化/重启验证 |
| A5 备份恢复脚本与说明 | 运维脚本 / docs | 同一测试库恢复资产、挂单、幂等、好友；可重复执行 |
| A6 基础浏览器回归 | UI / tests | 收藏→抽卡→经营→交易→好友聊天→后台，含切号与失败重试 |

### 阶段 B：先让 PvE 更有趣，而不是单纯扩数量

| 任务 | 开发方式 | 验收标准 |
| --- | --- | --- |
| B1 分离战斗配置 | 显式 role / stats / skill 配置；保留 defId | 单换插画不换职业；36卡完整、旧测试不回退 |
| B2 设计 2～3 个清楚的阵容克制原型 | 先小卡池；每次只新增一类可解释机制 | 站位 / 组合能在同种子对照中改变结果；一两句话能说明 |
| B3 建立难度曲线 | 独立 enemy roster / stars / rank 方案 | 升人口与合星有收益，敌难度不机械追随玩家人口；避免稳定碾压 / 无解 |
| B4 全局经营模拟 | 固定种子经济策略：存息 / 刷牌 / 速人口 | 输出八轮金币、人口、星级、胜场、资源回报；找支配策略 |
| B5 永久外观分级 | 三阶边框 / 流光 / 特效展示，属性维持微量 | 不增加插画等级角标；reduced-motion 可读；小屏性能检查 |

可提案但需确认的机制例子：短时控制、穿透、护盾克制、连锁目标、可见蓄力。一次只试一类，避免五职业突然膨胀为二十种晦涩状态。

### 阶段 C：长期经济与社区运营

- 建议先做资源来源 / 去向 / 净发行监控，再讨论每日奖励上限、入场消耗、交易限制或账号年龄限制；不要拍脑袋同时加一堆限制。
- 市场后续优先补筛选体验、价格历史、成交深度解释、批量整理，再评估求购 / 拍卖需求。
- 社交先做屏蔽 / 举报 / 封禁权限与审计，再做未读 / 在线状态 / 实时消息。
- 明确聊天、账本、幂等记录、账户删除和备份的保留策略。
- 上线资格和真实登录未解决前，不开放开发账号给公网。

### 阶段 D：真正竞技（必须单独确认方案）

可选方向：异步阵容挑战 / 周期排行榜，或真实多人经营房间。两者架构和公平性不同，不能把随机 PvE 页面改个标题就称 PvP。

如果用户选择实时多人，至少先设计：

1. 房间、匹配、重连、观战、超时与弃局规则。
2. 服务器权威经营输入、阶段屏障、配对和奖励。
3. 公平卡池 / 永久收藏对竞技的影响；永久养成是否标准化。
4. 隐藏敌阵 / seed / 未公开战果；不能直接照搬当前公开完整 battle 帧。
5. 排名与奖励抗刷、多账号 / 串通检测。
6. 单实例性能、WebSocket、跨进程协调、数据库并发与故障恢复。

这些都未实现。先形成协议和最小可玩切片，再扩八人房间，不要先写复杂匹配系统却没有好玩的对战。

## 21. 接手后的第一小时

1. 读本文第 1～4、17～20 节，确认当前目标不是旧培养版。
2. 在 web 内看 `git status --short`，保护已有修改和未跟踪文件。
3. 看 `src/main.tsx`、`CombatApp.tsx`、`MatchArena.tsx`、`server/index.mjs` 的真实入口。
4. 跑 `npm.cmd test` 和 `npm.cmd run build`，记录当前结果，不直接相信旧日志。
5. 确认 3000 / 3001 进程和数据库模式；不要重置用户持久库。
6. 对照最后沉浸截图，在现有浏览器中验证要改的最短流程。
7. 从阶段 A / 用户最新指定项选择一个小任务，列出涉及文件、验收和回滚点。
8. 修改后跑针对测试 + 全量测试 + build；UI改动实际查看桌面和小横屏。
9. 说明“完成了什么 / 如何验证 / 尚未完成什么”，同步更新本文，不夸大为已上线。

## 22. 交接包建议

### 应包含

- 整个 web 工作树（含未跟踪业务代码、`package-lock.json`、`public/art`、`server`、`tests`、部署配置和本文）。
- 外层 artifacts 中最后两张沉浸截图、收藏 / 市场截图、测试日志、平衡 JSON、背景 prompt。
- 必要时外层设计文档，但标注其历史身份，不让旧方案优先于本文。

### 不应公开打包

- `.env` / Client Secret / Cookie / 提供者 token。
- 真实用户 SQLite、私聊正文、生产备份；如需交接数据，使用脱敏测试库。
- `node_modules`、dist 缓存可重新安装 / 构建，不必作为源码唯一来源。
- 工具生成缓存、Sites 旧发布产物不要当最新部署包。

---

## 附录 A：卡牌目录的维护方法

定义来自 `src/data.ts`；战斗信息来自 `src/battle.ts` 的 `getCombatStats()`，不要复制旧 trait / description。

目前月 / 日 / 森各 12 定义，各属性 R / SR / SSR 各 4。新增卡至少同步：

1. 唯一稳定 defId 和显示名；兼容旧卡 ID / 顺序要求。
2. 正确属性、稀有度、插画。
3. 显式战斗职业方案（现阶段仍通过 art 映射）和完整 CARD_COMBAT。
4. 简明技能说明、攻击范围 / 防御 / 先手数值。
5. 适配五效果类型，或新增效果对应的回放与音效。
6. 商店 / 制作 / 回收 / 市场筛选可用。
7. 目录完整性、确定性、关键机制、平衡对照和视觉测试。

不要只批量增加名称而宣称新增独立美术或独立技能系统。完整当前目录可通过 Node 运行源码导出，无需凭旧文档手录。

## 附录 B：当前规则修改清单

修改经济常量时要同时检查 `MATCH_RULES` 与 match.mjs 内的 8 / 75000 / 40000 / 15 等字面量，以及 MatchArena 的本地概率、费用和时长显示。当前并非所有实现都从一个常量读取。

修改战斗时按顺序验证：输入是否合法 → 部署坐标 → 目标选择 → 寻路 → 伤害 / 能量 → 羁绊 → 决战 → 终局 → 回放 → 服务端奖励。一次只改一类变量，保存同种子前后对照。

修改资产 / 交易时验证：身份绑定 → requestId → 事务 → 所有权 / 余额 → 流水 → 新快照 → 跨标签 / 网络失败。不要仅看 UI 成功提示。

修改 UI 时验证：桌面视口 → 小横屏 → 弹窗键盘焦点 → reduced-motion / 音效关闭 → 切阶段 → 退出全屏 → 返回大厅 → 无横向溢出 / 无永久滚动锁。

**交接原则：先保全当前可玩版本和权威边界，再逐项提高玩法深度与上线可靠性。**

## 附录 C：可复现的人工验收场景

以下在独立 QA 库进行，不在真实用户库反复制造交易。浏览器同源标签共享登录 Cookie，需要同时操作 A / B 时可用独立浏览器上下文，或按步骤切换账号并等待身份刷新。

| 场景 | 操作 | 必须验证 |
| --- | --- | --- |
| 首次初始化 | QA启动，A登录，记录卡数 / 币 / 尘 / 券；退出再登录 | 首次23张 / 1280 / 360 / 3；二次登录不重复发初始资产 |
| 包内保底 | A抽一次三连 | 券−1、卡数+3、至少SR；不同时扣180星币 |
| 永久强化 | 选择有2张Lv1材料的Lv1主卡强化 | 卡数−2、币−90、主UID保留、Lv2；数值与公式一致 |
| 交易闭环 | 记录A/B余额；A挂一张100；B买；回A查看 | B−100、A+95；卡权只在B；挂单不再active；手续费5 |
| 幂等重试 | 将同一次经济请求原始body再发一次 | 不重扣、不重转卡；返回最新快照；改载荷同ID报409 |
| 两买家抢单 | B/C对同一listing发买入 | 恰好一笔成功；另一笔冲突且无扣款 |
| 赠送 | A按B的AST编号送一张，再尝试同body重发 | A少1、B多1、rank保留、新UID；重试不重复转移 |
| 私聊权限 | B先尝试私聊A；申请、A接受；发送；删除好友后再读取 | 未好友403；互为好友后可收发；删除后读写都拒绝 |
| 身份切换 | A页保留旧UI，在另一同源标签切B，再从旧页操作 | 身份头冲突409；不会扣B资源；旧A响应不覆盖B |
| 开局与商店 | A开局、买offer、刷新、锁店、买XP | 初始12金/3人口；只招募开局已有定义；每步扣费正确 |
| 合星 | 招募三张同def同星，包括已部署主卡 | 合到★2，主UID优先保留；阵容不引用已删除UID |
| 布阵 | 点击/拖拽同名不同UID，保存，刷新 | slot0～27唯一；上阵≤人口；阵容由服务器保存 |
| 截止边界 | 经营最后一秒操作，再在战斗期发经营命令 | 服务端按截止拒绝迟到；无局内负余额或战斗期换阵 |
| 回放独立 | 暂停、2倍速、跳过动画 | 截止点不变，不提前发终局奖励，不调用battle.* |
| 返回大厅 | 未保存时返回确认；再进入对战；原生全屏返回 | 不弃局、计时继续；退出native全屏；大厅可正常滚动 |
| 十分钟结算 | 实际等完8轮，记录胜场W；反复刷新 | 仅一次80+20W星币 / 20+5W星尘；无局内金币兑付 |
| 离线补算 | 开局后关闭页面，10分钟后重新打开 | 补完八轮并只发一次奖；不是重新开始10分钟 |
| 放弃 | 开局后确认退出本局 | finished + abandoned，奖励0；可再开新局 |
| 管理权限 | B访问后台/API，再切A | B为403；A可查看；不返回私聊正文 |
| 视口 | 1366×768、1280×900、844×390横屏 | 对战整页不滚动/不横溢，底栏可操作；卡面无等级角标 |

时间边界自动测试可利用 `createApp(config,{now})` 或 game / match 的 now 注入，不需要在生产代码加“快进 / 领取奖励”后门。真实浏览器十分钟验收至少保留一条作为服务端计时与回放配合的证据。

## 附录 D：建议的并行协作边界

用户此前明确要求多子代理协作加速。接手模型可在支持的环境中按下列边界分工；只有主代理合并交接文档和最终报告。

- **规则 / 测试代理**：battle、match与对应测试；负责确定性、经济、数值与同种子对照。
- **UI代理**：MatchArena / BattleArena及专属CSS；先约定props和字段，不改服务器奖励。
- **后端 / 社区代理**：HTTP / DB / market / social / Admin对应接口与测试；不擅改战斗规则。
- **主代理**：确认用户需求、定义接口、处理共享入口 / 配置文件、集成、全量验证、实际验收。

共享 `CombatApp.tsx`、`data.ts`、package文件和公共CSS应指定单一负责人。开始前声明改哪些文件；结束时报告diff、测试和遗留问题。不要让几个代理同时重写同一文件，也不要以并行数量替代一次可玩的闭环验收。
