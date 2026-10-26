// 4.1 的库结构：会话在 SessionTable，消息按会话分表（Msg_<md5>），发送者是编号。
// 这里造一套最小可用的库，锁住四件容易搞错的事：表名怎么算、自己那条怎么认、
// 非文本怎么处理、空白名单必须拒绝。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { listWeChatPeers, msgTable, readWeChatSessions } from "../shared/wechat-db";

const SELF = "wxid_self";
const OTHER = "wxid_other";

function build(): string {
  const root = mkdtempSync(join(tmpdir(), "replysmith-wechat-"));
  // 目录名带设备后缀，自己的 wxid 靠它推出来。
  const dir = join(root, `${SELF}_abcd`, "db_storage");
  mkdirSync(join(dir, "message"), { recursive: true });
  mkdirSync(join(dir, "session"), { recursive: true });
  mkdirSync(join(dir, "contact"), { recursive: true });

  const session = new DatabaseSync(join(dir, "session/session.db"));
  session.exec(
    "CREATE TABLE SessionTable (username TEXT, sort_timestamp INTEGER, last_timestamp INTEGER)",
  );
  session
    .prepare("INSERT INTO SessionTable VALUES (?, ?, ?)")
    .run(OTHER, 1793000000, 1793000000);
  session.close();

  const contact = new DatabaseSync(join(dir, "contact/contact.db"));
  contact.exec(
    "CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, alias TEXT)",
  );
  contact
    .prepare("INSERT INTO contact VALUES (?, ?, ?, ?)")
    .run(OTHER, "小满", "满满", null);
  contact.close();

  const msg = new DatabaseSync(join(dir, "message/message_0.db"));
  msg.exec("CREATE TABLE Name2Id (user_name TEXT)");
  msg.prepare("INSERT INTO Name2Id (user_name) VALUES (?)").run(OTHER); // rowid 1
  msg.prepare("INSERT INTO Name2Id (user_name) VALUES (?)").run(SELF); // rowid 2
  msg.exec(
    `CREATE TABLE "${msgTable(OTHER)}" (local_id INTEGER, server_id INTEGER, local_type INTEGER, ` +
      `real_sender_id INTEGER, create_time INTEGER, message_content TEXT)`,
  );
  const insert = msg.prepare(`INSERT INTO "${msgTable(OTHER)}" VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run(1, 1, 1, 1, 1793000000, "今天加班到十点");
  insert.run(2, 2, 1, 2, 1793000060, "辛苦了"); // 自己发的
  insert.run(3, 3, 3, 1, 1793000120, "<msg>图片</msg>"); // 非文本
  msg.close();

  return dir;
}

test("会话列表读昵称，key 用 wxid", () => {
  const peers = listWeChatPeers({ dbDir: build() });
  assert.equal(peers.length, 1);
  assert.equal(peers[0].peer, OTHER);
  assert.equal(peers[0].name, "小满");
  assert.equal(peers[0].lastMs, 1793000000000);
});

test("表名是 md5，自己那条认得出，非文本不算文字", () => {
  const [s] = readWeChatSessions({ dbDir: build(), allowedPeers: [OTHER] });
  assert.equal(s.peer, "小满");
  assert.equal(s.peerId, OTHER);
  assert.equal(s.messages.length, 3);
  assert.equal(s.messages[0].sender, "other");
  assert.equal(s.messages[1].sender, "self");
  assert.equal(s.messages[2].kind, "unreadable");
  assert.equal(s.messages[2].text, "");
});

test("sinceMs 只取之后的", () => {
  const [s] = readWeChatSessions({
    dbDir: build(),
    allowedPeers: [OTHER],
    sinceMs: 1793000060 * 1000,
  });
  assert.equal(s.messages.length, 2);
});

test("空白名单拒绝启动", () => {
  assert.throws(
    () => readWeChatSessions({ dbDir: build(), allowedPeers: [] }),
    /必须指定/,
  );
});
