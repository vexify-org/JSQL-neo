const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize('default', 'root', '', {
  host: '127.0.0.1',
  port: 33309,
  dialect: 'mysql',
  logging: false,
});

const User = sequelize.define('User', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING(50), allowNull: false },
  age: { type: DataTypes.INTEGER, allowNull: false },
  email: { type: DataTypes.STRING(100) },
}, { tableName: 'users', timestamps: false });

async function main() {
  try {
    await sequelize.authenticate();
    console.log('[OK] authenticate');

    await sequelize.sync({ force: true });
    console.log('[OK] sync force (CREATE TABLE users)');

    const created = await User.create({ name: 'Alice', age: 30, email: 'a@x.com' });
    console.log('[OK] create → id', created.id, created.name);

    await User.bulkCreate([
      { name: 'Bob', age: 25, email: 'b@x.com' },
      { name: 'Carol', age: 35, email: 'c@x.com' },
    ]);
    console.log('[OK] bulkCreate');

    const rows = await User.findAll({ where: { age: { [Sequelize.Op.gt]: 26 } }, order: [['age', 'DESC']] });
    console.log('[OK] findAll age>26 →', rows.map(r => r.name).join(','));

    const cnt = await User.count();
    console.log('[OK] count →', cnt);

    await User.update({ age: 31 }, { where: { name: 'Bob' } });
    const bob = await User.findOne({ where: { name: 'Bob' } });
    console.log('[OK] update+findOne → Bob age', bob.age);

    await User.destroy({ where: { name: 'Carol' } });
    console.log('[OK] destroy → remaining', await User.count());

    const max = await User.max('age');
    console.log('[OK] max(age) →', max);
  } catch (e) {
    console.log('[FAIL]', e.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}
main();
