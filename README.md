# dsh-connect-baiducomate

把 **百度 Comate（文心快码）私有部署** 接入 **DeepSeek Harness (dsh)**。

同一个仓库提供两种接入方式，共用一套 Comate 协议实现：

| 方式 | 形态 | 适合谁 |
|---|---|---|
| **dsh 插件（推荐）** | 原生 `LlmAdapter`，`dsh plugin add` 装上即用，不额外起进程 | dsh 用户 |
| **HTTP 桥接器** | 独立 Node 进程，暴露 OpenAI 兼容 `/v1`，供任何 OpenAI 客户端使用 | 其它客户端、调试、非 dsh 场景 |

两种方式都由 dsh 在本地执行工具；模型推理走 Comate 额度。

> **免责声明**
>
> 本项目不是百度官方项目，使用的是 Comate 客户端的未公开私有接口。接口可能随 Comate 版本变化而失效。使用前请确认符合你所在组织的 Comate 使用条款；由此产生的账号、额度或合规风险由使用者自行承担。

---

## 特性

- **两种形态一套内核**：插件与 HTTP 桥接器共用 `src/` 里的协议、工具映射与会话存储
- **界面内配置**：装好后在 dsh 的 设置 → 插件 里填部署地址和 license，不用装 Comate 客户端、不用手改 YAML；保存后下一轮对话生效，无需重启
- **原生 LLM 路由**：插件形态下 dsh 直接调用 Comate 私有协议，没有 HTTP 中转，也没有端口
- **动态模型列表**：模型 ID、上下文容量、图片能力直接从 Comate 目录读取，不再手抄 yaml
- **工具调用**：Comate 的工具调用会映射到 dsh 本地工具，结果再回传给 Comate
- **MCP 工具转发**：dsh 新增的 MCP 工具会以工具目录形式传给 Comate，中途新增也会在下一轮补发
- **多模态**：支持图片输入，读取 dsh 附件后上传到 Comate 并转换成 `IMAGE` 上下文（仅视觉模型）
- **系统提示覆盖**：把 dsh 的 system prompt 作为最高优先级上下文注入，尽量覆盖 Comate 自身提示
- **会话持久化**：`sessions.json` 保存 conversation/task 映射，插件/桥接器重启不丢会话
- **用量统计**：把 Comate 的 `inputTokens/cachedInputTokens/outputTokens` 转成 dsh `TokenUsage`
- **协议细节**：`stop`、`max_tokens`、空回合重试（`EMPTY_RESPONSE`）按 dsh 约定上报
- **结构化日志**：JSON 行日志，包含模型、轮次、耗时、token

---

## 作为 dsh 插件使用（推荐）

### 原理

dsh 的 Agent 循环留在本地：它组装请求、保存工具、执行工具。插件只负责协议翻译和 Comate 侧的会话映射。

```
dsh agent loop ──GenerateOptions──▶ ComateAdapter ──私有 HTTP/SSE──▶ Comate
      ▲                                  │
      └──────────StreamChunk─────────────┘
        tool-call 』 → dsh 本地执行 → tool 消息 → 下一轮 toolUseResults
```

插件注册一个 provider 路由 `comate`，实现在 `lib/`：

- `lib/index.mjs`：cordis 插件入口（`name` / `inject` / `apply`），注册路由并管理会话存储
- `lib/adapter.mjs`：`LlmAdapter` 实现，`stream()` 把 Comate SSE 翻成 `StreamChunk`
- `lib/round.mjs`：dsh 消息块 → 共享内核认识的轮次结构
- `lib/config.mjs`：载入并校验行配置（不通过就报错，但绝不让 dsh 起不来）

### 安装

```bash
# 从本地检出安装（会链接这个目录）
dsh plugin --profile desktop add D:\path\to\dsh-connect-baiducomate

# 或从 git 安装（需要 lib/ 已提交；本仓库不生成构建产物）
dsh plugin --profile desktop add github:FreshFeel1ng/dsh-connect-baiducomate
```

安装后 `dsh.profile.bundles` 会多出 `dsh-connect-baiducomate`，它的 `cordis.patch.yml` 插入一行 `comate` 插件。

### 配置（在 dsh 界面里填，推荐）

装完重启 dsh，然后：

```
设置 → 插件 → dsh-connect-baiducomate → 行 comate → 配置
```

能填的字段：

| 字段 | 说明 |
|---|---|
| `apiHost` | Comate 私有部署地址，例如 `http://192.168.1.10:9359`（必须 http/https） |
| `license` | 账号凭证，密码框输入；已保存后留空表示不修改 |
| `displayName` | 模型选择器里显示的提供方名称 |
| `modelKey` | 模型选 `auto` 时实际请求的模型 ID |
| `workspacePath` | 兜底工作目录，可留空 |
| `emitReasoning` / `forwardTools` / `uploadImages` | 三个开关 |

保存写入的是 profile 自己的 patch 层，并**在下一轮对话即时生效**（这些字段是 volatile 的，dsh 不会为改配置重启插件）。所以：

- 不需要安装、更不需要登录 Comate 客户端——`apiHost` 和 `license` 向管理员索取即可
- 表单里没有的字段（`toolMap`、`argumentAliases`、各类上限）仍然写 YAML，见下面的「手工配置」

> 表单只在 dsh `0.2.0-rc.2` 及以上出现。更老的版本不会注册这个页面，退回手工配置。

### 手工配置（可选，字段更全）

行配置不随包发布部署信息，请写在 *profile 自己的* patch 层（`%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`），它会覆盖 bundle 里的同一行：

```yaml
- id: comate
  config:
    apiHost: http://comate.example.internal:9359   # 你的 Comate 私有部署地址
    license: <your-license-uuid>                   # 也可不写，用 COMATE_LICENSE 或 ~/.comate/cli-login.json
    workspacePath: D:\work\repo           # 兜底工作目录；运行时以 dsh 会话为准
```

### 从 HTTP 桥接器迁移

一个 provider 路由只能由一个适配器持有。如果 profile 里还留着旧的 `llm-pi-ai` 行，其 `providers.comate` 必须删掉，否则注册会失败并提示 `DUPLICATE_ADAPTER`。删掉那段后，`agent-default-model` 里的 `provider: comate` 可以保持不变，继续指向本插件。

### 验证

```bash
dsh --profile desktop --dump-config     # 应能看到 dsh-connect-baiducomate 这一层
```

重启 dsh 后，模型选择器里的 `Comate` 提供方会列出 Comate 目录里的全部模型（不再需要手写 `models:`）。不想动现有 profile 时，可以像下面这样开一个一次性 profile 验证：

```bash
dsh --profile comate-test --from-default-profile headless --dump-config
dsh plugin --profile comate-test add D:\path\to\dsh-connect-baiducomate
dsh --profile comate-test --patch ./overlay.yml headless "Reply with PONG"
```

`overlay.yml` 只需要写 `comate` 行的部署信息和默认模型：

```yaml
- id: comate
  config:
    apiHost: http://comate.example.internal:9359
    license: <your-license-uuid>
- id: agent-default-model
  config:
    provider: comate
    model: auto
```

离线与联网自测：

```bash
npm test          # 12 项，全离线（假客户端 + dsh-llm 打桩）
npm run test:live # 真打一次 Comate，消耗少量额度
```

### 与桥接器形态的差异

dsh 不向适配器发送 `tool_choice` / `parallel_tool_calls`，插件形态下「能不能用工具」完全由 dsh 本轮传下来的工具列表决定（列表为空时插件会让 Comate 只用文字回答）；其它行为（工具映射、系统提示覆盖、工具目录补发、图片上传、历史回放兜底）与桥接器一致。

---

## 作为 OpenAI 兼容桥接器使用

浏览器/其它客户端/命令行工具想复用 Comate 额度时，用这个形态：dsh 把它当作普通的 OpenAI Chat Completions 提供方；模型推理走 Comate 额度，工具仍然由 dsh 在本地执行。

---

## 工作原理

Comate 私有部署没有公开的模型级 API。它的 Agent 循环在服务端，客户端通过三步驱动：

1. `POST /api/aidevops/autocomate/rest/autowork/v2/conversation` 创建会话
2. `POST .../v2/task` 创建任务
3. `POST .../v2/execute` 提交 query / 工具结果，读取 SSE 事件

SSE 事件里包含：

- `ANSWER.delta`：文本增量
- `FUNCTION_CALL_START / PARAMS_APPEND / END`：结构化工具调用
- `TOKEN_USAGE`：用量

两种形态都建立在这套三步协议之上：插件形态把它直接翻成 dsh 的 `StreamChunk`，桥接器形态把它翻成 OpenAI Chat Completions。

```
插件：  dsh agent loop ──StreamChunk/GenerateOptions──▶ ComateAdapter ──私有 HTTP/SSE──▶ Comate 服务端
桥接器：dsh ──OpenAI──▶ comate-shim ──私有 HTTP/SSE──▶ Comate 服务端
```

dsh 收到工具调用后在本地执行，再把结果作为工具结果发回去（插件形态是 `tool` 消息，桥接器形态是 `role:"tool"`），内核转成 Comate 的 `toolUseResults` 继续下一轮。

---

## 环境要求

- Node.js **>= 20**（桥接器；插件形态要求 >= 22，与 dsh 一致）
- Comate 私有部署的 `apiHost` 与 `license`（向管理员索取；界面上填写即可，**不需要**安装或登录 Comate 客户端。若本机已登录 Comate，`license` 可留空自动读取 `~/.comate/cli-login.json`）
- DeepSeek Harness（dsh）桌面端或 CLI（插件形态要求 `>= 0.2.0-rc.2`）

---

## 快速开始（HTTP 桥接器）

### 1. 克隆仓库

```bash
git clone https://github.com/FreshFeel1ng/dsh-connect-baiducomate.git
cd dsh-connect-baiducomate
```

### 2. 创建配置

```bash
cp config.example.json config.json
```

Windows PowerShell：

```powershell
Copy-Item config.example.json config.json
```

### 3. 填写 `config.json`

最少需要填：

```json
{
  "apiHost": "http://<your-comate-host>:9359",
  "license": "<your-comate-license>",
  "username": "<your-comate-username-or-license>",
  "workspacePath": "C:\\path\\to\\your\\workspace"
}
```

说明：

- `apiHost`：你的 Comate 私有部署地址。可以从 Comate IDE 引擎日志里的 `HTTP HOST:` 找到，或向管理员确认。
- `license`：Comate 登录后获得的 license。也可以不写，改用环境变量 `COMATE_LICENSE`。
- `username`：一般与 `license` 相同；不确定时填 license。
- `device`：可留空，shim 会自动生成；如果需要固定设备标识，填 Comate 客户端的 device id。
- `workspacePath`：默认工作目录。实际使用时 shim 会优先从 dsh 的 runtime-context 消息里读取当前工作区，这里只是兜底。

> **不要提交 `config.json`。** `.gitignore` 已经忽略它。

### 4. 启动

```bash
npm start
```

或：

```bash
node comate-shim.js
```

启动成功会看到：

```json
{"event":"shim.start","url":"http://127.0.0.1:8790",...}
{"event":"models.loaded","count":15}
```

#### Windows 一键启动（可选）

项目自带一个 C# 启动器，可以双击运行：

```powershell
# 首次使用，先编译出 start-shim.exe
powershell -ExecutionPolicy Bypass -File .\build-launcher.ps1
```

之后直接双击 `start-shim.exe`。它会：

1. 检查 `8790` 是否已被占用，已运行则弹窗提示
2. 自动在 `PATH` 或常见安装目录中查找 `node.exe`
3. 打开一个新的控制台窗口运行 shim，并保留窗口方便查看日志
4. shim 退出后窗口不会立即关闭，方便查看错误

把 `start-shim.exe` 的快捷方式放进 `shell:startup`（Win+R 输入）即可开机自动启动。

启动器只是调用本机的 Node，仍需先安装 Node.js 20+。`.exe` 已被 `.gitignore` 忽略，源码在 `launcher/start-shim.cs`。

### 5. 验证

```bash
curl http://127.0.0.1:8790/health
curl http://127.0.0.1:8790/v1/models
```

简单对话：

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer local" \
  -d '{
    "model": "auto",
    "stream": false,
    "messages": [{"role": "user", "content": "Reply with OK"}]
  }'
```

---

## 获取 Comate 信息

### apiHost

Comate 客户端启动时会连接私有服务端。可以从 Comate 引擎日志中找到：

```
HTTP HOST: http://192.168.x.x:9359
Api Base Url: http://192.168.x.x:9359
```

把该地址填入 `config.apiHost`，不要带结尾 `/`。

### license

登录 Comate 后，CLI 凭据通常位于：

```
~/.comate/cli-login.json
```

其中包含 `license` 字段。也可以：

- 直接填入 `config.json`
- 或设置环境变量：`COMATE_LICENSE=...`
- 或运行 `zulu login` 后让 shim 自动读取 `cli-login.json`

`license` 等同于账号凭证，**不要提交到仓库或发给别人**。

---

## 接入 dsh（HTTP 桥接器形态）

> 插件形态不需要这一节。只有当你选择让 dsh 通过 OpenAI 兼容端口访问 shim 时，才需要下面的 provider 配置。

### 配置文件位置

dsh 的 profile 配置位于：

- Windows：`%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`
- macOS / Linux：`~/.dsh/profiles/<profile>/cordis.patch.yml`

常见 profile：

- `dsh web`：`web`
- dsh 桌面端：`desktop`

### 添加 provider

在 `cordis.patch.yml` 末尾追加（注意 YAML 缩进）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      comate:
        displayName: Comate
        api: openai-completions
        baseURL: http://127.0.0.1:8790/v1
        headers:
          Authorization: Bearer comate-shim
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: auto
            name: Comate Auto
            contextWindow: 1000000
            maxTokens: 320000
            input: [ text ]
```

`Authorization` 只是为了让 pi-ai 认为有凭据；shim 默认不校验它。如果你在 `config.json` 里设置了 `authToken`，这里必须填相同的值：

```yaml
headers:
  Authorization: Bearer <your-auth-token>
```

### 添加具体模型

从 `GET /v1/models` 获取模型 ID、上下文容量和图片支持：

```bash
curl http://127.0.0.1:8790/v1/models
```

示例返回：

```json
{
  "id": "<vision-model-id>",
  "name": "GLM-5v-Turbo",
  "context_window": 200000,
  "max_tokens": 320000,
  "supports_image": true
}
```

在 `models` 下添加：

```yaml
          - id: <model-id>
            name: Deepseek V4 Flash
            contextWindow: 1000000
            maxTokens: 320000
            input: [ text ]

          - id: <vision-model-id>
            name: GLM-5v-Turbo
            contextWindow: 200000
            maxTokens: 320000
            input: [ text, image ]
```

说明：

- `contextWindow` 使用 `/v1/models` 的 `context_window`
- `maxTokens` 使用 `max_tokens`
- `supports_image: true` 的模型才写 `input: [ text, image ]`
- 不写 `image` 时，dsh 会在发送前拒绝图片

### 重启 dsh

保存配置后**完全重启 dsh**，在模型选择器里应该能看到 `Comate` 提供方和配置的模型。

---

## 配置参考

插件行（profile patch 里的 `- id: comate`）与桥接器的 `config.json` 使用同一套字段名，差别只有三行：插件形态不需要 `port` / `host` / `authToken`（没有 HTTP 监听），另外多了 `displayName` 与三个会话存储字段。

其中 **`apiHost`、`license`、`displayName`、`modelKey`、`workspacePath`、`emitReasoning`、`forwardTools`、`uploadImages`** 这 8 个是 volatile 的，可以直接在 设置 → 插件 的表单里改，保存后即时生效；其余字段只能写 YAML。

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `8790` | shim 监听端口（**仅桥接器**） |
| `host` | `127.0.0.1` | 监听地址（**仅桥接器**） |
| `authToken` | 空 | 设置后 `/v1/*` 需要 `Authorization: Bearer <token>`（**仅桥接器**） |
| `apiHost` | 必填 | Comate 私有部署地址 |
| `license` | 必填 | Comate license（可用 `COMATE_LICENSE` 或 `~/.comate/cli-login.json`） |
| `username` | 同 license | Comate 用户名 / 标识 |
| `device` | 自动生成 | 设备标识 |
| `ide` | `zulucli` | 上报的 IDE 类型 |
| `ideVersion` | `1.7.7` | 上报的 IDE 版本 |
| `pluginVersion` | `4.12.0` | 上报的插件版本 |
| `agentId` | `1` | Comate Agent ID |
| `agentName` | `Agent` | Comate Agent 名称 |
| `modelKey` | `auto` | `model: "auto"` 时实际使用的 modelKey |
| `workspacePath` | 当前目录 | 默认工作区；dsh 运行时会自动覆盖 |
| `displayName` | `Comate` | 模型选择器里显示的提供方名称（**仅插件**） |
| `sessionTtlMs` | `3600000` | Comate 会话映射的存活时间（**仅插件**） |
| `maxSessions` | `200` | 最多保留多少个会话映射（**仅插件**） |
| `sessionsFile` | `~/.dsh/dsh-connect-baiducomate/sessions.json` | 会话映射文件（**仅插件**） |
| `emitReasoning` | `false` | 是否输出推理块 |
| `overrideSystemPrompt` | `true` | 用 dsh 系统提示覆盖 Comate |
| `forwardSystemPrompt` | `false` | 非覆盖模式下转发 system prompt |
| `forwardContext` | `true` | 转发工作区规则等上下文 |
| `forwardTools` | `true` | 转发 dsh 独有工具目录 |
| `forwardAllTools` | `false` | 连重叠工具也一起转发 |
| `forwardToolLimit` | `20` | 最多转发多少个工具 |
| `uploadImages` | `true` | 是否上传图片 |
| `imageMaxBytes` | `20971520` | 单图最大字节数 |
| `maxImages` | `8` | 单轮最多图片数 |
| `toolMap` | 内置 | Comate 工具名 → dsh 工具名 |
| `argumentAliases` | `{}` | 额外的参数名映射 |

环境变量优先级高于配置文件（两种形态都适用）：

```
COMATE_PORT
COMATE_HOST
COMATE_API_HOST
COMATE_LICENSE
COMATE_USERNAME
COMATE_DEVICE
COMATE_WORKSPACE
COMATE_SHIM_TOKEN
COMATE_AUTH_DIR
```

---

## HTTP API

### `GET /health`

```json
{
  "status": "ok",
  "uptime": 120,
  "upstream": "http://...",
  "sessions": 3,
  "models": 15
}
```

### `GET /v1/models`

返回 OpenAI 模型列表，额外字段：

- `context_window`
- `max_tokens`
- `supports_image`

### `GET /v1/models/:id`

单个模型信息。

### `POST /v1/chat/completions`

兼容 OpenAI Chat Completions：

- `model`：`auto` 或 `/v1/models` 中的 ID
- `messages`：支持 `system` / `user` / `assistant` / `tool`
- `tools`：OpenAI 工具定义
- `stream`：是否流式
- `stop`：字符串或数组，客户端截断
- `tool_choice`：`none` / `required` / `{"type":"function","function":{"name":"..."}}`
- `parallel_tool_calls`：`false` 时最多保留一个工具调用
- `max_tokens`：尽力透传，Comate 可能忽略

图片消息示例：

```json
{
  "model": "glm-5v-turbo_...",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "识别图中文字" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
      ]
    }
  ]
}
```

---

## 工具映射

Comate 服务端工具 → dsh 工具：

| Comate | dsh |
|---|---|
| `Glob` | `glob` |
| `Grep` | `grep` |
| `Read` | `read` / `read_image`（图片路径自动改写） |
| `Write` | `write` |
| `Edit` / `MultiEdit` / `ApplyPatch` | `edit` |
| `Bash` / `RunCommand` | `bash` / `pwsh` |
| `ListDir` / `LS` | `glob` |
| `WebSearch` | `web_search` |
| `WebFetch` | `web_fetch` |
| `Skill` | `skill` |
| `TodoWrite` | `todo_write` |
| `Task` | `subagent` |

参数会自动做同义词映射和类型转换，例如：

- `target_directory` → `path`
- `query` → `pattern`
- `offset` / `limit` 字符串 → 数字
- `cmd` → `command`
- 嵌套数组/对象被写成 JSON 字符串时（Comate 按文本流式产出参数，例如 `questions: "[{...}]"`），按 schema 解析回真正的数组/对象；解析失败则原样转发，让 dsh 报出明确错误
- 未在 dsh schema 中声明的字段会被裁掉

dsh 独有的工具（MCP、`job_*`、`session_*`、`terminal_*`、`schedule_*` 等）会通过 `<client_tools>` 目录注入给 Comate；工具集变化时会自动补发。

---

## 会话

会话映射保存在 `sessions.json`：

```json
{
  "<hash>": {
    "conversationId": 123,
    "taskId": 456,
    "traceId": "...",
    "started": true,
    "created": 1794450000000,
    "lastUsed": 1794450000000,
    "toolNames": {},
    "toolCatalogHash": "...",
    "contextHash": "...",
    "systemPromptHash": "..."
  }
}
```

- TTL：1 小时
- 最多 200 条
- 删除该文件可强制重置所有会话
- 进程/插件重启后会加载该文件；如果映射丢失，会用 dsh 历史回放兜底
- 桥接器的文件是仓库里的 `sessions.json`；插件的是 `~/.dsh/dsh-connect-baiducomate/sessions.json`（可用 `sessionsFile` 改）
- 插件形态下键是 `dsh sessionId::model`，也就是说同一个 dsh 会话稳定复用同一个 Comate conversation/task

---

## 常见问题

### 设置 → 插件 里没有「配置」按钮

按顺序排查：

1. dsh 版本低于 `0.2.0-rc.2`：老版本没有插件配置表单，只能手改 patch
2. 装完没有重启 dsh：浏览器半侧（`lib/client.js`）是启动时送达的
3. 本包是本地链接安装时，profile 的 `node_modules/dsh-connect-baiducomate` 必须是 **junction/软链**而非拷贝，否则改了代码不生效
4. 该行没有出现在配置台账里：`dsh --profile <name> --dump-config` 应能看到 `- id: comate`

### `DUPLICATE_ADAPTER`: an adapter for provider "comate" is already registered

插件路由和旧的 HTTP 方案撞了。profile 的 patch 里如果还有 `llm-pi-ai` 行的 `providers.comate`（指向 `127.0.0.1:8790`），删掉它再重启 dsh。`agent-default-model` 里的 `provider: comate` 不需要改。

### `MISSING_CREDENTIAL` / 401 / 403

检查：

- `config.license` 是否正确
- 是否设置了 `COMATE_LICENSE` 且覆盖了配置
- license 是否过期
- `apiHost` 是否能访问

### `model not found`

dsh 配置里的模型 ID 不在 Comate 当前模型列表中。重新执行：

```bash
curl http://127.0.0.1:8790/v1/models
```

更新 `cordis.patch.yml` 后重启 dsh。

### `SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)`

这是 **dsh 在 Windows 上的沙箱 ACL 问题**，不是 shim 或 Comate 的错误。

处理：

1. 在 dsh 里把会话权限切到 **完全访问 / danger-full-access**
2. 或运行 dsh 自带的 `diagnose-windows-sandbox-acl` skill
3. OCR、纯文件读写等任务不需要 shell，可以忽略该错误

### `cannot read ...: binary file`

Comate 试图用 `Read` 读取图片。shim 会把图片路径自动改写成 dsh 的 `read_image`；如果仍然出现，确认 dsh 已注册 `read_image` 工具。

### `invalid arguments: "xxx" must be an array`

Comate 把嵌套数组参数写成了 JSON 字符串（`"questions": "[{...}]"`），而 dsh 的客户端工具校验只接受真正的数组。`src/tools.js` 会按 schema 把它解析回来；如果仍然报这条，多半是上游把参数流式输出到一半被截断，重试一次即可。同类字段还有 `present.files`、`todo_write.todos`、`schedule_create.questions`。

### `empty_response`

Comate 偶尔返回空轮次。重新发送，或新建 dsh 会话。

### 工具调用报“未知工具”

Comate 调用了 dsh 没有的工具。模型会根据错误自行调整；也可以在 `toolMap` / `argumentAliases` 中补充映射。

### Comate 升级后接口 404

私有接口可能变化。需要重新抓包确认：

- `conversation` / `task` / `execute` 路径
- SSE 事件字段
- 图片上传路径

对应代码在 `src/upstream.js`。

---

## 安全

- `config.json`、`sessions.json` 已在 `.gitignore` 中
- 默认只监听 `127.0.0.1`
- 如需被其他机器访问，设置 `authToken` 并配置防火墙
- `license` 是账号凭证，泄露后可被他人消耗额度
- `sessions.json` 包含 Comate conversation/task id，不包含 license

---

## 项目结构

```
.
├── lib/                    # dsh 插件（原生 LLM 适配器）
│   ├── index.mjs           # cordis 入口：name / inject / Config / apply，注册 comate 路由
│   ├── schema.mjs          # 行的 Config schema：决定设置面板里出现哪些字段
│   ├── client.js           # 浏览器半侧：设置 → 插件 里的配置表单
│   ├── adapter.mjs         # LlmAdapter 实现：stream / listModels / resolveModel
│   ├── round.mjs           # dsh 消息块 → 共享内核的轮次结构
│   └── config.mjs          # 插件行配置解析（失败不退出进程）
├── cordis.patch.yml        # bundle patch：插入 comate 插件行
├── comate-shim.js          # HTTP 桥接器入口：装配与启动
├── config.example.json     # 桥接器配置模板
├── build-launcher.ps1      # 编译 Windows 启动器
├── launcher/
│   └── start-shim.cs       # 启动器源码
├── start-shim.exe          # 本地生成，已被 gitignore
├── package.json
├── scripts/
│   └── check.js            # 语法检查（src/ + lib/）
├── test/
│   ├── adapter.test.mjs    # 离线：适配器转换与流翻译
│   ├── plugin-entry.test.mjs # 离线：插件入口注册（dsh-llm 打桩）
│   ├── fixtures/
│   └── live-smoke.mjs      # 联网：真打一次 Comate
└── src/                    # 两种形态共用内核
    ├── constants.js        # 常量
    ├── logger.js           # 结构化日志
    ├── config.js           # 桥接器配置加载与校验
    ├── sessions.js         # 会话持久化
    ├── upstream.js         # Comate 协议客户端
    ├── messages.js         # 消息解析与历史回放
    ├── tools.js            # 工具映射与参数转换
    ├── openai.js           # OpenAI ↔ Comate 请求/响应转换
    └── server.js           # HTTP 路由与 chat 编排
```

---

## 开发

静态检查与离线测试：

```bash
npm run check
npm test
```

联网冒烟（会消耗 Comate 额度，走真实 Comate 会话）：

```bash
npm run test:live
```

桥接器形态的手动冒烟：

```bash
curl http://127.0.0.1:8790/health
curl http://127.0.0.1:8790/v1/models
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","stream":false,"messages":[{"role":"user","content":"Reply with OK"}]}'
```

---

## License

[MIT](LICENSE)

---

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- 百度 Comate（文心快码）

本项目与百度官方无关。
