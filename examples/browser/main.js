import { JSQL } from 'jsql-neo';

const out = document.getElementById('out');
function log(line) {
  out.textContent += (out.textContent ? '\n' : '') + line;
}

document.getElementById('run').addEventListener('click', run);
document.getElementById('again').addEventListener('click', run);

let db;

async function run() {
  out.textContent = '';
  try {
    db = new JSQL({ dbName: 'jsql-demo', persistence: true });
    await db.start();
    log('> db started (WASM + IndexedDB)');

    await db.executeSQL(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(50),
      age INTEGER
    )`);
    log('> CREATE TABLE users');

    const existing = await db.count('users');
    log(`> rows before insert: ${existing}`);

    await db.executeSQL(`INSERT INTO users (name, age) VALUES
      ('Alice', 30), ('Bob', 25), ('Carol', 35)`);
    log('> INSERT 3 users');

    const r = await db.executeSQL(
      'SELECT name, age FROM users WHERE age > 26 ORDER BY age DESC'
    );
    log(`> SELECT age > 26 ORDER BY age DESC → ${JSON.stringify(r.rows)}`);

    const agg = await db.executeSQL(
      'SELECT COUNT(*) AS n, AVG(age) AS avg_age FROM users'
    );
    log(`> SELECT COUNT(*) / AVG(age) → ${JSON.stringify(agg.rows[0])}`);

    await db.executeSQL('UPDATE users SET age = 31 WHERE name = \'Bob\'');
    log('> UPDATE Bob → 31');

    await db.executeSQL('DELETE FROM users WHERE name = \'Carol\'');
    log('> DELETE Carol');

    await db.executeSQL('BEGIN');
    await db.executeSQL('INSERT INTO users (name, age) VALUES (\'Temp\', 99)');
    await db.executeSQL('ROLLBACK');
    log('> BEGIN / INSERT Temp / ROLLBACK (rollback works)');

    const n = await db.count('users');
    log(`> final row count: ${n}`);
    log('> refresh the page and click "Reload & persist check" to see IndexedDB persistence');
  } catch (e) {
    log('ERROR: ' + (e && e.message ? e.message : e));
  }
}

window.addEventListener('beforeunload', () => {
  if (db) db.stop();
});
