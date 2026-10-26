// The one page. IN picks a source, THINK runs the whole pipeline server-side,
// OUT shows directions and puts the chosen one on the clipboard.
//
// Everything rendered here comes from a single SessionReport returned by
// POST /api/pipeline. The terminal renderer (server/report.ts) draws the same
// object; neither is the other's upstream.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ModelSettings } from "./ModelSettings";
import { parseChat, toMessages } from "../shared/parser";
import {
  ACTIONS,
  RELATIONS,
  STAGES,
  affinityLabel,
  grade,
  statusLabel,
  type Relation,
} from "../shared/types";
import { topEmotions } from "../shared/labels";
import { topIntents } from "../shared/intents";
import { replyRating } from "../shared/ratings";
import type { Candidate, SessionReport } from "../shared/pipeline-types";
import type { PublicSettings } from "../shared/model-presets";
import { CHAT_PRESETS, findChatPreset } from "../shared/chat-presets";
import "./workspace.css";

type Source =
  | { kind: "wechat" }
  | { kind: "paste" }
  | { kind: "inline" };

type DraftView = {
  configured: boolean;
  presets: typeof CHAT_PRESETS;
  current: {
    preset: string;
    baseUrl: string;
    model: string;
    wire: "openai" | "ollama";
    temperature?: number;
    maxTokens?: number;
    hasKey: boolean;
  } | null;
  token: string;
};

type PeerRow = {
  peer: string;
  name: string;
  count: number;
  lastMs: number;
  profile?: { age?: string; role?: string; note?: string };
};

const LS = "replysmith.workspace";

function loadSaved(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LS) || "{}");
  } catch {
    return {};
  }
}

/** 会话列表里的时间：今天给时分，更早给日期。 */
function when(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `请求失败（${res.status}）`);
  return data as T;
}

/** 逐句一条。概率只在有判断时渲染，缺的就留空，不编。 */
function LineRow({ report, index }: { report: SessionReport; index: number }) {
  const m = report.messages[index];
  const line = report.lines.find((l) => l.id === m.id);
  const emotions = line ? topEmotions(line.emotions) : [];
  const intents = line ? topIntents(line.intents) : [];
  const rating = line ? replyRating(line.score?.value) : null;
  const time = m.timestamp
    ? new Date(
        Number.isFinite(Number(m.timestamp)) && Number(m.timestamp) < 1e11
          ? Number(m.timestamp) * 1000
          : Number(m.timestamp) || m.timestamp,
      )
    : null;
  const hhmm =
    time && !Number.isNaN(time.getTime())
      ? `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`
      : "--:--";
  return (
    <li className={`ws-line ${m.sender === "self" ? "self" : ""}`}>
      <div className="ws-line-head">
        <span className="ws-time">{hhmm}</span>
        <span className="ws-who">{m.sender === "self" ? "我" : "对方"}</span>
        <span className="ws-text">
          {m.kind === "unreadable" ? "［图片 / 语音 / 表情］" : m.text}
        </span>
      </div>
      {(emotions.length > 0 || intents.length > 0 || rating) && (
        <div className="ws-tags">
          {emotions.length > 0 && (
            <span className="ws-tag">
              情绪 {emotions.map((e) => `${e.label} ${e.percent}`).join(" · ")}
            </span>
          )}
          {intents.length > 0 && (
            <span className="ws-tag">
              意图 {intents.map((i) => `${i.label} ${i.percent}`).join(" · ")}
            </span>
          )}
          {rating && (
            <span className={`ws-tag ws-grade g-${rating.label}`}>
              表达 {rating.label} · {rating.description}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function ReportView({ report }: { report: SessionReport }) {
  const [expanded, setExpanded] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const o = report.overview;
  const shown = expanded ? report.messages : report.messages.slice(-12);

  useEffect(() => {
    setPicked(null);
    setCopied(false);
    setExpanded(false);
  }, [report]);

  const copy = useCallback(async (c: Candidate) => {
    if (!c.text) return;
    try {
      await navigator.clipboard.writeText(c.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, []);

  if (!o) {
    return (
      <div className="ws-empty">
        <p>{report.note ?? "分析没有返回结果。"}</p>
      </div>
    );
  }

  const affinity = o.affinity.value;
  const action = ACTIONS[o.action] ?? ACTIONS.insufficient;

  return (
    <div className="ws-report">
      <div className="ws-head">
        <h2>{report.peer}</h2>
        <span className="ws-rel">{RELATIONS[report.relation]}</span>
      </div>

      <div className="ws-score">
        <span className="ws-big">{affinity ?? "—"}</span>
        <div>
          <div className="ws-score-label">{affinityLabel(affinity)}</div>
          <div className="ws-muted">
            {o.stage === "unknown" ? "阶段不明" : (STAGES[o.stage] ?? "阶段不明")} · 把握
            {statusLabel(o.affinity)}
            {o.boundaryApplied ? " · 对方已划边界" : ""}
          </div>
        </div>
      </div>

      {o.affinityDimensions && o.affinityDimensions.length > 0 && (
        <div className="ws-dims">
          {o.affinityDimensions.map((d) => (
            <div className="ws-dim" key={d.label}>
              <span className="ws-dim-label">{d.label}</span>
              <div className="ws-bar">
                <div style={{ width: `${Math.max(0, Math.min(100, d.judgment.value ?? 0))}%` }} />
              </div>
              <span className="ws-dim-value">
                {d.judgment.value === null ? "缺证据" : d.judgment.value}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="ws-action">
        <span className="ws-kicker">下一步</span>
        <strong>{action.label}</strong>
        <span className="ws-muted">{action.detail}</span>
        {o.alternative && ACTIONS[o.alternative] && (
          <span className="ws-muted">另一条路：{ACTIONS[o.alternative].label}</span>
        )}
        {report.candidates[0] && report.candidates[0].action !== o.action && (
          <span className="ws-muted">
            它真正想做的更保守，但证据不够，下面三条是能试着接的方向。
          </span>
        )}
      </div>

      <section className="ws-candidates">
        <h3>可发的方向</h3>
        <div className="ws-cards">
          {report.candidates.map((c, i) => (
            <button
              key={`${c.action}-${i}`}
              className={`ws-card ${picked === i ? "picked" : ""} ${c.text ? "" : "silent"}`}
              onClick={() => setPicked(i)}
            >
              <span className="ws-card-top">
                <span className="ws-card-label">
                  {i + 1}. {c.label}
                </span>
                <span className={`ws-badge ${c.source}`}>
                  {c.source === "primary" ? "主推" : c.source === "alternative" ? "备选" : "收一档"}
                </span>
              </span>
              <span className="ws-card-detail">{c.detail}</span>
              <span className="ws-card-text">
                {c.text ?? (c.action === "wait" || c.action === "respect" ? "这个方向先不发" : "—")}
              </span>
            </button>
          ))}
        </div>
        {picked !== null && (
          <div className="ws-send">
            <button
              className="primary"
              disabled={!report.candidates[picked]?.text}
              onClick={() => void copy(report.candidates[picked])}
            >
              {copied ? "已复制，去粘到微信" : "复制这条"}
            </button>
            <button className="ghost" disabled title="下一步接：架空微信输入框直接发">
              直接发送（待接入）
            </button>
          </div>
        )}
      </section>

      <section className="ws-lines">
        <h3>
          逐句
          {report.messages.length > 12 && (
            <button className="link" onClick={() => setExpanded(!expanded)}>
              {expanded ? "只看最近" : `展开全部 ${report.messages.length} 条`}
            </button>
          )}
        </h3>
        <ul>
          {shown.map((m) => (
            <LineRow key={m.id} report={report} index={report.messages.indexOf(m)} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function DraftSettings({
  view,
  onSaved,
  onClose,
}: {
  view: DraftView;
  onSaved: (v: DraftView) => void;
  onClose: () => void;
}) {
  const [preset, setPreset] = useState(view.current?.preset ?? "ollama");
  const [baseUrl, setBaseUrl] = useState(view.current?.baseUrl ?? "");
  const [model, setModel] = useState(view.current?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function pickPreset(id: string) {
    setPreset(id);
    const p = findChatPreset(id);
    if (p) {
      setBaseUrl(p.baseUrl);
      setModel(p.model);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const p = findChatPreset(preset);
      const next = await fetch("/api/chat-settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-config-token": view.token,
        },
        body: JSON.stringify({
          preset,
          baseUrl,
          model,
          ...(apiKey ? { apiKey } : {}),
          ...(p?.wire ? { wire: p.wire } : {}),
        }),
      });
      const data = await next.json();
      if (!next.ok) throw new Error(data.error || "保存失败");
      onSaved(data as DraftView);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-form">
      <label>
        <span>服务</span>
        <select value={preset} onChange={(e) => pickPreset(e.target.value)}>
          {view.presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>地址</span>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11434" />
      </label>
      <label>
        <span>模型</span>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="qwen3:8b" />
      </label>
      <label>
        <span>Key</span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={view.current?.hasKey ? "已保存，留空不改" : "本机服务不用填"}
        />
      </label>
      {error && <p className="ws-error">{error}</p>}
      <div className="ws-form-actions">
        <button className="primary" disabled={busy || !model || !baseUrl} onClick={() => void save()}>
          {busy ? "保存中…" : "保存"}
        </button>
        <span className="ws-muted">
          {view.current?.wire === "ollama" ? "走原生路由（关思考）" : ""}
        </span>
      </div>
    </div>
  );
}

export default function Workspace() {
  const saved = useMemo(loadSaved, []);
  const [tab, setTab] = useState<Source["kind"]>("wechat");
  const [dbDir, setDbDir] = useState(saved.dbDir ?? "");
  const [mappingFile, setMappingFile] = useState(saved.mappingFile ?? "");
  const [peer, setPeer] = useState(saved.peer ?? "");
  const [peers, setPeers] = useState<PeerRow[]>([]);
  const [peersBusy, setPeersBusy] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [selfName, setSelfName] = useState(saved.selfName ?? "我");
  const [age, setAge] = useState(saved.age ?? "");
  const [role, setRole] = useState(saved.role ?? "");
  const [note, setNote] = useState(saved.note ?? "");
  const [relation, setRelation] = useState<Relation>("crush");
  const [mode, setMode] = useState<"baseline" | "update">("baseline");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reports, setReports] = useState<SessionReport[]>([]);
  const [active, setActive] = useState(0);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelConfig, setModelConfig] = useState<PublicSettings | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState<DraftView | null>(null);

  useEffect(() => {
    localStorage.setItem(
      LS,
      JSON.stringify({ dbDir, mappingFile, peer, selfName, age, role, note }),
    );
  }, [dbDir, mappingFile, peer, selfName, age, role, note]);

  const loadPeers = useCallback(async () => {
    if (!dbDir || !mappingFile) {
      setError("先填解密目录和映射文件。");
      return;
    }
    setPeersBusy(true);
    setError("");
    try {
      const q = new URLSearchParams({ dbDir, mappingFile });
      const res = await fetch(`/api/peers?${q}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "读不出会话列表");
      setPeers(data.peers ?? []);
      if (!data.peers?.length) setNotice("这个库里没读到会话。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPeersBusy(false);
    }
  }, [dbDir, mappingFile]);

  function pickPeer(p: PeerRow) {
    setPeer(p.peer);
    setAge(p.profile?.age ?? "");
    setRole(p.profile?.role ?? "");
    setNote(p.profile?.note ?? "");
    // 第一次点这个人就问一句「对方是谁」——这些聊天记录里读不出来。
    if (!p.profile) setProfileOpen(true);
  }

  async function saveProfile() {
    try {
      await fetch("/api/peers/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peer, age, role, note }),
      });
      setPeers((old) =>
        old.map((p) =>
          p.peer === peer ? { ...p, profile: { age, role, note } } : p,
        ),
      );
    } catch {
      /* 设定存不上不影响判断，下次再问一遍 */
    } finally {
      setProfileOpen(false);
    }
  }

  const openJudge = useCallback(async () => {
    setModelOpen(true);
    if (modelConfig) return;
    try {
      const res = await fetch("/api/settings");
      if (res.ok) setModelConfig(await res.json());
    } catch {
      /* 面板自己会提示 */
    }
  }, [modelConfig]);

  const openDraft = useCallback(async () => {
    setDraftOpen(true);
    try {
      const res = await fetch("/api/chat-settings");
      if (res.ok) setDraft(await res.json());
    } catch {
      /* 下面提示读取失败 */
    }
  }, []);

  async function run() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let source: unknown;
      if (tab === "wechat") {
        if (!dbDir || !mappingFile || !peer)
          throw new Error("微信库需要填目录、映射文件和分析对象。");
        source = { kind: "wechat", dbDir, mappingFile, peer };
      } else {
        const parsed = parseChat(raw);
        const names = [...new Set(parsed.messages.map((m) => m.speaker))];
        const self = names.includes(selfName) ? selfName : names[0];
        const messages = toMessages(parsed.messages, self);
        if (!messages.length) throw new Error("没解析出消息，检查一下格式。");
        source = { kind: "inline", messages };
      }
      const data = await post<{ reports: SessionReport[] }>("/api/pipeline", {
        source,
        relation,
        mode,
        profile: { age, role, note },
        lineWindow: 12,
        messageWindow: 0,
      });
      setReports(data.reports);
      setActive(0);
      if (!data.reports.length) setNotice("这段对话里没有可分析的文字。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const report = reports[active];

  return (
    <div className="ws">
      <header className="ws-top">
        <strong>replysmith</strong>
        <span className="ws-muted">读你的聊天，判断关系，给几个方向</span>
        <div className="ws-top-actions">
          <button className="ghost" onClick={() => void openDraft()}>
            起草模型{draft?.current ? ` · ${draft.current.model}` : ""}
          </button>
          <button className="ghost" onClick={() => void openJudge()}>
            判断模型{modelConfig?.configured ? ` · ${modelConfig.model}` : ""}
          </button>
        </div>
      </header>

      <div className="ws-body">
        <aside className="ws-side">
          <div className="ws-tabs">
            <button className={tab === "wechat" ? "on" : ""} onClick={() => setTab("wechat")}>
              微信库
            </button>
            <button className={tab === "paste" ? "on" : ""} onClick={() => setTab("paste")}>
              粘贴
            </button>
          </div>

          {tab === "wechat" ? (
            <div className="ws-form">
              <label>
                <span>解密目录</span>
                <input
                  value={dbDir}
                  onChange={(e) => setDbDir(e.target.value)}
                  placeholder="…\wechat-decrypt\decrypted"
                />
              </label>
              <label>
                <span>映射文件</span>
                <input
                  value={mappingFile}
                  onChange={(e) => setMappingFile(e.target.value)}
                  placeholder="…\decrypted\wechat-mapping.json"
                />
              </label>
              <button
                className="ghost"
                disabled={peersBusy || !dbDir || !mappingFile}
                onClick={() => void loadPeers()}
              >
                {peersBusy ? "读取中…" : peers.length ? "刷新会话" : "读取会话"}
              </button>
              {peers.length > 0 && (
                <ul className="ws-peerlist">
                  {peers.map((p) => (
                    <li key={p.peer}>
                      <button
                        className={peer === p.peer ? "on" : ""}
                        onClick={() => pickPeer(p)}
                      >
                        <span className="ws-peer-name">{p.name}</span>
                        <span className="ws-peer-meta">
                          {p.count} 条 · {when(p.lastMs)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="ws-hint">
                只读 wechat-decrypt 解出来的库，不碰解密本身。选一个人，再点开始。
              </p>
            </div>
          ) : (
            <div className="ws-form">
              <label>
                <span>聊天记录</span>
                <textarea
                  rows={12}
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  placeholder={"我：在忙吗\n对方：刚开完会"}
                />
              </label>
              <label>
                <span>我是</span>
                <input value={selfName} onChange={(e) => setSelfName(e.target.value)} />
              </label>
            </div>
          )}

          <div className="ws-form">
            <label>
              <span>关系</span>
              <select value={relation} onChange={(e) => setRelation(e.target.value as Relation)}>
                {Object.entries(RELATIONS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <div className="ws-profile">
              <span className="ws-kicker">对方是谁</span>
              <button
                className="ghost"
                disabled={!peer}
                onClick={() => setProfileOpen(true)}
              >
                {[age && `${age} 岁`, role, note].filter(Boolean).join("，") ||
                  (peer ? "还没填，点这里补" : "先选一个人")}
              </button>
            </div>
            <div className="ws-modes">
              <button className={mode === "baseline" ? "on" : ""} onClick={() => setMode("baseline")}>
                建立基线
              </button>
              <button className={mode === "update" ? "on" : ""} onClick={() => setMode("update")}>
                更新
              </button>
            </div>
            <p className="ws-hint">
              {mode === "baseline"
                ? "读完整历史，第一次接一个人用这个。"
                : "只读上次之后的新消息，接着之前的判断往下走。"}
            </p>
            <button className="primary" disabled={busy} onClick={() => void run()}>
              {busy ? "判断中…" : "开始"}
            </button>
          </div>

          {reports.length > 1 && (
            <div className="ws-peers">
              {reports.map((r, i) => (
                <button key={r.peer} className={i === active ? "on" : ""} onClick={() => setActive(i)}>
                  {r.peer}
                </button>
              ))}
            </div>
          )}
        </aside>

        <main className="ws-main">
          {error && <p className="ws-error">{error}</p>}
          {notice && <p className="ws-muted">{notice}</p>}
          {!report && !error && !notice && (
            <div className="ws-empty">
              <p>左边选个数据源，点开始。</p>
              <p className="ws-muted">
                第一次读某个人会用完整历史做基线，之后只补新消息。
              </p>
            </div>
          )}
          {report && <ReportView report={report} />}
        </main>
      </div>

      {profileOpen && (
        <div className="ws-overlay" onClick={() => setProfileOpen(false)}>
          <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
            <h3>对方是谁</h3>
            <p className="ws-hint" style={{ marginBottom: 14 }}>
              聊天记录里读不出来的，只能你补。填了写出来的句子才像在跟这个人说话。
            </p>
            <div className="ws-form">
              <div className="ws-row">
                <input
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="年龄"
                />
                <input
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="身份 / 职业"
                />
              </div>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="脾气、习惯、说话方式"
              />
              <div className="ws-form-actions">
                <button className="primary" onClick={() => void saveProfile()}>
                  保存
                </button>
                <button className="ghost" onClick={() => setProfileOpen(false)}>
                  先跳过
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {modelOpen && (
        <div className="ws-overlay" onClick={() => setModelOpen(false)}>
          <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
            <h3>判断模型（THINK）</h3>
            {modelConfig ? (
              <ModelSettings
                initial={modelConfig}
                saved={(s) => {
                  setModelConfig(s);
                  setModelOpen(false);
                }}
              />
            ) : (
              <p className="ws-muted">读取中…</p>
            )}
          </div>
        </div>
      )}

      {draftOpen && (
        <div className="ws-overlay" onClick={() => setDraftOpen(false)}>
          <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
            <h3>起草模型（OUT）</h3>
            {draft ? (
              <DraftSettings view={draft} onSaved={setDraft} onClose={() => setDraftOpen(false)} />
            ) : (
              <p className="ws-muted">读取中…</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
