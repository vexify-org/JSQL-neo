/*
 * Issue #40 — CREATE TABLE 里的表级 FOREIGN KEY 被静默忽略。
 *
 * 此前 `_parseTableConstraint` 只消费 FOREIGN KEY 语法、不注册约束：
 *   - `_foreignKeys` 为空 → 孤立引用随便插，引用完整性形同虚设
 *   - 列内联 `pid INTEGER REFERENCES p(id)` 更是在解析阶段就报
 *     "Expected ',' or ')' in CREATE TABLE, got 'REFERENCES'"
 *
 * 现在表级 / 列级外键都真正注册，并复用 lib/table.js 的校验与
 * ON DELETE / ON UPDATE 传播逻辑；不支持的写法（复合外键）显式报错。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql.js'));

const OPTS = { safety: false };
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 200) : ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function t(name, fn) {
  const db = new Database(':memory:');
  const exec = (sql) => executeSQL(db, sql, OPTS);
  const rows = async (sql) => (await exec(sql)).rows;
  const mustFail = async (sql, re) => {
    try { await exec(sql); return false; }
    catch (e) { return re ? re.test(e.message) : true; }
  };
  try {
    const r = await fn({ db, exec, rows, mustFail });
    ok(name, r === undefined ? true : !!r);
  } catch (e) {
    ok(name, false, e.message);
  }
}

async function setup(p, c) {
  const db = new Database(':memory:');
  const exec = (sql) => executeSQL(db, sql, OPTS);
  const rows = async (sql) => (await exec(sql)).rows;
  const mustFail = async (sql, re) => {
    try { await exec(sql); return false; }
    catch (e) { return re ? re.test(e.message) : true; }
  };
  await exec(p);
  await exec(c);
  return { db, exec, rows, mustFail };
}

(async () => {
  console.log('\n--- 表级 FOREIGN KEY 注册 ---');

  await t('表级 FOREIGN KEY 写入 _foreignKeys（field/table/refField/动作）', async ({ db, exec }) => {
    await exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
    await exec('CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p(id) ON DELETE CASCADE ON UPDATE SET NULL)');
    const fks = db._tables.c._foreignKeys;
    return eq(fks, [{ field: 'pid', table: 'p', refField: 'id', onDelete: 'cascade', onUpdate: 'set null' }]);
  });

  await t('默认动作是 restrict（不写 ON DELETE/UPDATE）', async ({ db, exec }) => {
    await exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
    await exec('CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p(id))');
    const fk = db._tables.c._foreignKeys[0];
    return fk && fk.onDelete === 'restrict' && fk.onUpdate === 'restrict';
  });

  await t('CONSTRAINT 命名 + 外键写在列定义之前也能注册', async ({ db, exec }) => {
    await exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
    await exec('CREATE TABLE c (CONSTRAINT fk_pid FOREIGN KEY (pid) REFERENCES p(id), id INTEGER PRIMARY KEY, pid INTEGER)');
    return db._tables.c._foreignKeys.length === 1 && db._tables.c._foreignKeys[0].field === 'pid';
  });

  await t('REFERENCES p 省略列名时默认引用 id', async ({ db, exec }) => {
    await exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
    await exec('CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p)');
    return db._tables.c._foreignKeys[0].refField === 'id';
  });

  console.log('\n--- 引用完整性真正生效 ---');

  await t('孤立引用被拒绝（issue 复现用例）', async () => {
    const { exec, rows, mustFail } = await setup(
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p(id))'
    );
    await exec('INSERT INTO p (id) VALUES (1)');
    const rejected = await mustFail('INSERT INTO c (id, pid) VALUES (1, 999)', /foreign key/i);
    return rejected && eq(await rows('SELECT id, pid FROM c'), []);
  });

  await t('合法引用可以插入', async () => {
    const { exec, rows } = await setup(
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p(id))'
    );
    await exec('INSERT INTO p (id) VALUES (1)');
    await exec('INSERT INTO c (id, pid) VALUES (1, 1)');
    return eq(await rows('SELECT id, pid FROM c'), [[1, 1]]);
  });

  await t('外键列为 NULL 不构成引用（SQL 语义）', async () => {
    const { exec, rows } = await setup(
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p(id))'
    );
    await exec('INSERT INTO c (id, pid) VALUES (1, NULL)');
    return eq(await rows('SELECT id, pid FROM c'), [[1, null]]);
  });

  await t('UPDATE 子表外键列指向不存在的父行被拒绝', async () => {
    const { exec, mustFail } = await setup(
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p(id))'
    );
    await exec('INSERT INTO p (id) VALUES (1)');
    await exec('INSERT INTO c (id, pid) VALUES (1, 1)');
    return mustFail('UPDATE c SET pid = 999 WHERE id = 1', /foreign key/i);
  });

  await t('批量插入（insertMany）同样校验外键', async ({ db, exec }) => {
    await exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
    await exec('CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p(id))');
    try {
      await db._tables.c.insertMany([{ id: 1, pid: 999 }]);
      return false;
    } catch (e) { return /foreign key/i.test(e.message); }
  });

  console.log('\n--- ON DELETE ---');

  await t('ON DELETE CASCADE 删除父行连带删除子行', async () => {
    const { exec, rows } = await setup(
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p(id) ON DELETE CASCADE)'
    );
    await exec('INSERT INTO p (id) VALUES (1), (2)');
    await exec('INSERT INTO c (id, pid) VALUES (1, 1), (2, 1), (3, 2)');
    await exec('DELETE FROM p WHERE id = 1');
    return eq(await rows('SELECT id, pid FROM c'), [[3, 2]]);
  });

  await t('ON DELETE SET NULL 删除父行把子行外键置空', async () => {
    const { exec, rows } = await setup(
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p(id) ON DELETE SET NULL)'
    );
    await exec('INSERT INTO p (id) VALUES (1)');
    await exec('INSERT INTO c (id, pid) VALUES (1, 1)');
    await exec('DELETE FROM p WHERE id = 1');
    return eq(await rows('SELECT id, pid FROM c'), [[1, null]]);
  });

  await t('ON DELETE RESTRICT 阻止删除被引用的父行', async () => {
    const { exec, mustFail } = await setup(
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p(id))'
    );
    await exec('INSERT INTO p (id) VALUES (1)');
    await exec('INSERT INTO c (id, pid) VALUES (1, 1)');
    return mustFail('DELETE FROM p WHERE id = 1', /foreign key/i);
  });

  console.log('\n--- ON UPDATE ---');

  await t('ON UPDATE CASCADE 父行主键变更传播到子行', async () => {
    const { exec, rows } = await setup(
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p(id) ON UPDATE CASCADE)'
    );
    await exec('INSERT INTO p (id) VALUES (1)');
    await exec('INSERT INTO c (id, pid) VALUES (1, 1)');
    await exec('UPDATE p SET id = 10 WHERE id = 1');
    return eq(await rows('SELECT id FROM p'), [[10]]) && eq(await rows('SELECT id, pid FROM c'), [[1, 10]]);
  });

  await t('ON UPDATE SET NULL 父行主键变更把子行外键置空', async () => {
    const { exec, rows } = await setup(
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p(id) ON UPDATE SET NULL)'
    );
    await exec('INSERT INTO p (id) VALUES (1)');
    await exec('INSERT INTO c (id, pid) VALUES (1, 1)');
    await exec('UPDATE p SET id = 10 WHERE id = 1');
    return eq(await rows('SELECT id, pid FROM c'), [[1, null]]);
  });

  await t('ON UPDATE RESTRICT 阻止修改被引用的父行主键', async () => {
    const { exec, mustFail } = await setup(
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid) REFERENCES p(id))'
    );
    await exec('INSERT INTO p (id) VALUES (1)');
    await exec('INSERT INTO c (id, pid) VALUES (1, 1)');
    return mustFail('UPDATE p SET id = 10 WHERE id = 1', /foreign key/i);
  });

  console.log('\n--- 列内联 REFERENCES（此前解析直接报错） ---');

  await t('列内联 REFERENCES 可解析并注册外键', async ({ db, exec }) => {
    await exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
    await exec('CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id) ON DELETE CASCADE)');
    const fks = db._tables.c._foreignKeys;
    return eq(fks, [{ field: 'pid', table: 'p', refField: 'id', onDelete: 'cascade', onUpdate: 'restrict' }]);
  });

  await t('列内联外键同样拒绝孤立引用', async () => {
    const { exec, mustFail } = await setup(
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id))'
    );
    return mustFail('INSERT INTO c (id, pid) VALUES (1, 42)', /foreign key/i);
  });

  await t('列内联 + ON DELETE SET NULL 生效', async () => {
    const { exec, rows } = await setup(
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id) ON DELETE SET NULL)'
    );
    await exec('INSERT INTO p (id) VALUES (1)');
    await exec('INSERT INTO c (id, pid) VALUES (1, 1)');
    await exec('DELETE FROM p WHERE id = 1');
    return eq(await rows('SELECT id, pid FROM c'), [[1, null]]);
  });

  console.log('\n--- 显式报错，不再静默忽略 ---');

  await t('外键列名写错（nope）在建表时抛错', async () => {
    const db = new Database(':memory:');
    const exec = (sql) => executeSQL(db, sql, OPTS);
    await exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
    try {
      await exec('CREATE TABLE c (id INTEGER PRIMARY KEY, FOREIGN KEY (nope) REFERENCES p(id))');
      return false;
    } catch (e) { return /unknown column/i.test(e.message); }
  });

  await t('复合外键显式报不支持（不再静默丢弃）', async () => {
    const db = new Database(':memory:');
    const exec = (sql) => executeSQL(db, sql, OPTS);
    await exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
    try {
      await exec('CREATE TABLE c (id INTEGER PRIMARY KEY, a INT, b INT, FOREIGN KEY (a, b) REFERENCES p(id))');
      return false;
    } catch (e) { return /composite foreign key/i.test(e.message); }
  });

  await t('缺少 REFERENCES 子句 → 明确报错', async () => {
    const db = new Database(':memory:');
    const exec = (sql) => executeSQL(db, sql, OPTS);
    try {
      await exec('CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, FOREIGN KEY (pid))');
      return false;
    } catch (e) { return /expected references/i.test(e.message); }
  });

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
