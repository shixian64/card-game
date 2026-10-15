# 星序 ASTERIA｜LINUX DO 登录与自动注册设计

> 日期：2026-10-14（America/Denver）。状态：**L1～L4 已实现并完成模拟测试（2026-10-14 同日第二轮）；Client Secret 未配置、回调登记未核验、未真实联调，不是"已上线"证明**。
> 实现记录见文末第 13 节与 [DEVELOPMENT_HANDOFF.md](DEVELOPMENT_HANDOFF.md) 第 14.5 节；本文第 1～12 节保留为原始设计与验收基准。实现时重新 GET 了官方 discovery，与 [快照](references/linuxdo-openid-configuration-20261014.json) 完全一致（issuer 含尾部斜杠）。
> 工作目录：`D:\project\AI\card-game`。现有未提交改动属于其他开发工作，接手前先查看并保护，不 reset / clean。

## 1. 目标与范围

- 使用 LINUX DO Connect 作为正式玩家登录入口：**首次成功授权自动创建本游戏账号，再次登录回到原账号和原资产**。
- 不另做用户名 / 密码注册，不收取论坛密码；未拥有 LINUX DO 账号的用户去提供者注册，本游戏不替论坛开户。
- 保留现有本地 A/B/C 开发账号和 OpenAI 登录代码 / 配置；本轮以 LINUX DO 为主要正式入口，不顺带删除旧账号或重写玩法。
- 不自动绑定 / 合并测试账号、OpenAI 账号和 LINUX DO 账号，不迁移赠送资产，不按同名 / 邮箱猜测归属。
- 不做支付、充值、LINUX DO Credit、论坛发帖 / 访问密钥功能；不申请与登录无关的权限。
- 用户截图给出的部署来源为 **`https://card.shixinn.com`**；这里只记录目标配置，不证明 DNS、HTTPS、后端部署或应用申请已验收。

## 2. 协议核验与优先依据

2026-10-14 使用只读 HTTP GET 请求 [Connect 公开发现配置](https://connect.linux.do/.well-known/openid-configuration)，实际返回 HTTP 200。原始公开字段已保存为 [发现配置快照](references/linuxdo-openid-configuration-20261014.json)，不含任何应用凭据或用户信息。

| 项目 | 本轮公开响应 |
| --- | --- |
| 协议 | OpenID Connect 授权码流程；OAuth2 为其基础，不是把两者割裂成两套登录 |
| issuer | `https://connect.linux.do/`，注意尾部 `/`；令牌校验必须精确匹配 |
| 授权端点 | `https://connect.linux.do/oauth2/authorize` |
| Token 端点 | `https://connect.linux.do/oauth2/token` |
| UserInfo 端点 | `https://connect.linux.do/api/user` |
| JWKS | `https://connect.linux.do/.well-known/jwks.json` |
| 响应 / 授权方式 | `code` / `authorization_code`，另声明支持 refresh_token |
| ID Token 签名 | `RS256` |
| PKCE 支持 | `S256`；本项目选择始终启用，不据此宣称提供者一定强制 |
| Token 客户端认证 | `client_secret_basic`、`client_secret_post` |
| 可用 scope | `openid`、`profile`、`email`；本项目首版只请求 `openid profile` |

[社区 Wiki](https://wiki.linux.do/Community/LinuxDoConnect)可用于理解申请入口，但部分旧示例只描述 OAuth2，scope / 用户字段也可能与当前 OIDC 有差异。**实现时先重新核验发现配置，以实际协议为准；不照搬旧示例的 scope=user，不将 access_token 直接当作 ID Token，也不只解码 JWT 就判登录成功。**

标准参考：[OIDC Core 的 ID Token 校验](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)、[PKCE RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)、[OAuth 安全建议 RFC 9700](https://www.rfc-editor.org/rfc/rfc9700)。以下安全要求是本项目实现约束，不代表已完成真实客户端联调。

用户提供的 [应用管理页](https://connect.linux.do/dash/sso)在本轮通用抓取中不可读；后续申请表信息依据用户截图，不猜测私有页面的保存结果、Client ID 或 Secret。

## 3. 申请表：本项目填写约定

| 字段 | 建议填写 / 当前截图状态 |
| --- | --- |
| 应用名 | `card-game`（截图已填；也可由用户改为星序 ASTERIA） |
| 应用主页 | `https://card.shixinn.com` |
| 应用描述 | `星序 ASTERIA 卡牌自走棋，支持卡牌收集、养成与玩家交易。` |
| **回调地址** | **`https://card.shixinn.com/auth/linuxdo/callback`** |
| 应用图标 | 仅填写确实已部署且公开可访问的本站图标 URL；没有合适文件时先按表单要求留空，不编造不存在的 logo.png |
| 最低等级 | 截图为 0 级；首版不在游戏后端擅自增加信任等级门槛 |
| 最低等级（青春版） | 截图为 0 级；记录为用户表单现状，不代表已验证青春版的实际登录行为 |

回调地址是**接手模型将要实现的服务端路由**，不是静态首页、不是 `/api/auth/me`、不是 OpenAI 回调。控制台登记值、授权请求值和换 Token 的 redirect_uri 必须完全一致，不加无意义尾斜杠。

如管理页另有审批、协议、等级或域名验证要求，由用户依据实际页面完成；不要把截图中的“申请”视为已批准或替用户盲目提交。用户已提供接入信息页的 Client ID：`uDV9hFJNhy5ulentqTAfokbDsMYIowbC`。它是应用标识，不是密码；Client Secret 仍为隐藏状态，本轮未获取。取得 Client ID 不代表回调登记已核验、Secret 已配置或真实登录已成功。用户只在服务端 `.env` 配置 Secret，不在聊天中发送。

## 4. 用户体验与端到端流程

```text
点击「使用 LINUX DO 登录 / 注册」
  → 本站 GET /auth/linuxdo
  → 服务端建立浏览器绑定的一次性 state / nonce / PKCE 事务
  → 跳到 Connect 授权页（response_type=code，scope=openid profile，S256）
  → 用户在提供者页面登录并授权
  → 本站 GET /auth/linuxdo/callback?code=...&state=...
  → 校验并消费事务 → 服务端换 Token → 校验 ID Token / 必要资料
  → 查找或创建内部用户 + 初始化一次 profile + 创建本站会话
  → 固定跳回本站首页 → 读取 /api/auth/me 与 /api/game
```

- “注册”只是本游戏首次授权后的自动开户；不额外让玩家设置密码、填邮箱或重复注册表单。
- 新用户走现有 `game.ensureProfile()` / 初始资产逻辑，仅初始化一次，不另写一套奖励数值。
- 老用户重复授权只更新允许的展示资料与会话；卡牌、余额、挂单、好友、聊天和进行中对局不重置。
- 退出只结束本站当前会话，不声称退出了 LINUX DO 论坛，也不请求注销其账号。
- 授权拒绝、超时或校验失败不能切换当前已登录账号、清掉已有资产或产生半成品注册。

## 5. 身份模型、资产与管理员

继续复用 `users / sessions / profiles`，游戏数据仍绑定内部 `users.id`。

| 字段 | 定义 |
| --- | --- |
| `users.id` | 本游戏内部 UUID；资产、社交、API 身份头使用它 |
| `issuer` | 当前核验的 `https://connect.linux.do/`，服务端固定，不接收客户端指定 |
| `client_id` | 本站配置的 LINUXDO_CLIENT_ID |
| `subject` | **验签成功 ID Token 的 sub**，作为不透明字符串保存；不能用 username / name / email 替代 |
| `name` | 合法的昵称或用户名，缺失用默认玩家名；长度按现有 80 字符限制，展示时作为文本转义 |
| `profiles.code` | 本游戏原有公开玩家编号，不改成论坛用户名或 sub |

1. 沿用 `(issuer, client_id, subject)` 唯一键；同名不同 sub 是不同玩家，同 sub 改昵称仍是原账号。不要无迁移改变已有身份唯一键。
2. UserInfo 为可选的展示资料补充：若读取，须核对其 `sub` 与已验证 ID Token 一致；发现仅含旧 `id` 的不兼容响应要单列问题，不能因此改用昵称入库或放弃验签。
3. 青春版也按实际验签后的 issuer / sub 识别；不按“数字 id 看起来一样”跨身份合并。如果其真实 issuer 与允许值不同，先报告并确认兼容方案，不自动信任任意 issuer。
4. 新用户 / profile / 本站会话创建在一个短数据库事务中完成；唯一约束处理重复 / 并发回调，不能出现两个账号或重复发初始资源。上游网络请求在数据库事务外执行。
5. 不迁移 A/B/C 或 OpenAI 的资产到新账号；绑定 / 合并属于另一个需明确授权的任务。更换 Client ID 可能改变本项目身份命名空间，上线后不能随意更换。
6. 新增独立 `ADMIN_LINUXDO_SUBJECTS` 白名单，只匹配服务端验证的 issuer + client_id + sub；不按昵称、用户名、信任等级、首次登录或 URL 参数自动提权。
7. 管理员名单由用户把真实联调后已验证的 sub 填入服务端配置；不把客户端自报 id 当凭证，不清空旧管理员白名单。

## 6. 服务端接口与认证模块

| 接口 | 首版行为 |
| --- | --- |
| `GET /auth/linuxdo` | 检查配置 / 限频，创建一次性登录事务并跳转授权页 |
| `GET /auth/linuxdo/callback` | 完成 code + state 校验、S256 兑换、ID Token 校验、自动注册及本站会话 |
| `GET /api/auth/me` | 保留现有字段；新增 `linuxdoLoginEnabled:boolean` 和当前用户的 `provider` 标识 |
| `POST /api/auth/logout` | 复用现有退出接口、Origin 校验和会话销毁 |

- 新增 provider 标识建议为 `linuxdo / openai / development / unknown`，由服务端根据身份元组计算，不由浏览器指定。
- **现有 `loginEnabled` 保持 OpenAI 可用性的旧语义**；不能因为 Linux DO 配好就将它设 true，导致旧 UI 跳进未配置的 OpenAI 登录。
- `/api/auth/me` 只返回本游戏所需信息，不返回 Client Secret、Token、完整 UserInfo、论坛 `api_key` 或外部账号关联资料。
- 成功固定回本站 `/?login=success&provider=linuxdo`；错误只带固定错误码和 provider，前端映射中文。首版不接受任意 returnTo / redirect URL。
- 建议新增 `server/linuxdo.mjs` 隔离端点、发现配置 / JWKS、令牌兑换与验证；`index.mjs` 只负责路由、Cookie、用户会话和授权判断。
- 如果新模块会被服务端运行时导入，检查 Docker 运行阶段 COPY；不能只验证本机源码路径可运行。

## 7. 必须保留的安全边界

### 7.1 授权事务

- 使用服务端密码学随机源生成 state、nonce、verifier 和浏览器事务 Token；PKCE 使用 S256，不降级 plain。
- 每个事务记录 provider、state、nonce、verifier、有效期以及对应 client_id / redirect_uri；建议有效期 10 分钟。
- 首选新增独立 Linux DO 授权事务存储和 Cookie，不更改旧 OpenAI `transactions` 表的语义；若选择共享表，必须明确 provider 隔离与旧记录迁移并验证旧登录流程。
- Cookie 为 HttpOnly、SameSite=Lax、Path=/；HTTPS 使用 Secure / __Host- 前缀，不设置宽泛 Domain。Cookie 中不放 verifier、Token 或 Secret。
- 事务只能被匹配的浏览器、provider、state、客户端配置消费一次；拒绝缺 Cookie、缺 / 错 state、过期、重放、跨浏览器与跨提供者回调。
- 新开始同 provider 流程可使同浏览器旧事务失效；旧标签明确提示重新登录，不能误消费另一提供者的事务。

### 7.2 令牌与网络

- code 只由服务器换 Token；Secret 不进入前端包、VITE_*、URL、localStorage、源码、错误响应或日志。
- 固定可信 issuer / 端点；发现配置中的授权、Token、JWKS、UserInfo URL 必须处于预期 HTTPS 来源，不接受浏览器提供的任意端点，不跟随把凭据转交其他来源的重定向。
- 默认使用 `client_secret_basic`，只允许显式配置为提供者声明支持的 `client_secret_post`；不重用 OpenAI 的 method / secret，也不把两种方式同时发送。
- Token 请求为服务器端 POST、application/x-www-form-urlencoded，携带 grant_type=authorization_code、code、精确 redirect_uri 和 code_verifier；basic 认证放 Authorization 头，post 模式才把 client_id / client_secret 放表单，不将凭据拼进 URL。
- 授权请求带 `nonce`；ID Token 必须用可信 JWKS 验 RS256，精确校验 iss、aud、sub、exp、iat、nonce，nbf / azp 按存在条件及多受众规则校验。建议允许最多 5 秒时钟误差。
- 不能只用 jwtDecode、不能将 access_token 的外观或客户端提交的 sub 当认证依据。未知 kid 可按受控 JWKS 刷新处理，仍失败则拒绝。
- 真实联调必须确认 nonce 回传、Token 认证方式和 UserInfo 形状；若提供者行为与本次发现配置或标准约定冲突，应记录差异并提出方案，不默默关闭验证。
- 上游请求建议 10 秒超时、受限响应体、状态码与 JSON 结构检查；提供者失败不记录 / 展示原始凭据和完整响应。
- 认证响应使用 Cache-Control: no-store，回调页保持 Referrer-Policy: no-referrer；应用与反代日志对回调 code / state、Cookie、Authorization 等脱敏，不将完整授权 URL 作为报错详情。
- 只为登录使用的 access_token / refresh_token 不持久化，完成验证后丢弃；首版不做后台刷新、离线授权或论坛 API 访问。

### 7.3 会话与权限

- 登录成功后旋转本站随机会话，数据库只存哈希；复用当前 8 小时有效期。旧会话失效与新会话 / profile 提交保持一致。
- 身份验证或开户失败时保留原有会话，不提前 logout，不清空用户游戏状态。
- 生产继续强制 HTTPS，禁止开发登录；不能为了回调方便关闭 Origin、Cookie、安全头或鉴权。
- 若提供者明确给出 `active=false`，首版拒绝登录；不自行增加 trust_level 门槛，不把 silenced / trust_level 当管理员权限。额外准入规则需用户确认。
- 继续验证 X-Asteria-User：跨标签切号后旧请求必须拒绝，旧响应不能污染新账号。

## 8. 前端范围

- `AccountMenu.tsx` 未登录时显示主要入口「使用 LINUX DO 登录 / 注册」，说明“首次登录自动创建游戏账号，无需另设密码”。
- 缺配置时显示「LINUX DO 登录暂未配置」；提供者未启用不能伪造登录成功。OpenAI 入口只在它自己的配置有效时显示。
- 登录后显示真实昵称、提供者、退出入口；管理员链接仅依据服务器 admin 字段。初期使用默认头像，不强行放宽 CSP 加载远程图片。
- 授权失败按 `provider` 区分中文提示，不能把 Linux DO 的缺配置统一说成“ChatGPT 登录待配置”。
- 核对 `CombatApp.tsx` 和 `Admin.tsx` 中的未登录文案；Linux DO 可用时不应仍要求配置 OpenAI 才能使用游戏或后台。
- 账号变化时清理上一账号的快照、选中实例、阵容草稿、待处理操作、合成结果弹窗及回放状态，之后重新读取资产；网络迟到响应必须受身份 / revision 保护。
- 显式更新 AuthState 类型及测试 mock；不要重复本轮 review 中“接口改了但调用方 Promise / 字段类型没改”的问题。

## 9. 环境与部署配置（由 GLM 实现时添加）

```dotenv
# 正式站点；与控制台登记的回调来源严格一致。
APP_ORIGIN=https://card.shixinn.com
LINUXDO_CLIENT_ID=uDV9hFJNhy5ulentqTAfokbDsMYIowbC
LINUXDO_CLIENT_SECRET=
LINUXDO_TOKEN_AUTH_METHOD=client_secret_basic
ADMIN_LINUXDO_SUBJECTS=
# 生产必须关闭；不要为公网试玩开放 A/B/C。
ALLOW_DEV_LOGIN=0
```

- 凭据双空表示禁用 Linux DO 登录，服务可保留其他入口；只填一项应报清楚的配置错误，不半启用。
- 正式回调固定为 `https://card.shixinn.com/auth/linuxdo/callback`，由 APP_ORIGIN 推导，不另配置任意回调来源；不要从不可信 Host / X-Forwarded-Host 推导。
- Compose 应转发新增变量；DOMAIN 为 `card.shixinn.com`（不带协议），保留持久数据库卷。以上是配置目标，不是授权本轮执行构建或部署。
- 本地 HTTP loopback 回调仅在 Connect 控制台允许并单独登记时使用；不能假设必然支持，不能混用 localhost / 127.0.0.1 Cookie。
- 更新 `.env.example`、Compose 和自托管说明，但不要创建 / 改写真实 `.env`；不得打印现有 Secret。

## 10. 验收矩阵

自动测试使用独立内存 / 临时库、模拟 Token / JWKS / UserInfo；服务端可注入上游请求与时间，测试不得依赖真实账号、Secret 或在线 Connect。端点和身份校验不能因此在生产开放可控后门。

| 场景 | 验收标准 |
| --- | --- |
| 禁用与不完整配置 | 按约定关闭或报错；不展示假登录、不泄露配置 |
| 正常授权 | code、openid profile、state、nonce、S256 和精确回调存在；verifier 仅服务端保存 |
| 拒绝 / 异常回调 | 错 state、缺 Cookie / code、过期、重放、重复参数、提供者拒绝均无开户 / 会话副作用 |
| PKCE 与验签失败 | 错 verifier、签名 / kid / alg、iss / aud / nonce / 时间声明、空 sub 均拒绝 |
| 提供者隔离 | OpenAI 与 Linux DO 事务不能交叉使用；相同 subject 不跨 issuer / client_id 合并 |
| 上游失败 | Token / JWKS / UserInfo 超时、非 JSON、非 2xx、过大响应、异常重定向安全失败；日志不泄密 |
| 首次注册 | users + profiles + sessions 完整提交；仅一次初始化，失败事务回滚 |
| 再次 / 并发登录 | 同 sub 仍同内部 ID / 玩家编号，资产不重置、不重发奖励、不创建重复账号 |
| 昵称与同名 | 改昵称不换账号；同名不同 sub 不共享卡牌 / 钱包 |
| 老数据兼容 | 旧开发 / OpenAI 会话与资产保留；未发生隐式绑定、迁移或提权 |
| 管理员 | 只白名单 verified sub 可访问后台；普通用户 403，高信任等级也不自动提权 |
| 切号 / 退出 / 过期 | 会话旋转 / 销毁正确；旧请求被拒绝；前端无上一账号资产和结果残留 |
| 最短业务闭环 | Linux DO 登录 → 查看资产 → 抽卡 → 退出 → 再登录，资源变化保持且初始资产不重复发放 |
| UI / 部署依赖 | 登录按钮、未配置和失败提示正确；桌面 / 小屏可操作；新服务端模块进入运行镜像 |

**真实验收单独列出**：凭真实应用核对回调登记、S256 / nonce / ID Token、首次与再次登录、退出、管理员与普通用户、拒绝授权、跨标签切号；记录脱敏结果，不存 code / Cookie / Token / Secret。没有凭据时可完成代码与模拟测试，但必须写“未真实联调”，不能把 mock 成功说成接入完成。

## 11. 实施切片与文件边界

| 顺序 | 工作 | 建议涉及文件 |
| --- | --- | --- |
| L1 | 协议复核、配置解析、独立 provider 与确定性验证测试 | 新 `server/linuxdo.mjs`、认证测试、index 配置 |
| L2 | 开始 / 回调路由、授权事务、自动注册、管理员与会话 | index / store、game.ensureProfile 接线、HTTP 测试 |
| L3 | 玩家登录界面与切号清理 | AccountMenu / CombatApp / Admin、对应样式及测试 |
| L4 | 运维配置、回归与交接 | .env.example / compose / Docker运行依赖 / docs / 脱敏证据 |

每个切片先说明改动边界，再实现和测试；优先复用 Node 原生 HTTP、已安装的 jose 和 SQLite，不为登录重建技术栈。旧 review 修复与当前登录接入分清提交范围，不把无关经济 / 棋盘修改混入登录任务。未经明确授权不启用子代理、不执行编译或构建（包括隐式构建的 dev:local / Docker --build）。

## 12. 用户还需准备与后续交付

用户已取得 Client ID，仍需在 Connect 核对并保存应用主页 / 精确回调和实际登录门槛，将 Client ID 与隐藏的 Secret 安全写入服务端；需要管理员时再配置已验证 sub。头像、自定义注册表单、账号绑定 / 注销、额外等级准入、长效会话均不属于首版默认范围。

GLM 完工应提交：涉及文件与差异、实际自动测试结果、UI 证据、环境变量 / 回调清单、数据兼容与回滚说明、真实联调状态及遗留问题；同步更新本文、开发交接文档与下一模型提示词。禁止将新增登录能力、mock 验证和正式上线混为一谈。

## 13. 实现记录（2026-10-14 第二轮，L1～L4 完成）

以下为实际落地状态，与上文设计逐条对应；全部测试为模拟（内存密钥 + 模拟 discovery/JWKS/Token/UserInfo），**未真实联调**。

### 13.1 涉及文件

| 文件 | 改动 |
| --- | --- |
| `server/linuxdo.mjs` | 新增：`LINUXDO_ISSUER` 常量（含尾部斜杠）、`parseLinuxdoConfig`（双空禁用 / 缺一报错 / 方法白名单）、`verifyLinuxDoIdentity`（RS256 + iss/aud/sub/exp/iat/nonce/条件 nbf·azp/active=false）、`createLinuxdoProvider`（discovery 端点来源校验、自管 JWKS 缓存与未知 kid 受控刷新、`authorizeUrl`、`exchange`、`userinfo`；上游 10 秒超时、`redirect:'error'`、响应体上限 256KB、fetch 可注入）、`displayName` |
| `server/index.mjs` | `configFromEnv` 接入 `parseLinuxdoConfig`；新增 `GET /auth/linuxdo`（配置检查 / 限频 / 一次性事务 / S256 跳转）与 `GET /auth/linuxdo/callback`（校验消费事务 → 事务外换 Token / 验签 / 可选 UserInfo → 短事务自动注册 + `ensureProfile` + 旧会话失效 → `/?login=success&provider=linuxdo`；错误固定 `/?auth_error=not_configured|failed&provider=linuxdo`）；`/api/auth/me` 新增 `linuxdoLoginEnabled` 与用户 `provider`，`loginEnabled` 保持 OpenAI 旧语义；`isAdmin` 增加 LINUX DO 白名单分支 |
| `server/store.mjs` | 新增 `linuxdo_transactions` 表（含 client_id / redirect_uri 绑定）、`linuxdoTransaction` / `consumeLinuxdoTransaction`、`shortTransaction`；`clean` 同时清理新表；旧 `transactions` 表与 OpenAI 流程零改动 |
| `src/AccountMenu.tsx` | `AuthState` 显式新增 `linuxdoLoginEnabled` 与 `provider`；主入口「使用 LINUX DO 登录 / 注册」+ 自动注册说明；缺配置显示「LINUX DO 登录暂未配置」；`authErrorText` 按 provider 区分文案；登录后显示登录方式；退出仍走 `/api/auth/logout` |
| `src/Admin.tsx` / `src/admin.css` | 后台登录门支持 LINUX DO；不再把"缺 OpenAI 配置"当作唯一提示；新增 `.linuxdo-login` 样式 |
| `tests`（新增） | `server/linuxdo.test.mjs`（60 项）、`tests/account-ui.test.ts`（6 项） |
| 配置 / 部署 | `.env.example` 新增 LINUXDO 四变量；`compose.yaml` 转发；Dockerfile 经 `COPY server ./server` 已含新模块，jose 为运行时依赖，无需改动 |

未触碰 `src/CombatApp.tsx` 的玩法代码（登录界面直接内嵌 AccountMenu，自动获得新入口；切号清理逻辑本已存在并有测试）。

### 13.2 实测结果与验收对照

- `node --test server/*.test.mjs`：157/157（新增 60 + 既有 97 回归，OpenAI / 开发登录 / 事件 / 统计全通过）。`node --experimental-strip-types --test tests/account-ui.test.ts`：6/6。未执行任何编译 / 构建（tsc / vite / dev:local / Docker --build 均未获授权）。
- 验收矩阵覆盖：禁用与不完整配置 ✔；正常授权（code/scope/state/nonce/S256/精确回调、verifier 仅服务端）✔；拒绝 / 异常回调与重放八类 ✔；PKCE 与验签失败矩阵 ✔；提供者隔离（事务与身份双向）✔；上游失败（超时参数 / 非 JSON / 非 2xx / 过大 / JWKS / discovery）✔；首次注册短事务提交、仅一次初始化 ✔；再次 / 并发登录同内部 ID 与玩家编号、资产不重置 ✔；昵称改名不换账号、同名不合并 ✔；老数据兼容（旧会话 / OpenAI / 开发账号保留）✔；管理员白名单、普通 403、高信任不提权 ✔；会话旋转 / 失败保留 / 退出与再登录闭环（抽卡后资产保持）✔；UI 文案与后台门 ✔（源码级断言，浏览器实机 UI 未跑——构建未授权）。
- UI 证据说明：本轮未执行构建与浏览器渲染，AccountMenu/Admin 的界面证据为源码级测试断言 + 类型检查层面的静态核对；真实浏览器截图待构建授权或部署后补充。

### 13.3 配置 / 回调清单与回滚

- 部署时在服务端 `.env` 写入：`APP_ORIGIN=https://card.shixinn.com`、`LINUXDO_CLIENT_ID=uDV9hFJNhy5ulentqTAfokbDsMYIowbC`、`LINUXDO_CLIENT_SECRET=<用户自填>`、`LINUXDO_TOKEN_AUTH_METHOD=client_secret_basic`、`ADMIN_LINUXDO_SUBJECTS=<已验证 sub>`、`ALLOW_DEV_LOGIN=0`；compose `DOMAIN=card.shixinn.com`。Connect 控制台回调必须精确为 `https://card.shixinn.com/auth/linuxdo/callback`。
- 数据兼容：未改 `users` / `sessions` / `profiles` 结构与唯一键，仅新增表；旧库直接兼容，无需迁移。回滚 = 移除 env 中 LINUXDO 变量（入口自动禁用）并还原上述文件；无数据回滚需求。

### 13.4 真实联调状态：未真实联调

无 Secret、未在控制台核验回调登记、未发生任何真实 LINUX DO 登录。首次真实联调需按第 10 节"真实验收"清单执行并记录脱敏结果；若提供者实际行为（nonce 回传、UserInfo 形状、青春版 issuer）与 discovery 或本实现假设不符，先记录差异并确认方案，不自行降低校验。
