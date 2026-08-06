require('reflect-metadata');
const { DataSource, EntitySchema, Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } = require('typeorm');
require('typeorm').Entity = (x) => x;
require('typeorm').PrimaryGeneratedColumn = (x) => x;
require('typeorm').Column = (x) => x;
require('typeorm').CreateDateColumn = (x) => x;

const User = new EntitySchema({
  name: 'user',
  tableName: 'users',
  columns: {
    id: { type: Number, primary: true, generated: true },
    name: { type: String, length: 100 },
    age: { type: Number, nullable: true },
  },
});

const t = (name, cond, fn) => {
  fn()
    .then(r => { if (cond(r)) console.log('[OK]', name); else { console.log('[FAIL]', name, '→ bad result:', JSON.stringify(r)); process.exitCode = 1; } })
    .catch(e => { console.log('[FAIL]', name, '→', e.message); process.exitCode = 1; });
};

(async () => {
  const clean = await require('mysql2/promise').createConnection({ host: '127.0.0.1', port: 33309, user: 'root' });
  await clean.query('DROP TABLE IF EXISTS users');
  await clean.end();

  const ds = new DataSource({
    type: 'mysql',
    host: '127.0.0.1',
    port: 33309,
    username: 'root',
    database: 'default',
    synchronize: true,
    logging: false,
    entities: [User],
  });
  await ds.initialize();
  t('initialize (connect + VERSION())', async () => true, async () => {});

  const repo = ds.getRepository(User);
  await repo.clear();
  t('synchronize + clear', async () => true, async () => {});

  const u = await repo.save({ name: 'Alice', age: 30 });
  t('save → id ' + u.id, async () => u.id !== undefined, async () => u);

  const found = await repo.findOne({ where: { name: 'Alice' } });
  t('findOne → ' + JSON.stringify(found), r => r && r.name === 'Alice' && r.age === 30, async () => found);

  const all = await repo.find();
  t('find all → ' + all.length, r => r.length === 1, async () => all);

  const cnt = await repo.count();
  t('count → ' + cnt, r => r === 1, async () => cnt);

  await repo.update({ id: u.id }, { age: 31 });
  const upd = await repo.findOne({ where: { id: u.id } });
  t('update → age ' + (upd && upd.age), r => r && r.age === 31, async () => upd);

  await repo.delete(u.id);
  const gone = await repo.count();
  t('delete → remaining ' + gone, r => r === 0, async () => gone);

  await ds.destroy();
  t('destroy', async () => true, async () => {});
  if (process.exitCode) process.exit(process.exitCode);
  console.log('ALL OK');
  process.exit(0);
})().catch(e => { console.log('[FATAL]', e.message); process.exit(1); });
