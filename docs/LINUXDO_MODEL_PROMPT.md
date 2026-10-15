# 给 GLM 的任务：接入 LINUX DO 登录 / 自动注册

> 日期：2026-10-14（America/Denver）。以下是后续实现任务，不表示当前已经接入。配套设计：[LINUXDO_AUTH_DESIGN.md](LINUXDO_AUTH_DESIGN.md)。

复制下面内容交给 GLM，并让它读取当前项目源码与配套文档。

---

请在现有网页卡牌自走棋「星序 ASTERIA」项目中接入 LINUX DO Connect 登录与首次登录自动注册。不要另建项目，不要只改文档或做假登录。

## 先阅读并核对

- 当前应用 / Git 根目录：`D:\project\AI\card-game`；其他机器以实际克隆目录为准。
- 必读：`docs/LINUXDO_AUTH_DESIGN.md`、`docs/DEVELOPMENT_HANDOFF.md`。
- 公开协议证据：`docs/references/linuxdo-openid-configuration-20261014.json`。先重新 GET 官方 discovery 并核对，不只照搬旧 Wiki。
- 查看 git status / 真实入口，保护 GLM 已有改动及 review 修复；不 reset / clean，不清库，不把其他未提交文件顺手覆盖。

## 已确定的接入约定

1. 正式应用主页 / APP_ORIGIN：`https://card.shixinn.com`。
2. 新增登录入口：`GET /auth/linuxdo`。
3. 用户已取得本应用 Client ID：`uDV9hFJNhy5ulentqTAfokbDsMYIowbC`。Secret 在用户页面仍隐藏，本轮未获取，不要索要聊天明文；从服务端 `.env` 读取。
4. 控制台登记与服务端回调：**`https://card.shixinn.com/auth/linuxdo/callback`**，路由为 `GET /auth/linuxdo/callback`。不要误用 OpenAI 回调或静态首页。
5. 首次成功授权自动创建本游戏用户和 profile；后续登录复用同一内部用户、玩家编号、卡牌和余额，不能重复发初始资产。退出复用本站原接口。
6. 保留本地开发账号和现有 OpenAI 接入；LINUX DO 作为主要正式入口，不做账号自动合并 / 资产迁移，不新增密码注册、支付或 LINUX DO Credit。
7. 截图中普通账号和青春版最低等级均选 0；不在本游戏另加信任等级门槛。青春版也以实际 verified issuer / sub 为准，不按裸数字 id 合并身份。

## 当前协议与安全要求

本轮官方 discovery 实际返回：issuer=`https://connect.linux.do/`（含尾部斜杠），支持 OIDC 授权码、RS256、PKCE S256、scope openid/profile/email，以及 client_secret_basic / client_secret_post；授权、Token、UserInfo 和 JWKS 端点见设计文档。

实现 OIDC code + S256，首版 scope=`openid profile`，使用服务端一次性 state / nonce / verifier、浏览器绑定 Cookie、过期和单次消费，并与 OpenAI 事务隔离。服务端兑换 Token，使用可信 JWKS 验签并校验 iss/aud/sub/exp/iat/nonce 与条件性的 nbf/azp，不能只解码 JWT、把 access_token 当 ID Token 或静默关闭验证。

本游戏身份继续使用 `(issuer, client_id, verified sub)` → 内部 UUID；不按昵称 / 邮箱合并。新用户、profile 和会话短事务提交，上游请求在事务外执行；失败保留原登录会话和资产。

新增 `LINUXDO_CLIENT_ID`、`LINUXDO_CLIENT_SECRET`、`LINUXDO_TOKEN_AUTH_METHOD=client_secret_basic`、`ADMIN_LINUXDO_SUBJECTS` 配置。管理员仅按已验证 subject 白名单判断，首次登录 / 高信任等级不能自动提权。凭据只放服务端 .env，不放前端、VITE_*、URL、日志或 Git，不要求我把 Secret 发到聊天。

/api/auth/me 保留旧字段及 loginEnabled 的 OpenAI 语义，新增 Linux DO 可用性与 provider 标识；AccountMenu 显示真实登录 / 注册、未配置、失败和退出状态。同步核对 CombatApp / Admin 文案及切号清理，避免上一账号的快照、草稿、弹窗和迟到响应残留。

## 实施与验收

按设计文档 L1～L4 分批完成：provider / 配置与校验 → 授权路由和自动注册 → UI / 切号 → 运维说明与回归。优先复用现有 Node HTTP、jose、SQLite；更新对应 TS 类型、.env.example、Compose 和 Docker 运行依赖，不重写技术栈。

补充模拟 Token / JWKS / UserInfo 的独立自动测试：正常 / 拒绝授权、state / Cookie / PKCE / nonce / 签名 / issuer / audience / 过期 / 重放、提供者隔离、重复 / 并发注册只初始化一次、老资产不变、权限、退出和跨标签切号、上游超时 / 非 JSON / 异常重定向。测试不依赖真实在线账号或 Secret。

真实联调另行记录：回调登记、nonce 与 S256、首次 / 再次登录、抽卡后退出再登录资产保持、普通用户 / 管理员和拒绝授权。没有真实凭据也可完成代码与模拟测试，但必须标注“未真实联调”，不把 mock 测试、正式接入和上线部署混为一谈。

全程中文。**未经我明确允许，禁止执行任何编译 / 构建命令，包括 npm run build、tsc、隐式构建的 dev:local 和 Docker --build；允许不含构建的测试。** 不启动 / 重置真实用户库、不默认部署或推送；未获明确授权不自动启用子代理。

先简短说明实施范围和当前差距，再实际开发。结束报告涉及文件、实际测试、UI 证据、配置 / 回调清单、迁移 / 回滚及真实联调状态，并更新交接文档；遇到凭据缺失不伪造成功，遇到协议差异不自行降低安全校验。

---
