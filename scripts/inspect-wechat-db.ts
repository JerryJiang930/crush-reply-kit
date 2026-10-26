// 对着 wechat-decrypt 解出来的库做一次只读探测，把真实表名/列名打出来，并给出一个
// 可以照着改的映射骨架。
//
//   npx tsx scripts/inspect-wechat-db.ts --dir="D:/.../wechat-decrypt/decrypted"
//   npx tsx scripts/inspect-wechat-db.ts --dir=... --write   # 顺便写 .runtime/wechat-mapping.json
//
// 为什么要这步：微信 4.0 的表结构没有稳定文档，不同版本列名会变。先探测再映射，
// 比在代码里猜列名可靠——猜错时读出来的是空数组或错位的字段，不会报错，最坑。
// 本脚本只读，不写库、不解密。
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

type TableInfo = { name: string; columns: Array<{ name: string; type: string }>; rows: number };

const args = process.argv.slice(2);
const flag = (k: string) => args.includes(`--${k}`);
const value = (k: string, fallback = "") => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : fallback;
};

const dirArg = value("dir") || process.env.WECHAT_DB_DIR || "";
if (!dirArg) {
  console.error(
    "用法：npx tsx scripts/inspect-wechat-db.ts --dir=<wechat-decrypt 的 decrypted 目录> [--write]",
  );
  process.exit(2);
}
const root = resolve(dirArg);
if (!existsSync(root)) {
  console.error(`目录不存在：${root}`);
  process.exit(2);
}

/** 递归找 *.db，深度限 3 层，避免在乱七八糟的目录里乱翻。 */
function findDbs(dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...findDbs(full, depth + 1));
    else if (entry.toLowerCase().endsWith(".db")) out.push(full);
  }
  return out;
}

function tablesOf(file: string): TableInfo[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    return names.map(({ name }) => {
      let columns: TableInfo["columns"] = [];
      try {
        const info = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as Array<{
          name: string;
          type: string;
        }>;
        columns = info.map((c) => ({ name: c.name, type: c.type || "" }));
      } catch {
        /* 视图或特殊表可能拿不到列信息 */
      }
      let rows = -1;
      try {
        const c = db.prepare(`SELECT COUNT(*) AS c FROM "${name.replace(/"/g, '""')}"`).get() as
          | { c: number }
          | undefined;
        rows = Number(c?.c ?? -1);
      } catch {
        /* 有的虚拟表不支持 COUNT */
      }
      return { name, columns, rows };
    });
  } finally {
    db.close();
  }
}

function sampleOf(file: string, table: string, limit = 2): Array<Record<string, unknown>> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(`SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT ${limit}`)
      .all() as Array<Record<string, unknown>>;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

const truncate = (v: unknown, n = 70): string => {
  if (v === null || v === undefined) return "null";
  if (v instanceof Uint8Array) return `<blob ${v.length}B>`;
  const s = String(v).replace(/\s+/g, " ");
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

const TIME = /time|date|ts$/i;
const TEXT = /content|text|body|message/i;
const SELF = /send|self|is_me|isme|direction/i;

type Candidate = {
  file: string;
  table: string;
  columns: TableInfo["columns"];
  rows: number;
  score: number;
};

const NAME = /^(nick_?name|remark|display_?name|name|alias)$/i;
const ID = /^(user_?name|wxid|id|username)$/i;

const candidates: Candidate[] = [];
/** 联系人库候选：同时有 id 列和昵称列的表。 */
const nameCandidates: Candidate[] = [];

for (const file of findDbs(root)) {
  const rel = relative(root, file).replace(/\\/g, "/");
  const tables = tablesOf(file);
  console.log(`\n=== ${rel} （${tables.length} 张表）`);
  for (const t of tables) {
    const cols = t.columns.map((c) => `${c.name}:${c.type}`).join(", ");
    console.log(`  - ${t.name}  行数=${t.rows < 0 ? "?" : t.rows}  列: ${cols || "(取不到)"}`);
    const hasTime = t.columns.some((c) => TIME.test(c.name));
    const hasText = t.columns.some((c) => TEXT.test(c.name));
    const hasSelf = t.columns.some((c) => SELF.test(c.name));
    if (hasTime && hasText && t.rows !== 0) {
      candidates.push({
        file: rel,
        table: t.name,
        columns: t.columns,
        rows: t.rows,
        score: (hasSelf ? 2 : 0) + (t.rows > 0 ? 1 : 0) + (/msg|message/i.test(t.name) ? 2 : 0),
      });
    }
    const hasId = t.columns.some((c) => ID.test(c.name));
    const hasName = t.columns.some((c) => NAME.test(c.name));
    if (hasId && hasName && t.rows > 0) {
      nameCandidates.push({
        file: rel,
        table: t.name,
        columns: t.columns,
        rows: t.rows,
        // 路径或表名带 contact 的最像联系人表；昵称列权重高于 id 列。
        score:
          (/contact/i.test(rel) ? 3 : 0) +
          (/contact/i.test(t.name) ? 3 : 0) +
          (t.columns.some((c) => /nick_?name|remark|display_?name/i.test(c.name)) ? 2 : 0),
      });
    }
  }
}

const best = candidates.sort((a, b) => b.score - a.score)[0];
if (!best) {
  console.log(
    "\n没找到像消息表的结构（需要同时有 时间列 + 内容列）。把上面每张表的列名贴给我，我来定映射。",
  );
  process.exit(0);
}

const pick = (re: RegExp) => best.columns.find((c) => re.test(c.name))?.name ?? "";

console.log(`\n=== 样例（${best.file} → ${best.table}，前 2 行）`);
for (const row of sampleOf(resolve(root, best.file), best.table)) {
  const pairs = Object.entries(row).slice(0, 12).map(([k, v]) => `${k}=${truncate(v)}`);
  console.log(`  ${pairs.join(" | ")}`);
}

// 联系人库优先选昵称列（nickName/remark），没有就用 name/alias。
const bestNames = nameCandidates.sort((a, b) => b.score - a.score)[0];
const pickName = (re: RegExp) => bestNames?.columns.find((c) => re.test(c.name))?.name ?? "";
const pickId = (re: RegExp) => bestNames?.columns.find((c) => re.test(c.name))?.name ?? "";

const mapping = {
  messages: {
    db: best.file,
    table: best.table,
    columns: {
      id: pick(/^(local_?id|id|msg_?id|server_?id)$/i) || pick(/id/i),
      time: pick(TIME),
      isSelf: pick(SELF),
      peer: pick(/talker|chat|peer|username|session|room/i),
      text: pick(TEXT),
    },
    selfValues: [1, "1", true],
  },
  peerNames: bestNames
    ? {
        db: bestNames.file,
        table: bestNames.table,
        columns: {
          id: pickId(/^(user_?name|wxid|id)$/i) || pickId(/id/i),
          name:
            pickName(/^(nick_?name|display_?name)$/i) ||
            pickName(/^(remark|alias|name)$/i) ||
            pickName(NAME),
        },
      }
    : { db: "", table: "", columns: { id: "", name: "" } },
  timeUnit: "auto",
};

console.log("\n=== 映射骨架（确认列名对得上再填 peerNames）");
console.log(JSON.stringify(mapping, null, 2));

if (flag("write")) {
  const out = resolve(".runtime/wechat-mapping.json");
  mkdirSync(resolve(".runtime"), { recursive: true });
  writeFileSync(out, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
  console.log(`\n已写入 ${out}`);
  console.log(
    "下一步：核对上面骨架里的列名，填好 peerNames 后跑\n" +
      '  SOURCE=wechat WECHAT_DB_DIR="<decrypted 目录>" ALLOWED_PEERS="<昵称>" npx tsx scripts/run.ts',
  );
} else {
  console.log("\n加 --write 可把骨架写进 .runtime/wechat-mapping.json");
}
