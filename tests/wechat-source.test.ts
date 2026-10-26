// 用合成的库验证读库适配器的逻辑（不碰任何真实微信数据）。
// 表名/列名故意取一套"像 4.0 但不是官方文档确认"的写法，正好证明适配器认的是映射，
// 而不是代码里写死的列名。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readWeChatSessions, type WeChatMapping } from "../shared/wechat-db";

const T0 = 1_760_000_000; // 2025-10-09 附近，秒
const MIN = 60;

function makeDb(): { dir: string; cleanup: () => void; mapping: WeChatMapping } {
  const dir = mkdtempSync(join(tmpdir(), "replysmith-wx-"));
  mkdirSync(join(dir, "message"), { recursive: true });
  mkdirSync(join(dir, "contact"), { recursive: true });

  const msg = new DatabaseSync(join(dir, "message", "message_0.db"));
  msg.exec(`CREATE TABLE Msg (
    localId INTEGER PRIMARY KEY,
    createTime INTEGER,
    isSend INTEGER,
    talker TEXT,
    displayContent TEXT
  )`);
  const insert = msg.prepare(
    "INSERT INTO Msg (localId, createTime, isSend, talker, displayContent) VALUES (?,?,?,?,?)",
  );
  // 小满：对方两条、我一条
  insert.run(1, T0, 0, "wxid_xiaoman", "在干嘛");
  insert.run(2, T0 + MIN, 1, "wxid_xiaoman", "刚下班");
  insert.run(3, T0 + 2 * MIN, 0, "wxid_xiaoman", "今天加班好累");
  // 阿哲：一条纯文本 + 一条 XML（图片），XML 应被判成 unreadable
  insert.run(4, T0 + 3 * MIN, 0, "wxid_azhe", "周末有空吗");
  insert.run(5, T0 + 4 * MIN, 0, "wxid_azhe", "<msg><img aeskey=\"abc\"/></msg>");
  // 未登记的第三方，allowlist 必须挡掉
  insert.run(6, T0 + 5 * MIN, 0, "wxid_stranger", "在吗");
  msg.close();

  const contact = new DatabaseSync(join(dir, "contact", "contact.db"));
  contact.exec("CREATE TABLE contact (userName TEXT PRIMARY KEY, nickName TEXT)");
  const ins = contact.prepare("INSERT INTO contact (userName, nickName) VALUES (?,?)");
  ins.run("wxid_xiaoman", "小满");
  ins.run("wxid_azhe", "阿哲");
  ins.run("wxid_stranger", "陌生人");
  contact.close();

  const mapping: WeChatMapping = {
    messages: {
      db: "message",
      table: "Msg",
      columns: {
        id: "localId",
        time: "createTime",
        isSelf: "isSend",
        peer: "talker",
        text: "displayContent",
      },
    },
    peerNames: {
      db: "contact/contact.db",
      table: "contact",
      columns: { id: "userName", name: "nickName" },
    },
    timeUnit: "s",
  };

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }), mapping };
}

test("只返回 allowlist 里的会话，昵称和原始 id 都能登记", () => {
  const { dir, cleanup, mapping } = makeDb();
  try {
    const byNick = readWeChatSessions({
      dbDir: dir,
      mapping,
      allowedPeers: ["小满"],
      sinceMs: 0,
      maxMessagesPerPeer: 80,
    });
    assert.deepEqual(byNick.map((s) => s.peer), ["小满"]);

    const byId = readWeChatSessions({
      dbDir: dir,
      mapping,
      allowedPeers: ["wxid_azhe"],
      sinceMs: 0,
      maxMessagesPerPeer: 80,
    });
    assert.deepEqual(byId.map((s) => s.peer), ["阿哲"]);

    const both = readWeChatSessions({
      dbDir: dir,
      mapping,
      allowedPeers: ["小满", "阿哲"],
      sinceMs: 0,
      maxMessagesPerPeer: 80,
    });
    assert.deepEqual(both.map((s) => s.peer).sort(), ["小满", "阿哲"].sort());
  } finally {
    cleanup();
  }
});

test("发送方、时间、非文本消息都归一化正确", () => {
  const { dir, cleanup, mapping } = makeDb();
  try {
    const [x] = readWeChatSessions({
      dbDir: dir,
      mapping,
      allowedPeers: ["小满"],
      sinceMs: 0,
      maxMessagesPerPeer: 80,
    });
    assert.equal(x.messages.length, 3);
    assert.deepEqual(
      x.messages.map((m) => m.sender),
      ["other", "self", "other"],
    );
    assert.deepEqual(
      x.messages.map((m) => m.timestamp),
      [String(T0), String(T0 + MIN), String(T0 + 2 * MIN)],
    );
    assert.ok(x.messages.every((m) => m.kind === "text"));

    const [a] = readWeChatSessions({
      dbDir: dir,
      mapping,
      allowedPeers: ["阿哲"],
      sinceMs: 0,
      maxMessagesPerPeer: 80,
    });
    const pic = a.messages[1];
    assert.equal(pic.kind, "unreadable");
    assert.equal(pic.text, "");
  } finally {
    cleanup();
  }
});

test("sinceMs 之后的才进来，且只留最近 maxMessagesPerPeer 条", () => {
  const { dir, cleanup, mapping } = makeDb();
  try {
    const recent = readWeChatSessions({
      dbDir: dir,
      mapping,
      allowedPeers: ["小满"],
      sinceMs: (T0 + 2 * MIN) * 1000,
      maxMessagesPerPeer: 80,
    });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].messages.length, 1);
    assert.equal(recent[0].messages[0].text, "今天加班好累");

    const capped = readWeChatSessions({
      dbDir: dir,
      mapping,
      allowedPeers: ["小满"],
      sinceMs: 0,
      maxMessagesPerPeer: 2,
    });
    assert.deepEqual(
      capped[0].messages.map((m) => m.text),
      ["刚下班", "今天加班好累"],
    );
  } finally {
    cleanup();
  }
});

test("映射里的标识符不合法时直接报错，不拼进 SQL", () => {
  const { dir, cleanup, mapping } = makeDb();
  try {
    const bad: WeChatMapping = {
      ...mapping,
      messages: { ...mapping.messages, table: 'Msg"; DROP TABLE Msg; --' },
    };
    assert.throws(
      () =>
        readWeChatSessions({
          dbDir: dir,
          mapping: bad,
          allowedPeers: ["小满"],
          sinceMs: 0,
          maxMessagesPerPeer: 80,
        }),
      /标识符不合法/,
    );
  } finally {
    cleanup();
  }
});
