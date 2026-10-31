// The one page. IN picks a source, THINK runs the whole pipeline server-side,
// OUT shows directions and puts the chosen one on the clipboard.
//
// Everything rendered here comes from a single SessionReport returned by
// POST /api/pipeline. The terminal renderer (server/report.ts) draws the same
// object; neither is the other's upstream.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  profile?: { age?: string; role?: string; note?: string; relationNote?: string };
};

const LS = "crush-reply-kit.workspace";

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

/**
 * 自定义关系写完之后，判断那边仍要落回三个枚举之一。按关键词挑一个最接近的，
 * 免得"认识一段时间的朋友"被当成 crush 去算好感度。
 */
function guessRelation(text: string): Relation {
  // 否定说法要先剥掉再匹配。「不暧昧」里含「暧昧」，直接匹配会把
  // 「认识一段时间的朋友，不暧昧」读成暧昧，基准就整条歪掉。
  const t = text
    .trim()
    .replace(/(不|没|没有|不是|谈不上|并非|从不|未)\s*(暧昧|喜欢|心动|暗恋|追)/g, "")
    .replace(/(没|没有|不是|不|未)\s*(在一起|处对象|对象|情侣|恋人)/g, "");
  if (/在一起|对象|男友|女友|男朋友|女朋友|恋爱|老公|老婆|处着/.test(t)) return "couple";
  if (/喜欢|暗恋|暧昧|追|心动|crush/i.test(t)) return "crush";
  return "new";
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
  // 一次分析跨好几天，只给时分看不出哪句是哪天。
  const clock = (d: Date) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const hhmm =
    time && !Number.isNaN(time.getTime())
      ? time.toDateString() === new Date().toDateString()
        ? clock(time)
        : `${time.getMonth() + 1}/${time.getDate()} ${clock(time)}`
      : "";
  return (
    <li className={`ws-line ${m.sender === "self" ? "self" : ""}`}>
      <div className="ws-line-head">
        <span className="ws-time">{hhmm}</span>
        <span className="ws-who">
          {m.senderName || (m.sender === "self" ? "我" : "对方")}
        </span>
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

/** 还没有报告时的空壳：中间和右侧保持原来的两列，只是没有内容。 */
function EmptyReport({ name }: { name: string }) {
  return (
    <div className="ws-report ws-report-empty">
      <section className="ws-chat">
        <header className="ws-chat-bar">
          <span>{name || "还没有选人"}</span>
          <span className="ws-muted">这里会显示这个人的聊天记录</span>
        </header>
        <div className="ws-chat-scroll">
          <div className="ws-empty">
            {name ? (
              <>
                <p>这个人还没有分析过。</p>
                <p className="ws-muted">
                  点左下角「开始」做一次基线，之后点他就能直接看到这份判断。
                </p>
              </>
            ) : (
              <>
                <p>左边选个人。</p>
                <p className="ws-muted">第一次读某个人会用完整历史做基线。</p>
              </>
            )}
          </div>
        </div>
      </section>
      <aside className="ws-meta">
        <div className="ws-head">
          <h2>{name || "—"}</h2>
        </div>
        <div className="ws-score">
          <span className="ws-big">—</span>
          <div>
            <div className="ws-score-label">还没有判断</div>
            <div className="ws-muted">
              分析过之后，这里会出好感度、阶段和可发的方向。
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function ReportView({
  report,
  relationNote,
}: {
  report: SessionReport;
  relationNote: string;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const o = report.overview;

  // 对话默认停在最新那句。往上滑才看更早的，这跟微信本身一样。
  // 首帧之后图片/字体可能还会把高度撑开一截，所以钉完再补一拍，确保真到底。
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const toBottom = () => {
      el.scrollTop = el.scrollHeight;
    };
    toBottom();
    const raf = requestAnimationFrame(toBottom);
    const t = setTimeout(toBottom, 120);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [report]);

  useEffect(() => {
    setPicked(null);
    setCopied(false);
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
      <section className="ws-chat">
        <header className="ws-chat-bar">
          <span>{report.peer}</span>
          <span className="ws-muted">
            电脑端导出，中间可能有没同步或已删除的消息，不是连续对话
          </span>
        </header>
        <div className="ws-chat-scroll" ref={scroll}>
          {report.messages.map((m, i) => (
            <LineRow key={m.id} report={report} index={i} />
          ))}
          <p className="ws-chat-end">以上是最近 {report.messages.length} 条</p>
        </div>
      </section>

      <aside className="ws-meta">
        <div className="ws-head">
          <h2>{report.peer}</h2>
          <span className="ws-rel">
            {relationNote.trim() || RELATIONS[report.relation]}
          </span>
        </div>

        <div className="ws-score">
          <span className="ws-big">{affinity ?? "—"}</span>
          <div>
            <div className="ws-score-label">{affinityLabel(affinity)}</div>
            <div className="ws-muted">
              {o.stage === "unknown" ? "阶段不明" : (STAGES[o.stage] ?? "阶段不明")} ·
              把握{statusLabel(o.affinity)}
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
                  <div
                    style={{
                      width: `${Math.max(0, Math.min(100, d.judgment.value ?? 0))}%`,
                    }}
                  />
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
                    {c.source === "primary"
                      ? "主推"
                      : c.source === "alternative"
                        ? "备选"
                        : "收一档"}
                  </span>
                </span>
                <span className="ws-card-detail">{c.detail}</span>
                <span className="ws-card-text">
                  {c.text ??
                    (c.action === "wait" || c.action === "respect"
                      ? "这个方向先不发"
                      : "—")}
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
            </div>
          )}
        </section>
      </aside>
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
  const [relationNote, setRelationNote] = useState(saved.relationNote ?? "");
  const [customRelation, setCustomRelation] = useState(
    Boolean((saved.relationNote ?? "").trim()),
  );
  const [sourceOpen, setSourceOpen] = useState(false);
  const [relation, setRelation] = useState<Relation>("new");
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

  // 顶上那两个按钮要写清现在用的是哪个模型。以前只有点开面板才去读配置，
  // 刷新之后就成了光秃秃的「判断模型」「起草模型」，看不出在用什么。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [judge, chat] = await Promise.all([
          fetch("/api/settings").then((r) => (r.ok ? r.json() : null)),
          fetch("/api/chat-settings").then((r) => (r.ok ? r.json() : null)),
        ]);
        if (!alive) return;
        if (judge) setModelConfig(judge);
        if (chat) setDraft(chat);
      } catch {
        /* 读不到就只显示按钮名，不影响使用 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(
      LS,
      JSON.stringify({
        dbDir,
        peer,
        selfName,
        age,
        role,
        note,
        relationNote,
      }),
    );
  }, [dbDir, peer, selfName, age, role, note, relationNote]);

  const loadPeers = useCallback(async () => {
    setPeersBusy(true);
    setError("");
    try {
      // 不传路径就让服务端自己找，找到再回填输入框。
      const q = new URLSearchParams();
      if (dbDir) q.set("dbDir", dbDir);
      if (mappingFile) q.set("mappingFile", mappingFile);
      const res = await fetch(`/api/peers?${q}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "读不出会话列表");
      if (data.dbDir && !dbDir) setDbDir(data.dbDir);
      if (data.mappingFile && !mappingFile) setMappingFile(data.mappingFile);
      if (data.needMapping) {
        setNotice("找到了微信库，但还没有表结构映射。跑一次 npm run inspect 生成。");
      }
      setPeers(data.peers ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPeersBusy(false);
    }
  }, [dbDir, mappingFile]);

  // 打开页面先自己找一次，找得到就不用用户填任何路径。
  const probed = useRef(false);
  useEffect(() => {
    if (probed.current) return;
    probed.current = true;
    void loadPeers();
  }, [loadPeers]);

  // 刷新和重开页面不该等于从头来：把上次那份报告读回来。
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/last-report");
        if (!res.ok) return;
        const saved = (await res.json()) as {
          relation?: string;
          reports: SessionReport[];
        };
        if (!saved.reports?.length) return;
        setReports(saved.reports);
        setActive(0);
        setPeer(saved.reports[0].peerId ?? "");
        if (saved.relation) setRelation(saved.relation as Relation);
      } catch {
        /* 没有也正常，页面照旧停在空态 */
      }
    })();
  }, []);

  // 点一个人就看这个人的东西：有存过的报告直接摆出来，没有就清空，
  // 不把上一个人的判断留在中间让人误会。
  async function pickPeer(p: PeerRow) {
    setPeer(p.peer);
    setAge(p.profile?.age ?? "");
    setRole(p.profile?.role ?? "");
    setNote(p.profile?.note ?? "");
    const note = p.profile?.relationNote ?? "";
    setRelationNote(note);
    setCustomRelation(Boolean(note.trim()));
    // 已经填过关系基准的人，点进来就用他写的那句话定判断基准，
    // 而不是停留在默认的"刚认识"。没填过的留给下拉自己选。
    if (note.trim()) setRelation(guessRelation(note));
    setError("");
    setNotice("");
    // 先清掉上一个人的报告，接口回来之前别让人看到错的内容。
    setReports([]);
    setActive(0);
    try {
      const res = await fetch(`/api/peers/report?peer=${encodeURIComponent(p.peer)}`);
      if (res.ok) {
        const saved = (await res.json()) as {
          relation?: string;
          reports: SessionReport[];
        };
        if (saved.reports?.length) {
          setReports(saved.reports);
          setActive(0);
          if (saved.relation) setRelation(saved.relation as Relation);
          // 有过基线，下次「开始」默认接着往前更，而不是从头再来一遍。
          setMode("update");
          return;
        }
      }
    } catch {
      /* 读不到就当没存过 */
    }
    setReports([]);
    setActive(0);
    setMode("baseline");
  }

  async function saveProfile() {
    // 关系基准跟着这句话走：写"认识一段时间的朋友"，判断就不该按暧昧算。
    setRelation(guessRelation(relationNote));
    try {
      await fetch("/api/peers/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peer, age, role, note, relationNote }),
      });
      setPeers((old) =>
        old.map((p) =>
          p.peer === peer
            ? { ...p, profile: { age, role, note, relationNote } }
            : p,
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
        if (!peer) throw new Error("先在左边选一个人。");
        // 年龄、身份、什么关系，聊天记录里读不出来。缺了就是拿半份材料去判断，
        // 出来的人不是这个人。这里必须拦住。
        if (!age.trim() || !role.trim() || !relationNote.trim()) {
          setProfileOpen(true);
          throw new Error(
            "先把「对方是谁」填完：年龄、身份、你们什么关系。这三项决定判断的基准。",
          );
        }
        // 明文快照是死的，不先解一遍，新消息永远进不来。
        setNotice("正在同步微信记录，十几秒…");
        const synced = await fetch("/api/peers/sync", { method: "POST" });
        const syncData = await synced.json();
        if (!synced.ok) throw new Error(syncData.message || "同步微信记录失败。");
        setNotice("");
        source = { kind: "wechat", dbDir, peer };
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
        profile: { age, role, note, relationNote },
        // 不传，让服务端按模型自己定：判多少跟展示多少对齐。
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
  // 空版本要显示谁的名字：列表里有就用昵称，没有就留空，文案走通用那句。
  const currentName = peers.find((p) => p.peer === peer)?.name ?? "";

  return (
    <div className="ws">
      <header className="ws-top">
        <strong>Crush Reply Kit</strong>
        <span className="ws-muted">读你和 crush 的聊天，判断关系，给几个方向</span>
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
              {peers.length > 0 && !sourceOpen ? (
                <>
                  <div className="ws-source">
                    <span>
                      已连上微信数据 · {peers.length} 个会话
                    </span>
                    <button className="link" onClick={() => setSourceOpen(true)}>
                      换一个
                    </button>
                  </div>
                  <ul className="ws-peerlist">
                    {peers.map((p) => (
                      <li key={p.peer}>
                        <button
                          className={peer === p.peer ? "on" : ""}
                          onClick={() => void pickPeer(p)}
                        >
                          <span className="ws-peer-name">{p.name}</span>
                          <span className="ws-peer-meta">{when(p.lastMs)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <label>
                    <span>数据位置</span>
                    <input
                      value={dbDir}
                      onChange={(e) => setDbDir(e.target.value)}
                      placeholder="留空，自己找"
                    />
                  </label>
                  <button
                    className="ghost"
                    disabled={peersBusy}
                    onClick={() => {
                      setSourceOpen(false);
                      void loadPeers();
                    }}
                  >
                    {peersBusy ? "读取中…" : "连接"}
                  </button>
                  <p className="ws-hint">
                    一般不用填。它会去找最近解出来的那份数据。
                  </p>
                </>
              )}
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
              <select
                value={customRelation ? "other" : relation}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "other") {
                    setCustomRelation(true);
                    setRelation(guessRelation(relationNote));
                  } else {
                    setCustomRelation(false);
                    setRelation(v as Relation);
                    setRelationNote("");
                  }
                }}
              >
                {Object.entries(RELATIONS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
                <option value="other">其他（自己写）</option>
              </select>
              {customRelation && (
                <input
                  value={relationNote}
                  onChange={(e) => {
                    setRelationNote(e.target.value);
                    setRelation(guessRelation(e.target.value));
                  }}
                  placeholder="比如：认识一段时间的朋友，不暧昧"
                />
              )}
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
            <p className="ws-hint ws-remind">
              跟对方聊过之后回来点「更新」，分析才会跟上新消息。不点就一直看的是上次那份。
            </p>
            <p className="ws-hint ws-sync">
              电脑端只存这台机器上收发过的记录。先在手机微信里
              「设置 → 聊天 → 聊天记录迁移与备份 → 迁移到电脑」同步一次，
              手机上一直在用，那边的记录才连续。
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
          {report ? (
            <ReportView report={report} relationNote={relationNote} />
          ) : (
            <EmptyReport name={currentName} />
          )}
        </main>
      </div>

      {profileOpen && (
        <div className="ws-overlay" onClick={() => setProfileOpen(false)}>
          <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
            <h3>对方是谁</h3>
            <p className="ws-hint" style={{ marginBottom: 14 }}>
              这三项是判断的前提，聊天记录里读不出来，只能你补。缺一项不让开始。
            </p>
            <div className="ws-form">
              <div className="ws-row">
                <input
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="年龄（必填）"
                />
                <input
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="身份 / 职业（必填）"
                />
              </div>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="脾气、习惯、说话方式"
              />
              <input
                value={relationNote}
                onChange={(e) => setRelationNote(e.target.value)}
                placeholder="你们什么关系（必填）：比如认识一段时间的朋友，不暧昧"
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
            <p className="ws-muted">判定按 JEV 调过，换成别的判断类模型可能不准；输出模型可随意切换。</p>
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
            <p className="ws-muted">输出模型只负责把判读翻成句子，可随意切换（DeepSeek 等）。</p>
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
