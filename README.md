# replysmith

读本机的聊天记录，判断现在该往哪走，然后写一句能直接发出去的话。三步都在本机跑，聊天内容不外传。

## 三段链路

```
IN      把聊天记录读进来          shared/sources.ts
THINK   判断关系状态和下一步       server/analysis.ts + 本地判断模型
OUT     写一句话，放进剪贴板       server/pipeline.ts · server/deliver.ts
```

**IN** 有两个来源。一个是 JSON 文件（`examples/sample-sessions.json`，不依赖任何外部工具）；另一个是解密之后的微信数据库。

**THINK** 是这个工具的主体。它把最近一段对话拆成几十道选择题和评分类题目，交给本地判断模型逐题打分：对方现在的态度、关系走到哪一步、哪些话还没接住、下一步该主动还是该等。拿到的是每道题的概率分布，不是一句笼统的“感觉还行”。

**OUT** 把判断结果拼成提示词，让聊天模型写一句回复。没配聊天模型时，OUT 退回到结构化建议，只给策略和理由，不写句子。

## 剪贴板就是终点

回复生成好之后复制在剪贴板里，粘贴这个动作由你按。

自动粘贴能做（模拟键盘事件，或者直接往微信的输入框塞文本），但那样就少了一个人过目的环节。一句话的分寸要看上下文，这里的上下文不只是聊天记录。另外自动粘贴跟微信版本绑得太紧，客户端一更新就得跟着修。

## 开始之前

- **Node 22.12 或更高**。读微信数据库用 Node 自带的 `node:sqlite`，不额外装依赖。
- **判断模型**（必需）。任何说 System One 协议的服务都行，默认按 Laya 配在 `127.0.0.1:8421`。
- **聊天模型**（可选）。任何 OpenAI 兼容接口，默认按本机 Ollama 的 `qwen3:8b` 配在 `127.0.0.1:11434`。

两个模型都能换成别家，改环境变量即可，代码不用动。

## 跑起来

```bash
npm install
npm run up
```

`npm run up` 做四件事：探一下 8421 和 11434 通不通；缺哪个起哪个，已经开着的直接复用；跑一次 IN → THINK → OUT；退出时只关这次自己起的进程。

想让服务留着反复用：

```bash
npm run up:keep     # 服务不关，Ctrl+C 才收
npm run run         # 另开一个终端再跑一次
```

服务已经在跑的时候，`npm run run` 就够了。

## 配置

默认值都在代码里，一项不配也能跑。想改有三个地方，后面的覆盖前面的：

1. 代码里的默认值
2. `.env`（照 `.env.example` 抄一份）
3. 命令行环境变量

### IN：聊天记录从哪来

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SOURCE` | `manual` | `manual` 读 JSON，`wechat` 读解密后的数据库 |
| `SESSIONS_FILE` | `examples/sample-sessions.json` | `manual` 模式下的输入文件 |
| `WECHAT_DB_DIR` | 无 | `wechat` 模式下必填，指向 `wechat-decrypt` 的 `decrypted/` 目录 |
| `WECHAT_MAPPING` | `.runtime/wechat-mapping.json` | 表名和字段名的映射文件 |
| `ALLOWED_PEERS` | 无 | `wechat` 模式下必填，逗号分隔。不填会直接拒绝启动 |
| `SINCE_MS` | `0` | 只处理这个时间点之后有新消息的会话（epoch 毫秒） |
| `RELATION` | `crush` | `crush` / `new` / `couple`，影响判断时的基准 |

### THINK：判断模型

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LOCAL_ENDPOINT` | `http://127.0.0.1:8421` | 判断服务的地址 |
| `LOCAL_PORT` | `8421` | 启动器监听的端口；设了 `LOCAL_ENDPOINT` 就按后者走 |
| `LOCAL_MODEL` | `convaiinnovations/laya-multilingual` | 模型名，服务端按这个名字路由 |
| `LOCAL_DIALECT` | `systemone` | 协议方言：`systemone` / `laya` / `anyjev` |
| `LOCAL_API_KEY` | `local` | 本机服务通常不看，但有些客户端要求非空 |

### OUT：聊天模型

预设只提供 baseUrl 和 model 的默认值，剩下每个字段都能单独覆盖。

| `DRAFT_PRESET` | 地址 | 默认模型 |
| --- | --- | --- |
| `ollama` | `http://127.0.0.1:11434/v1` | `qwen3:8b` |
| `lmstudio` | `http://127.0.0.1:1234/v1` | 需自己填 |
| `vllm` | `http://127.0.0.1:8000/v1` | 需自己填 |
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `dashscope` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-8b` |
| `siliconflow` | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-8B` |
| `openai` | `https://api.openai.com/v1` | 需自己填 |
| `custom` | 需自己填 | 需自己填 |

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DRAFT_ENDPOINT` | 取预设 | 覆盖 baseUrl |
| `DRAFT_MODEL` | 取预设 | 覆盖模型名 |
| `DRAFT_API_KEY` | 空 | 只有离开本机才强制要求 |
| `DRAFT_TEMPERATURE` | `0.7` | |
| `DRAFT_MAX_TOKENS` | `700` | 思考型模型会把预算花在草稿上，上限要留出余地 |
| `DRAFT_TIMEOUT_MS` | `60000` | |
| `DRAFT_WIRE` | 取预设 | `openai` 或 `ollama`。Ollama 的兼容路由会忽略 `think:false`，本地跑思考模型必须走 `ollama` 这条原生路由 |
| `CHAT_CONFIG_PATH` | `.runtime/chat.json` | 也可以用 JSON 文件代替环境变量，逐字段合并，环境变量优先 |

换供应商只改 `DRAFT_PRESET`，代码不用碰。

### 交付

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DELIVER_MODE` | `print` | `print` 只打印，`clipboard` 写进剪贴板 |

### 启动器专用

`npm run up` 需要知道权重和可执行文件在哪。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LAYA_PYTHON` | `../.venv-laya/Scripts/python.exe` | 装 Laya 的虚拟环境 |
| `LAYA_SNAPSHOT` | 自动找 HF 缓存 | 本地权重快照目录，设了就完全不联网 |
| `OLLAMA_BIN` | `~/.local/ollama/bin/ollama.exe` | |
| `CHAT_PORT` | `11434` | 启动器监听的聊天服务端口 |

## 微信记录怎么进来

这部分需要你本人坐在这台电脑前操作，AI 替不了。

先说明一件事：这个仓库只读 `wechat-decrypt` 的**输出**，不参与提取密钥和解密。请只处理你自己已获得同意的会话。

1. 微信 PC 端保持登录，用管理员权限跑 [wechat-decrypt](https://github.com/328336690/wechat-decrypt) 的 `find_all_keys.py` 和 `decrypt_db.py`，得到一个 `decrypted/` 目录。

2. 探一下库结构，确认表名和字段能被识别：

```bash
npm run inspect -- --dir="D:/path/to/wechat-decrypt/decrypted"
```

它会列出所有表，自动认出消息表和联系人表，打印前几行。字段名跟你这版微信对不上的话，加 `--write` 生成一份映射骨架，再手工改：

```bash
npm run inspect -- --dir="D:/path/to/wechat-decrypt/decrypted" --write
```

3. 填好允许处理的会话名单，然后跑：

```bash
SOURCE=wechat \
WECHAT_DB_DIR="D:/path/to/wechat-decrypt/decrypted" \
ALLOWED_PEERS="小满" \
DELIVER_MODE=clipboard \
npm run run
```

`ALLOWED_PEERS` 为空时程序拒绝启动，这条是故意的。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run up` | 起服务，跑一次，收工 |
| `npm run up:keep` | 同上，服务留着 |
| `npm run run` | 只跑一次，假定服务已在跑 |
| `npm run inspect -- --dir=…` | 探测微信库结构 |
| `npm test` | 跑测试 |
| `npm run typecheck` | 类型检查 |

## 目录

```
server/
  pipeline.ts        IN → THINK → OUT 的编排，唯一知道三段都存在的地方
  analysis.ts        把对话拆成题目，再把答案拼回结论
  contract.ts        判断结果的结构校验，答不全就算失败
  local-decision.ts  判断服务的几种协议方言
  chat-client.ts     聊天补全，两种 HTTP 形状
  chat-config.ts     聊天模型配置的解析与校验
  deliver.ts         剪贴板和打印
shared/
  sources.ts         IN 的接口与两个实现
  wechat-db.ts       读解密后的 SQLite
  questions.ts       choice / score / noul 三种题目构造器
  chat-presets.ts    聊天模型预设
  types.ts rules.ts affinity.ts memory.ts intents.ts labels.ts
scripts/
  up.ts              一键启动
  run.ts             跑一次
  inspect-wechat-db.ts  探测库结构
tests/
```

## 已知限制

- 只处理文本消息。图片、语音、表情包在数据库里有记录但没有可读内容，会被跳过。
- 两个模型都得自己准备好。仓库不带权重，也不下载权重，启动器只去本地缓存里找。
- 没有图形界面，全部走命令行。
- 关系判断是概率输出，不是事实。它读不出你们现实里发生的事。

## 出处

`server/analysis.ts` 里的题目设计、评分维度和关系规则来自 [FerryCorleone/crush-monitor](https://github.com/FerryCorleone/crush-monitor)（MIT）。本仓库在它之上把判断模型换成本地服务，加了 IN 和 OUT 两段，去掉了网页层。

MIT License。
