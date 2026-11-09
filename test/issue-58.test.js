/*
 * Issue #58 — ast.rewrite() 无法替换根节点（transform 可以）。
 *
 * rewrite 的 visit 只在 `parent && key` 成立时才调用 fn 并回写，
 * 根节点 parent===null 直接被跳过；而根替换是合法需求
 * （例如把整条 SELECT 换成改写后的版本）。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const AST = require(path.join(ROOT, 'lib', 'ast.js'));
const { parseSQL } = require(path.join(ROOT, 'lib', 'sql.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

try {
  // 1) 最小复现：纯对象树
  const tree = { type: 'select', x: 1 };
  const out = AST.rewrite(tree, (n) => (n && n.type === 'select' ? { type: 'select', y: 2 } : undefined));
  ok('#58 rewrite 能替换根节点', JSON.stringify(out) === JSON.stringify({ type: 'select', y: 2 }), out);
  ok('#58 返回的就是替换后的根', out && out.y === 2 && out.x === undefined, out);

  // 2) 根节点不被替换时保持原样
  const same = { type: 'select', x: 1 };
  AST.rewrite(same, () => undefined);
  ok('#58 无返回值时根节点不变', JSON.stringify(same) === JSON.stringify({ type: 'select', x: 1 }), same);

  // 3) 真实 SQL AST：把整条语句换成另一条
  const ast = parseSQL('SELECT a FROM t');
  const replaced = AST.rewrite(ast, (n) => (n && n.type === 'select' ? parseSQL('SELECT b FROM u') : undefined));
  ok('#58 真实 AST 根替换生效', replaced && replaced.from && replaced.from.tables[0].table === 'u', replaced && replaced.from);

  // 4) 嵌套节点替换仍然有效（不能为了根节点修复而回归旧行为）
  const ast2 = parseSQL('SELECT a FROM t WHERE a > 10');
  AST.rewrite(ast2, (n) => (n && n.type === 'value' && n.value === 10 ? { type: 'value', value: 20 } : undefined));
  const v = AST.find(ast2, (n) => n.type === 'value' && typeof n.value === 'number');
  ok('#58 嵌套节点替换未回归', v && v.value === 20, v);

  // 5) 数组根节点
  const arr = [{ type: 'select', x: 1 }, { type: 'select', x: 2 }];
  AST.rewrite(arr, (n) => (n && n.type === 'select' ? { type: 'select', y: n.x + 10 } : undefined));
  ok('#58 数组根元素替换', JSON.stringify(arr) === JSON.stringify([{ type: 'select', y: 11 }, { type: 'select', y: 12 }]), arr);
} catch (e) {
  fail++;
  console.log('[FAIL] unexpected exception:', (e && e.stack) || e);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
