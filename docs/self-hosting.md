# 自托管：10 分钟自走棋与社区版

## 1. 本地试用

Node.js 24，在 `web` 目录：

```powershell
npm ci
npm run dev:local
```

打开 http://127.0.0.1:3000。账号菜单可切换玩家 A、B、C；A 可访问 `/admin`。适合自己模拟买卖、赠送和聊天。开发登录强制仅监听本机，生产模式禁止启用。

## 2. 普通服务器启动

```sh
npm ci
npm run build
cp .env.example .env
# 编辑 .env
npm start
```

运行目录必须是 `web`。部署时需要 `dist/`、`server/`、`src/engine.ts`、`src/data.ts`、`src/battle.ts`、package 文件和生产依赖。不要只上传静态 dist：交易和聊天需要后端。

生产环境配置：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
APP_ORIGIN=https://你的域名
ALLOW_DEV_LOGIN=0
DATABASE_PATH=./data/asteria.sqlite
```

通过 Nginx/Caddy 把同一域名代理到 Node 服务。不要分别跨域部署 API；写接口验证 Origin。

## 3. Docker + HTTPS

`web/compose.yaml` 已包含 Node 服务和 Caddy。在 `.env` 填写真实 `DOMAIN`，DNS 指向服务器，开放 80/443：

```sh
docker compose up -d --build
```

Compose 会固定生产模式并关闭开发登录。SQLite 存于 `game-data` 卷；不要使用 `down -v` 清掉它。Docker 配置已提供，本轮未在远程服务器实测部署。

## 4. 配置 ChatGPT 登录

[OpenAI 网站身份登录文档](https://developers.openai.com/siwc/website) 当前说明该能力处于面向选定合作伙伴的有限试用。需要先取得网站 OAuth 客户端。

```dotenv
OPENAI_CLIENT_ID=取得的真实客户端ID
OPENAI_TOKEN_AUTH_METHOD=none
OPENAI_CLIENT_SECRET=
ADMIN_OPENAI_SUBJECTS=
```

- 注册回调必须精确等于 `APP_ORIGIN/auth/openai/callback`。
- confidential client 使用 `client_secret_basic`，Secret 只放服务端 `.env`；不要放进 `VITE_*` 或提交 Git。
- 当前只申请身份信息，不申请 ChatGPT 对话或模型使用权限。
- 登录后在账号菜单查看账号 ID（OpenAI `sub`），加入 `ADMIN_OPENAI_SUBJECTS`，多个 ID 用逗号分隔，然后重启。
- 不会自动把第一个注册用户设为管理员。普通账号不能读取后台。
- 未配置 Client ID 时界面明确显示待配置，不伪装成真实登录。

## 5. 数据和规则边界

- 人口从 3 升到 6，按人口上限在 4 × 7 部署区（28 格）布阵；双方 8 × 7 战场自动移动与施法，包含射程、护甲 / 魔抗和属性 / 职业羁绊，最多 32 回合。服务器预计算确定性结果，客户端回放；服务端校验并一次结算，回放速度不影响战果或奖励。
- 36 张卡采用独立技能配置；强化每升一阶仅增加 3% 生命、2% 攻击，主要提供视觉进阶。已有局内商店、利息、经验、人口与三合星；未实现实时 PvP 或装备系统。
- 新登录账号领取一次初始资源。账号卡牌、余额与战斗均由服务端更新，不接受浏览器上传余额或旧存档。
- 挂单托管卡牌；买入、扣款、到账与卡牌转移在同一 SQLite 事务完成。请求编号防重复执行。
- 售价 10–100000 星币，每人最多 20 张在售；手续费向下取整 5%。
- 赠送不可撤回，执行前界面确认。对局使用独立临时副本，不锁定永久收藏；出售或赠送永久卡不会移走本局单位。
- 好友私聊只允许当前双方好友读取和发送；管理员统计只展示消息数量，不展示私聊正文。
- 聊天最多显示最近 50 条，限制消息长度和发送频率；这是基础社交功能，尚无完备的封禁、举报与内容治理系统。
- 无真实充值、提现、现金交易；市场只使用游戏内星币。当前战斗是 PvE，不是实时 PvP。
- 旧匿名行为统计保留 90 天；账户、资产流水、挂单和聊天目前持续保存，生产前需明确保留与备份策略。
- 单 Node/SQLite 服务适合这一版原型；上线前仍需要负载测试、经济平衡和完整运营工具。

## 6. 备份

本机数据库位于 `web/data/asteria.sqlite`。SQLite WAL 模式下，不能只复制正在使用的主文件：停服后一起备份 data 目录，或用 SQLite 在线备份接口。Docker 部署备份对应的 `game-data` 卷。


## 对局时间与货币

服务器按每轮 40 秒经营 + 35 秒战斗、8 轮共 10 分钟推进。每次账户请求会校验并补齐到当前阶段；断网重连不暂停计时、不重复发奖。局内金币/临时星级不兑换长期市场资产，只有终局奖励进入长期余额。旧单场 battle.* HTTP 路由已停用，避免绕过 10 分钟经济直接刷奖。
