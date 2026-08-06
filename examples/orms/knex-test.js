const knex = require('knex')({
  client: 'mysql2',
  connection: {
    host: '127.0.0.1',
    port: 33309,
    user: 'root',
    database: 'default',
  },
  pool: { min: 0, max: 2 },
});

const t = (name, fn) => {
  fn()
    .then(() => console.log('[OK]', name))
    .catch(e => { console.log('[FAIL]', name, '→', e.message); process.exitCode = 1; });
};

(async () => {
  await knex.schema.dropTableIfExists('posts');
  await knex.schema.createTable('posts', tb => {
    tb.increments('id').primary();
    tb.string('title', 100).notNullable();
    tb.integer('likes').defaultTo(0);
  });
  t('createTable posts', async () => {});

  const ids = await knex('posts').insert({ title: 'Hello', likes: 5 });
  t('insert → ' + JSON.stringify(ids), async () => ids[0] === 1);

  const rows = await knex('posts').select('*');
  t('select * → ' + JSON.stringify(rows), async () => rows.length === 1 && rows[0].title === 'Hello' && rows[0].id === 1);

  const cond = await knex('posts').where('likes', '>', 2).orderBy('likes', 'desc');
  t('where+orderBy → ' + JSON.stringify(cond), async () => cond.length === 1);

  const [cnt] = await knex('posts').count('* as n');
  t('count → ' + JSON.stringify(cnt), async () => Number(cnt.n) === 1);

  await knex('posts').where('id', 1).update({ likes: 9 });
  const after = await knex('posts').where({ id: 1 }).first();
  t('update → likes ' + after.likes, async () => after.likes === 9);

  await knex('posts').where('id', 1).del();
  const gone = await knex('posts').select('*');
  t('delete → remaining ' + gone.length, async () => gone.length === 0);

  const raw = await knex.raw('SELECT VERSION() AS v');
  t('raw VERSION() → ' + JSON.stringify(raw[0][0]), async () => String(raw[0][0].v).includes('jsql'));

  await knex.destroy();
  t('pool destroy', async () => true);
  if (process.exitCode) process.exit(process.exitCode);
  console.log('ALL OK');
  process.exit(0);
})().catch(e => { console.log('[FATAL]', e.message); process.exit(1); });
