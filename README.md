# replysmith

读本机的聊天记录，判断现在该往哪走，然后写一句能直接发出去的话。三步都在本机跑，聊天内容不外传。

## 三段链路

```
IN      把聊天记录读进来                shared/sources.ts
THINK   判断关系走向和每句话的状态       server/analysis.ts + 本地判断模型
OUT     给几条不同方向的回复，挑一条     server/candidates.ts · server/deliver.ts
```

**IN** 有两个来源。一个是 JSON 文件（`examples/sample-sessions.json`，不依赖任何外部工具）；另一个是解密之后的微信数据库。

**THINK** 是这个工具的主体，它跑两轮题。第一轮看整体：五个维度各自打分，加权成好感度，判断关系走到哪一步，决定下一步该主动还是该等，同时留下它考虑过的另一条路。第二轮看逐句：对方每句话的情绪分布和意图分布，你自己每句话的表达质量，从 SSS 到 D 分档。两轮都是概率输出。

**OUT** 按判断结果分几个方向各写一句。方向从主推动作、它权衡过的备选、以及退一步的动作里取，最多三条。方向和理由不依赖聊天模型，只有句子需要。

## 最后一步怎么落地

网页里出三张卡片，点一张，按「复制这条」，然后切回微信粘上去。

自动发送（接管微信输入框，点一下就发出去）还没做。它跟客户端版本绑得紧，微信升级一次就得跟着改；更要紧的是它会省掉人过目那一秒。接口留好了，回头接。

## 网页就是全部

左边选数据源，右边看判断和候选。三段都在这一页里：

1. **IN**：左栏「微信库」填解密目录、映射文件、分析对象；或者切「粘贴」直接贴一段记录。
2. **THINK**：点「开始」，服务器跑完整判断，不是逐句发请求。好感度五维、阶段、下一步、逐句情绪和意图一次返回。
3. **OUT**：三张候选卡片，主推排第一，点一张复制。

第一次接一个人用「建立基线」，它读完整历史，游标存进 `.runtime/peers/`。之后用「更新」，只读上次之后的新消息。

两个模型各有自己的设置入口，在右上角。都不写死：判断模型填哪个地址都行，起草模型从预设里选或者自己填，接云端 API 也是同一张表单。

## 开始之前

- **Node 22.12 或更高**。读微信数据库用 Node 自带的 `node:sqlite`，不额外装依赖。
- **判断模型**（必需）。任何说 System One 协议的服务都行，默认按 Laya 配在 `127.0.0.1:8421`。
- **聊天模型**（可选）。任何 OpenAI 兼容接口，默认按本机 Ollama 的 `qwen3:8b` 配在 `127.0.0.1:11434`。

两个模型都能换成别家，改环境变量即可，代码不用动。

## 跑起来

```bash
npm install
npm run build      # 第一次，或改了前端之后
npm run up
```

`npm run up` 做三件事：探一下 8421 和 11434 通不通；缺哪个起哪个，已经开着的直接复用；起网页并打开 `http://127.0.0.1:3178`。Ctrl+C 一起收，只关这次自己起的进程。

只想起网页（模型已经在别处跑着）：

```bash
npm start
```

改前端时用 `npm run dev`，5178 带热更新。

## 配置

默认值都在代码里，一项不配也能跑。想改有三个地方，后面的覆盖前面的：

1. 代码里的默认值
2. `.env`（照 `.env.example` 抄一份）
3. 命令行环境变量

### IN：聊天记录从哪来

网页里左栏填的那三个字段就是全部输入，下面这些是给 `scripts/run.ts`（无界面那条路）用的。

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
| `LOCAL_DIALECT` | `systemone` | 协议方言：`systemone` / `anyjev` |
| `LOCAL_API_KEY` | `local` | 本机服务通常不看，但有些客户端要求非空 |
| `LINE_WINDOW` | `12` | 逐句判断看最近多少条消息。设 `0` 只出整体判断，速度最快 |

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
| `DRAFT_CANDIDATES` | `3` | 出几个方向的候选。每多一个方向就多一次聊天模型调用 |

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
| `npm run up` | 起模型 + 起网页，Ctrl+C 全收 |
| `npm start` | 只起网页（3178），假定模型已在跑 |
| `npm run dev` | 开发网页，5178 热更新 |
| `npm run build` | 类型检查 + 打包前端 |
| `npm run inspect -- --dir=…` | 探测微信库结构 |
| `npm test` | 跑测试 |
| `npm run typecheck` | 类型检查 |

`scripts/run.ts` 和 `server/report.ts` 还在，是不带界面的批处理与终端渲染，`npx tsx scripts/run.ts` 直接用。它们和网页读同一个 `SessionReport`，不是另一条产品线。

## 目录

```
server/
  pipeline.ts        IN → THINK → OUT 的编排，唯一知道三段都存在的地方
  pipeline-api.ts    /api/pipeline：网页那一次调用，含基线游标
  candidates.ts      从判断结果分出三个方向，各写一句
  report.ts          把完整判断排成终端报告（可选，给批处理用）
  local-decision.ts  判断服务的几种协议方言
  chat-client.ts     聊天补全，两种 HTTP 形状
  chat-config.ts     聊天模型配置的解析与校验
  chat-settings-api.ts  /api/chat-settings：起草模型的网页配置
  deliver.ts         剪贴板和打印（命令行用）
  index.ts           网页的 /api 路由
  settings-api.ts    判断模型设置的保存与连接检测
  analysis.ts        拆题、评分维度、关系规则（上游原版）
  provider.ts llm.ts model-config.ts liquid.ts openai-decisions.ts  云端协议栈（上游原版）
shared/
  sources.ts         IN 的接口与两个实现
  wechat-db.ts       读解密后的 SQLite
  chat-presets.ts    聊天模型预设
  rules.ts affinity.ts incremental.ts intents.ts labels.ts memory.ts ratings.ts types.ts  判断结构（上游原版）
  parser.ts fixtures.ts model-presets.ts model-selection.ts  网页粘贴那条线用的（上游原版）
src/
  Workspace.tsx      唯一页面：数据源、判断、候选
  App.tsx            上游原版界面，保留可回退，入口已切走
scripts/
  up.ts              一键启动
  run.ts             无界面跑一次（可选）
  start.ts           起网页
  inspect-wechat-db.ts  探测库结构
tests/
```

上面标了「上游原版」的，是从上游继承来的代码，逻辑没改过：六维好感度怎么加权、十选一动作怎么定、对方划定边界时 respect 怎么压住其他动作、好感度不够时 wait 怎么拦住推进行、逐句题目怎么出，全在这些文件里。改过的只有三个：`provider.ts` 加了一个 `engine === "local"` 的分支，`model-config.ts` 加了本地方言的类型和空 Key 处理，`model-presets.ts` 加了三个本地预设。

## 已知限制

- 只处理文本消息。图片、语音、表情包在数据库里有记录但没有可读内容，会被跳过。
- 两个模型都得自己准备好。仓库不带权重，也不下载权重，启动器只去本地缓存里找。
- 网页只做到「复制」，直接发送还没接。
- 逐句判断的质量取决于判断模型本身。Laya 是个三亿参数的小模型，情绪和意图的分布经常很平，一个十二选一的问题最高项只有二成五，这种时候别把百分比当真。
- 关系判断是概率输出，不是事实。它读不出你们现实里发生的事。

## 出处

`server/analysis.ts` 里的题目设计、评分维度和关系规则来自 [FerryCorleone/crush-monitor](https://github.com/FerryCorleone/crush-monitor)（MIT）。本仓库在它之上把判断模型换成本地服务，加了 IN 和 OUT 两段。

MIT License。
