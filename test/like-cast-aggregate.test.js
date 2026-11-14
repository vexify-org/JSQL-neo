const { executeSQL } = require('../lib/sql');
const D = require('../lib/database');
/**
 * #94 / #96 / #98
 *   #94  数值列上的 LIKE 永不匹配；NULL LIKE 被当成 false
 *   #96  CAST(x AS DECIMAL(p,s)) 忽略精度与标度，原值原样返回
 *   #98  STRING 列上的 MIN/MAX 用数值比较，与 ORDER BY 矛盾且改变返回类型
 *
 *   node test/like-cast-aggregate.test.js
 */
(async () => { const db = new D(':memory:'); const q = s => executeSQL(db, s, {safety:false});
 let p=0,f=0; const ok=(n,c,g)=>{if(c)p++;else{f++;console.log('[FAIL]',n,'->',JSON.stringify(g));}};
 await q('CREATE TABLE t (id INT PRIMARY KEY, a INT, s STRING, d DATE)');
 await q("INSERT INTO t VALUES (1,10,'2','2026-01-02'),(2,20,'100','2026-01-01'),(3,30,'9','2026-03-01')");
 // #94
 let r=(await q("SELECT id FROM t WHERE a LIKE '1%'")).rows; ok('#94 a LIKE 1% → [1]', r.length===1&&r[0][0]===1, r);
 r=(await q("SELECT id FROM t WHERE a LIKE '2%'")).rows; ok('#94 a LIKE 2% → [2]', r.length===1&&r[0][0]===2, r);
 ok('#94 a LIKE NULL → NULL(非 false)', (await q("SELECT a LIKE NULL v FROM t WHERE id=1")).rows[0][0]===null);
 ok('#94 字符串列 LIKE 不回归', (await q("SELECT id FROM t WHERE s LIKE '1%'")).rows.length===1);
 // #96
 ok('#96 DECIMAL(10,2)', (await q('SELECT CAST(123.456 AS DECIMAL(10,2)) v')).rows[0][0]===123.46);
 ok('#96 DECIMAL(10,0)', (await q('SELECT CAST(123.456 AS DECIMAL(10,0)) v')).rows[0][0]===123);
 ok('#96 DECIMAL 默认(10,0)', (await q('SELECT CAST(123.456 AS DECIMAL) v')).rows[0][0]===123);
 ok('#96 负数半远离零', (await q('SELECT CAST(-2.5 AS DECIMAL(5,0)) v')).rows[0][0]===-3);
 ok('#96 不回归 DOUBLE', (await q('SELECT CAST(123.456 AS DOUBLE) v')).rows[0][0]===123.456);
 ok('#97? CAST SIGNED 不回归', (await q("SELECT CAST('12abc' AS SIGNED) v")).rows[0][0]===12);
 // #98
 r=(await q('SELECT MIN(s), MAX(s) FROM t')).rows[0]; ok("#98 MIN/MAX(string) → '100'/'9'", r[0]==='100'&&r[1]==='9', r);
 r=(await q('SELECT s FROM t ORDER BY s')).rows.map(x=>x[0]); ok('#98 与 ORDER BY 一致', JSON.stringify(r)===JSON.stringify(['100','2','9']), r);
 r=(await q('SELECT MIN(a), MAX(a) FROM t')).rows[0]; ok('#98 数值列仍数值比较 → 10/30', r[0]===10&&r[1]===30, r);
 r=(await q('SELECT MIN(d), MAX(d) FROM t')).rows[0]; ok('#98 日期列按时间序', r[0]==='2026-01-01'&&r[1]==='2026-03-01', r);
 console.log(`\nlike-cast-aggregate: ${p} passed, ${f} failed`); db.stop(); process.exit(f?1:0); })();
