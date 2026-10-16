# dsh-teleagent

把 **TeleAgent** 的档位模型接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai)，支持**工具调用**与 **1M 上下文**，并提供一个在 DSH 设置页内的**官方登录**入口。

```
OpenAI 兼容客户端 / DSH ──► dsh-teleagent ──► TeleAgent 内核（负责签名）──► 上游网关
```

## 它解决什么问题

TeleAgent 的上游网关只接受**官方内核签名**的请求。实测确认：

- 缺少签名头 → `40101 missing super agent signature headers`
- 签名版本不符 → `40104 unsupported sign version`
- **签名覆盖请求体**：替换 body 后返回 `40104 invalid signature`

因此本插件不伪造签名，而是把**官方内核当作签名传输层**：插件以无界面方式拉起内核完成鉴权与签名，自己负责请求体与响应流。登录过一次之后，**不需要保持 TeleAgent 应用运行**。

## 功能

| 功能 | 说明 |
|---|---|
| 档位模型 | `chat-flagship`(旗舰) / `chat-flash`(极速) / `chat-pro`(智能) / `chat-lite`(轻量) / `chat-nano`(轻速) |
| 1M 上下文 | 读取账号级 `preset-context.json`，与 TeleAgent 应用里"上下文长度"设置一致 |
| 工具调用 | 内核自带 agent 循环执行**只读**工具（read / glob / grep / webfetch / websearch），结果作为回答返回 |
| 官方登录 | DSH 设置页内打开官方登录页，登录后把跳转地址粘贴回来即可 |
| 请求节流 | `requestIntervalMs` 控制请求最小间隔，避免高频触发上游风控 |

## 安装

```bash
# 1) 放进 DSH profile 的 node_modules
cd ~/.dsh/profiles/desktop
cp -R /path/to/dsh-teleagent node_modules/
```

```jsonc
// 2) 注册到 package.json
{
  "dependencies": { "dsh-teleagent": "file:./node_modules/dsh-teleagent" },
  "dsh": { "profile": { "bundles": [ /* … */ "dsh-teleagent" ] } }
}
```

```bash
# 3) 重启 DSH
```

需要 `@deepseek-ai/schemastery` 作为 peer 依赖（DSH 已提供）。

## 面板

插件在 **DSH 设置页**注册一个独立分区（侧栏「设置」→ **TeleAgent**），与桌宠等插件并列，包含：

- **运行状态** — 内核是否运行、账号、凭证有效期与来源、各档位上下文、最近错误
  （内核随 DSH 启停，面板不再提供手动控制）
- **登录** — 官方登录页内嵌在面板里，登录后自动接入
- **设置** — 全部可调项
- **上下文长度** — 可编辑，带 200K / 400K / 1M 快捷按钮（与 TeleAgent 应用的设置是同一份存储）

## 登录（无需复制粘贴）

1. 面板里点「显示登录页」——官方登录页以 iframe 内嵌在面板中（该页面不设 `X-Frame-Options` / CSP `frame-ancestors`，已实测可嵌入）

   > 登录页以 `source=01`（DESKTOP 流程）加载。这个参数不可省略：页面按 `source = 已知值 ? 值 : WEB` 解析，不带它就会走 WEB 流程，redirect 指向另一个 origin，表现为「登录已超时」。
2. 用**手机号 + 验证码**在官方页面登录
3. 官方页面的 `loginRedirect` 中继会把回调地址 postMessage 给 `window.parent`，面板**自动接收 token 并完成接入**

> **隐私**：手机号、密码、验证码全部只提交给官方页面（`agent.teleai.com.cn`），插件既不读取也不中转。插件只接收登录完成后签发的会话 token。

**回退**：若你本机装过 TeleAgent 应用并已登录，插件会直接复用应用存储里的会话 token，无需任何操作。

凭证解析优先级：**官方登录保存的 token → 应用存储里最新的 token**。

## 配置

在 DSH 插件设置页修改，改动即时生效：

| 设置 | 默认 | 说明 |
|---|---|---|
| `tier` | `chat-flagship` | 默认档位 |
| `tools` | `true` | 是否启用只读工具 |
| `autoStart` | `true` | DSH 启动时自动拉起内核 |
| `maxTokens` | `0` | 单次最大输出（0 = 用档位默认） |
| `requestIntervalMs` | `1200` | 请求最小间隔（毫秒） |
| `enginePort` | `4399` | 内核本地 API 端口 |
| `proxyPort` | `8795` | 签名代理端口 |
| `kernelPath` | 自动探测 | 内核二进制路径 |
| `stateDir` | `~/.dsh/teleagent` | 内核数据目录 |

环境变量：`TA_PROVIDER_APIKEY`（覆盖 provider apiKey）、`TA_PROVIDER_BASEURL`（自建端点）、`TELEAGENT_HOME`（TeleAgent 安装位置）、`TELEAGENT_ASAR`（客户端 bundle 路径）。

## 诊断

运行状态写入 `~/.dsh/teleagent/status.json`：内核是否运行、账号、token 有效期与来源、各档位上下文、最近错误。

```bash
node regression.mjs   # 离线自检，不发任何上游请求
```

## 已知边界

- **不支持第三方工具定义**。上游签名覆盖请求体，无法把调用方的 `tools` 注入已签名请求。工具集固定为内核自带的只读集合，写操作默认关闭（启用等于把本机写权限暴露给调用方）。
- **工具调用对 DSH 呈现为一段最终文本**（内核跑完循环后返回），不是 DSH 原生的 `tool-call` 分片。
- **底层模型未公开**。应用提示词禁止模型暴露真实身份，模型自述不可信（实测会编造系统信息）。
- 需要本机已安装 TeleAgent（提供内核二进制），但**不需要它保持运行**。
- 仅供个人在自有账号上使用；请遵守 TeleAgent 的服务条款。

## 关于凭据

仓库内**不含任何密钥**。插件运行所需的值全部在你本机解析：

| 值 | 来源 |
|---|---|
| 会话 token | 面板官方登录（`~/.dsh/teleagent/token.txt`，0600），或 TeleAgent 应用本地存储 |
| provider apiKey | **运行时从你已安装的客户端 bundle 中读取**（首次解析后缓存到 `~/.dsh/teleagent/provider-key.txt`，0600），可用 `TA_PROVIDER_APIKEY` 覆盖 |
| deviceId / installId | 运行时从 `app-auth/device-meta.json` 读取 |

provider apiKey 是编译进官方客户端的共享常量（对每台安装都相同、不由账号派生），但本插件不把它写进仓库——需要时从你自己的那份客户端里取。

## 许可

MIT
