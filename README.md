# dsh-connect-baiducomate

把 **百度 Comate（文心快码）私有部署** 接入 **DeepSeek Harness (dsh)** 的 OpenAI 兼容桥接器。

dsh 把它当作普通的 OpenAI Chat Completions 提供方使用；模型推理走 Comate 额度，工具仍然由 dsh 在本地执行。

> **免责声明**
>
> 本项目不是百度官方项目，使用的是 Comate 客户端的未公开私有接口。接口可能随 Comate 版本变化而失效。使用前请确认符合你所在组织的 Comate 使用条款；由此产生的账号、额度或合规风险由使用者自行承担。

---

## 特性

- **OpenAI 兼容接口**：`/v1/models`、`/v1/chat/completions`，支持流式与非流式
- **工具调用**：Comate 的工具调用会映射到 dsh 本地工具，结果再回传给 Comate
- **MCP 工具转发**：dsh 新增的 MCP 工具会以工具目录形式传给 Comate，中途新增也会在下一轮补发
- **多模态**：支持图片输入，自动上传到 Comate 并转换成 `IMAGE` 上下文（仅视觉模型）
- **系统提示覆盖**：把 dsh 的 system prompt 作为最高优先级上下文注入，尽量覆盖 Comate 自身提示
- **会话持久化**：`sessions.json` 保存 conversation/task 映射，shim 重启不丢会话
- **用量统计**：把 Comate 的 `inputTokens/cachedInputTokens/outputTokens` 转成 OpenAI usage
- **模型选择**：支持 Comate 模型列表中的具体模型，不只 `auto`
- **协议细节**：`stop`、`tool_choice`、`parallel_tool_calls`、`max_tokens`（尽力而为）
- **结构化日志**：JSON 行日志，包含 requestId、模型、轮次、耗时、token

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

本项目把这套协议翻译成 OpenAI Chat Completions：

```
dsh  ──OpenAI──▶  comate-shim  ──私有 HTTP/SSE──▶  Comate 服务端
      ◀─────────            ◀──────────────────
       tool_calls             tool_use 事件
```

dsh 收到 `tool_calls` 后在本地执行，再把 `role:"tool"` 结果发回 shim，shim 转成 Comate 的 `toolUseResults`，继续下一轮。

---

## 环境要求

- Node.js **>= 20**（使用内置 `fetch`）
- 已安装并登录的 Comate 私有部署客户端（用于获取 `apiHost` 和 `license`）
- DeepSeek Harness（dsh）桌面端或 CLI

---

## 快速开始

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

## 接入 dsh

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

`config.json` 字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `8790` | shim 监听端口 |
| `host` | `127.0.0.1` | 监听地址，建议保持本地 |
| `apiHost` | 必填 | Comate 私有部署地址 |
| `license` | 必填 | Comate license |
| `username` | 同 license | Comate 用户名 / 标识 |
| `device` | 自动生成 | 设备标识 |
| `ide` | `zulucli` | 上报的 IDE 类型 |
| `ideVersion` | `1.7.7` | 上报的 IDE 版本 |
| `pluginVersion` | `4.12.0` | 上报的插件版本 |
| `agentId` | `1` | Comate Agent ID |
| `agentName` | `Agent` | Comate Agent 名称 |
| `modelKey` | `auto` | `model: "auto"` 时实际使用的 modelKey |
| `workspacePath` | 当前目录 | 默认工作区；dsh 运行时会自动覆盖 |
| `authToken` | 空 | 设置后 `/v1/*` 需要 `Authorization: Bearer <token>` |
| `emitReasoning` | `false` | 是否输出 `reasoning_content` |
| `overrideSystemPrompt` | `true` | 用 dsh 系统提示覆盖 Comate |
| `forwardSystemPrompt` | `false` | 非覆盖模式下转发 system prompt |
| `forwardContext` | `true` | 转发 CLAUDE.md 等项目规则 |
| `forwardTools` | `true` | 转发 dsh 独有工具目录 |
| `forwardAllTools` | `false` | 连重叠工具也一起转发 |
| `forwardToolLimit` | `20` | 最多转发多少个工具 |
| `uploadImages` | `true` | 是否上传图片 |
| `imageMaxBytes` | `20971520` | 单图最大字节数 |
| `maxImages` | `8` | 单轮最多图片数 |
| `toolMap` | 内置 | Comate 工具名 → dsh 工具名 |
| `argumentAliases` | `{}` | 额外的参数名映射 |

环境变量优先级高于配置文件：

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
- 删除 `sessions.json` 可强制重置所有会话
- shim 重启后会加载该文件；如果映射丢失，会用 dsh 历史回放兜底

---

## 常见问题

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
├── comate-shim.js          # 入口：装配与启动
├── config.example.json     # 配置模板
├── build-launcher.ps1      # 编译 Windows 启动器
├── launcher/
│   └── start-shim.cs       # 启动器源码
├── start-shim.exe          # 本地生成，已被 gitignore
├── package.json
├── scripts/
│   └── check.js            # 语法检查
└── src/
    ├── constants.js        # 常量
    ├── logger.js           # 结构化日志
    ├── config.js           # 配置加载与校验
    ├── sessions.js         # 会话持久化
    ├── upstream.js         # Comate 协议客户端
    ├── messages.js         # 消息解析与历史回放
    ├── tools.js            # 工具映射与参数转换
    ├── openai.js           # OpenAI ↔ Comate 请求/响应转换
    └── server.js           # HTTP 路由与 chat 编排
```

---

## 开发

语法检查：

```bash
npm run check
```

手动冒烟：

```bash
curl http://127.0.0.1:8790/health
curl http://127.0.0.1:8790/v1/models
```

发送一条测试请求（会消耗 Comate 额度）：

```bash
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
