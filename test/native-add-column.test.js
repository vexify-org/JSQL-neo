/*
 * add_column 数据损坏回归测试（issue #22）
 *   node test/native-add-column.test.js
 *
 * 覆盖：>1 行表添加列后，首行之后的所有行不得被静默损坏。
 *   1. 纯 JS 引擎：2 行表 ADD COLUMN -> 两行数据完整。
 *   2. Native (Rust) 引擎：同样场景 -> 两行数据完整（修复点，直接走 Rust add_column）。
 *   3. Native 持久化（disk）重开 -> 数据仍完整。
 * 无 native 编译产物时：Native 部分标记 SKIP，纯 JS 部分照常跑。
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const ROOT = path.join(__dirname, "..");

const { Database, NativeJSQL } = require(path.join(ROOT, "index.js"));

const NATIVE_FILE = path.join(ROOT, "native", "jsql-neo-native.node");
const NATIVE_AVAILABLE = (() => {
  if (!fs.existsSync(NATIVE_FILE)) return false;
  try { require(NATIVE_FILE); return true; } catch (e) { return false; }
})();

let passed = 0, failed = 0, skipped = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("[OK]", name); }
  else { failed++; console.log("[FAIL]", name, extra !== undefined ? JSON.stringify(extra) : ""); }
}
function skip(name, why) { skipped++; console.log("[SKIP]", name, why ? "(" + why + ")" : ""); }

async function scenario(name, mk, addCol) {
  const db = await mk();
  await db.createTable("users", { id: "integer primary key auto_increment", name: "string" });
  await db.insert("users", { name: "Alice" });  // id = 1
  await db.insert("users", { name: "Bob" });    // id = 2
  await addCol(db);                                // ADD COLUMN age
  const rows = await db.find("users", {});
  rows.sort((a, b) => a.id - b.id);
  ok(name + " 行数 = 2", rows.length === 2, rows.length);
  ok(name + " row1(id=1) 完整", rows[0] && rows[0].id === 1 && rows[0].name === "Alice", rows[0]);
  ok(name + " row2(id=2) 完整(修复点)", rows[1] && rows[1].id === 2 && rows[1].name === "Bob", rows[1]);
  ok(name + " age 列已添加", rows[0] && ("age" in rows[0]) && ("age" in rows[1]), { r0: rows[0], r1: rows[1] });
  if (db && db.stop) { try { await db.stop(); } catch (e) {} }
  if (db && db.close) { try { await db.close(); } catch (e) {} }
}

const sqlAddCol = async (db) => { await db.query("ALTER TABLE users ADD COLUMN age INTEGER DEFAULT 0"); };
const apiAddCol = async (db) => { await db.addColumn("users", "age", { type: "integer", nullable: true, default: 0 }); };

(async () => {
  console.log("--- 纯 JS 引擎 ---");
  await scenario("纯JS", async () => new Database(":memory:"), sqlAddCol);

  console.log("--- Native 引擎 ---");
  if (!NATIVE_AVAILABLE) {
    skip("Native addColumn", "native module unavailable");
  } else {
    await scenario("Native(memory)", async () => {
      const db = new NativeJSQL({ mode: "memory" });
      await db.start();
      return db;
    }, apiAddCol);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsql-addcol-"));
    await scenario("Native(disk)", async () => {
      const db = new NativeJSQL({ mode: "disk", path: dir });
      await db.start();
      return db;
    }, apiAddCol);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n" + passed + " passed, " + failed + " failed, " + skipped + " skipped");
  process.exit(failed ? 1 : 0);
})();
