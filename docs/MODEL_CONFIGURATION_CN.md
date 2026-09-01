# 模型配置：BGE-M3 与 GLM-5.2

本项目配置使用以下 OpenAI 兼容服务。密钥必须由使用者手动填写；本文和代码中不保存聊天消息里的密钥。

| 用途 | 模型 | Base URL | 实际接口 |
|---|---|---|---|
| MemoryCore 向量生成 | `bge-m3` | `http://10.128.202.100:3010/v1` | `/v1/embeddings` |
| MemoryCore 抽取/总结、MemoryHub 内部 LLM | `glm-5.2` | 同上 | `/v1/chat/completions` |
| 通过 Proxy 的用户对话 | 客户端指定 `glm-5.2` | Proxy 转发至上述服务 | OpenAI 兼容 chat completions |

BGE-M3 按[作者模型卡](https://huggingface.co/BAAI/bge-m3)配置为 **1024 维**。`sendDimensions: false`，因此远程请求只发送 `model` 和 `input`；维度用于本地向量存储与返回值校验，不强行传给服务。实际服务是否与模型卡一致，仍需填入密钥后检查。

## 1. 当前 Docker 部署：在一个文件填写密钥

编辑 [deploy/global-images/.env](../deploy/global-images/.env)，手动填写以下三项：

```dotenv
MEMORY_LLM_API_KEY=填写对话服务密钥
MEMORY_EMBEDDING_API_KEY=填写向量服务密钥
PROXY_UPSTREAM_API_KEY=填写对话服务密钥
```

若服务采用同一密钥，三项可以相同，但需要分别填写。不要把它们替换成项目的用户身份 key 或 Gateway 管理 key。其余身份、数据卷和服务开关保持原样。

已设置的非敏感参数如下：

```dotenv
MEMORY_LLM_BASE_URL=http://10.128.202.100:3010/v1
MEMORY_LLM_MODEL=glm-5.2
MEMORY_LLM_PROTOCOL=openai
MEMORY_EMBEDDING_PROVIDER=openai
MEMORY_EMBEDDING_BASE_URL=http://10.128.202.100:3010/v1
MEMORY_EMBEDDING_MODEL=bge-m3
MEMORY_EMBEDDING_DIMENSIONS=1024
MEMORY_EMBEDDING_SEND_DIMENSIONS=false
PROXY_UPSTREAM_URL=http://10.128.202.100:3010/v1
PROXY_UPSTREAM_MODEL=glm-5.2
```

`.env` 和生成的私有 YAML 均被 Git 忽略。不要把填好的密钥提交到仓库；聊天中已经暴露的凭证建议轮换后再使用。

## 2. 验证实际模型接口

从仓库根目录使用 Node.js ≥22.16 执行：

```powershell
# 只验证配置与密钥是否填写，不访问网络
node deploy/global-images/check-models.mjs

# 显式联网：测试 BGE 批量输入/维度，以及 GLM 非流式对话
node deploy/global-images/check-models.mjs --live
```

缺少密钥时会在请求前退出，只显示缺少的变量名。联网检查只发送固定测试句子，不上传仓库内容或历史记忆，不打印密钥、完整向量或上游错误正文。对话与 Proxy 上游 URL、模型、密钥完全相同时复用一次对话检查。

成功只说明服务接口可用，不代表完整 Proxy 中转、工具调用、流式返回或记忆系统已经验证。`glm-5.2` 是否支持 L2/L3/Skill 所需的 tool calling 仍应单独检查；这里提供的接口样例只能确认普通 chat completions。

## 3. 填写后让 Docker 配置生效

本次只更新了宿主配置与生成脚本，**没有重启容器、替换运行中的模型或触发历史数据重建**。当前容器继续使用启动时的旧配置。

检查发现当前 Core、Proxy 的 bind mount 目标路径被 Git Bash 错误转换。启动脚本已修正 Windows 参数转换、宿主路径转换和 Core 显式配置路径；仅执行 `docker restart` 不会纠正旧挂载，也不会更新 Hub 的模型环境变量。因此填好密钥、通过接口检查后，需按以下步骤重建容器。

先确认当前数据卷已有可恢复的备份。然后在 **Git Bash / WSL / Linux** 中执行，不要直接把这些 Bash 命令粘到 PowerShell：

```bash
cd deploy/global-images
./start-memory-core.sh
./start-memory-hub.sh
./start-proxy.sh
```

脚本沿用 `.env` 指定的镜像、卷和端口，替换同名容器，期间服务会短暂中断；不会删除 named volume。Core 在替换现有容器前校验对话/Embedding 的必填项，缺密钥会立即退出。生成的 `.memory-core-config/tdai-gateway.yaml` 与 `.proxy-config/config.yaml` 每次启动覆盖，**密钥应改 `.env`，不要只改生成文件**。

仅查看挂载目标，不输出容器环境中的密钥：

```powershell
docker inspect tdai-memory-core --format '{{range .Mounts}}{{println .Destination}}{{end}}'
docker inspect tdai-proxy --format '{{range .Mounts}}{{println .Destination}}{{end}}'
```

正确目标分别应包含 `/data/config/tdai-gateway.yaml` 和 `/data/config.yaml`，不能带 Windows 盘符、Git 安装目录或 `;ro` 后缀。模型地址是内网 HTTP，宿主和容器都需能访问该网段；HTTP 本身不加密，应仅在受信任网络/VPN 中使用。

## 4. Proxy 客户端也要选择 GLM-5.2

`PROXY_UPSTREAM_MODEL` 用于部署侧选择/检查，但当前 Proxy 的普通转发不会据此强制覆盖请求体里的 `model`。客户端如果继续发送旧模型名，上游仍可能收到旧模型名。因此在实际客户端中将模型设为 **`glm-5.2`**。

这里采用用户给出的 OpenAI 兼容 `/v1/chat/completions` 协议；不能据此认定该上游也支持 Anthropic `/v1/messages`。使用仅支持 Anthropic 协议的客户端时，仍需已验证的协议转换链路。

2026-08-31 后续实测补充：当前内网网关的 `/v1/messages` 已对 `glm-5.2` 返回 HTTP 200 和 Anthropic `message` 结构；实际 Claude Code 2.1.251 经本地 Proxy 成功回复 `OK`。这是对当前网关的实测结果，不代表其他 OpenAI 兼容服务也支持该接口。网关模型列表未列出原配置中的 `deepseek-v4-pro` / `deepseek-v4-flash`，本机 Claude Code 已统一改用 `glm-5.2`，移除未经确认的 `[1M]` 后缀。

Claude Code 配置位于 `%USERPROFILE%/.claude/settings.json`。保留 `ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default`；`apiKeyHelper` 继续读取项目 `.admin-key`，不能填上游模型服务密钥。JSON 中命令应正确转义：

```json
"apiKeyHelper": "powershell.exe -NoProfile -Command \"(Get-Content -Raw 'D:/TencentDB-Agent-Memory/deploy/global-images/.admin-key').Trim()\""
```

主模型和 Haiku/Sonnet/Opus 别名统一设置 `glm-5.2`；顶层 `model` 同样设置为 `glm-5.2`。删除顶层 `max_tokens`，本机改用 `env.CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096` 限制输出。修改后退出并重新启动 Claude Code，避免旧进程继续使用缓存的凭据。首轮项目初始化的 `AskUserQuestion` 属于正常流程。

如果报 `401 Authentication failed: invalid user_key`，要检查 `.admin-key` 与当前数据卷中的用户是否匹配。`auth/verify` 返回 HTTP 200 仍可能包含 `valid=false`；必须同时验证 `code=0`、`data.valid=true` 和有效的 `data.user.user_id`。启动脚本现已检查这些字段。本机此次通过只读查询恢复了现有管理员凭据，旧凭据及 Claude Code 配置已备份到用户 `.claude` 目录；未修改数据库、关闭鉴权或重启容器。不要通过清空数据卷修复凭据不匹配。

## 5. 直接从源码运行 MemoryCore

已同步更新 [默认配置](../MemoryCore/tdai-gateway.yaml) 与 [Standalone 配置](../MemoryCore/tdai-gateway.standalone.yaml)。源码入口使用以下环境变量，不会自动读取 Docker 目录中的 `.env`：

```powershell
cd MemoryCore
$env:TDAI_LLM_API_KEY = "手动填写对话服务密钥"
$env:TDAI_EMBEDDING_API_KEY = "手动填写向量服务密钥"
$env:TDAI_LLM_BASE_URL = "http://10.128.202.100:3010/v1"
$env:TDAI_LLM_MODEL = "glm-5.2"
node --import tsx src/gateway/server.ts
```

示例中的引号内容需要替换，密钥不要粘到公开日志。已有 `TDAI_GATEWAY_CONFIG` 或 `TDAI_LLM_*` 环境变量可能覆盖 YAML，启动前需检查所选配置。若嵌入 OpenClaw 等宿主运行，还要在宿主实际 plugin 配置中同步模型；修改这两份 Gateway YAML 不会自动修改宿主设置。

未填写 Embedding key 时，配置解析器会将向量能力标记为不可用，不能把 BM25 降级当作 Hybrid 已生效。内部抽取的 maxTokens 保留现有预算；没有把 curl 中用于简短测试的 512 全局套用到 L1/L2/L3 抽取。

## 6. 已有记忆与评测边界

- 启用 Embedding 不意味着历史记录立即拥有向量；旧数据的向量覆盖与回填状态需要检查。
- 切换模型/维度时，SQLite 初始化可能重建向量表并返回需要重索引的标志。原文与 BM25 数据应保留，但是否完成回填取决于实际运行路径，不能只看配置文件；不要手工删除整个 SQLite 数据库。
- 本次没有执行迁移、历史重嵌入或向量重建，避免在密钥缺失时改变现有索引。
- LongMemEval 入口仍是已冻结的 BM25 会话基线。添加项目模型不会自动生成 Dense/Hybrid 成绩，也不会自动跑真实 L1 快照或端到端 QA；这些需独立实验与向量快照。

## 7. 本次验证范围

生产 `loadGatewayConfig`、`createEmbeddingService` 与 `StandaloneLLMRunner` 已完成离线适配检查：使用临时假凭证和模拟返回，确认 BGE 走 `/v1/embeddings`、不发送 dimensions，GLM 走 `/v1/chat/completions`。这验证了本项目的请求构造，**未验证内网真实服务**。真实接口检查必须在手动填写密钥后执行 `check-models.mjs --live`。

部署脚本也通过 Bash 语法检查及模拟 Docker 校验：生成配置包含正确模型、1024 维和 `sendDimensions: false`，Windows bind mount 目标保留 Linux 路径，缺少 Embedding key 时在替换容器前停止。验证期间没有操作真实容器。
