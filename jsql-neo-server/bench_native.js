const { JSQL } = require('./lib/native_client.js');

async function run(label, rows) {
  const SCHEMA = { id: { type: "integer", primary_key: true, auto_increment: true }, name: { type: "string" }, age: { type: "integer" }, email: { type: "string" }, score: { type: "float" } };
  const db = new JSQL({ flushThreshold: 100000 });
  await db.createTable('t_' + label, SCHEMA);
  const data = [];
  for (let i = 0; i < rows; i++) {
    data.push({ name: `user_${i+1}`, age: 20 + (i % 50), email: `user_${i+1}@test.com`, score: (i % 10000) / 100.0 });
  }
  const start = Date.now();
  await db.insert('t_' + label, data);
  const end = Date.now();
  const ms = end - start;
  console.log(`${label}: ${rows} rows in ${ms}ms (${(rows / ms / 1000).toFixed(3)}M/sec)`);
  await db.stop();
}

(async () => {
  await run('10K', 10000);
  await run('50K', 50000);
  await run('100K', 100000);
})();
