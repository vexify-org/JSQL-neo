'use strict';

/**
 * Minimal @vexify-org/yaggs-compatible CLI shim.
 *
 * Used when the optional dependency @vexify-org/yaggs is not installed
 * (offline install, private registry unreachable, lockfile drift, …).
 * Without this shim, bin/jsql crashed on every invocation — even --help /
 * --version — because the top-level `require('@vexify-org/yaggs')` threw.
 *
 * The shim mirrors the fluent API surface bin/jsql relies on:
 *   .usage(str).option(name, cfg).command(name, desc, builder, handler)
 *   .middleware(fn).run(argv)
 *
 * It captures every command handler registered via the fluent chain and
 * dispatches to it with a minimal `--key value` / `--flag` argument parse.
 * This keeps --help/--version and the core commands (serve, export, import,
 * mod, plugin, …) working even when the optional dependency is absent.
 */

function buildYaggsFallback(pkg) {
  // 与 @vexify-org/yaggs 的调用形态一致：buildYaggsFallback(pkg)({ pkg }) 返回 CLI 对象。
  return function makeCli(opts) {
    const realPkg = (opts && opts.pkg) || pkg;
    const commands = new Map();
    let usageStr = '';
    const self = {
    usage(u) { usageStr = u; return self; },
    option() { return self; },
    positional() { return self; },
    middleware() { return self; },
    command(name, description, builder, handler) {
      // 兼容两种签名：command(name, descObj) 或 command(name, desc, builder, handler)
      let h = handler;
      let desc = description;
      if (description && typeof description === 'object') {
        desc = description.description;
        if (description.handler) h = description.handler;
      }
      commands.set(name, { desc: desc || '', handler: h, builder: builder || (() => {}) });
      return self;
    },
    async run(argv) {
      const args = (argv || []).slice();
      const first = args[0];

      if (!first || first === '--help' || first === '-h' || first === 'help') {
        console.log(usageStr || `jsql ${realPkg.version} — embedded SQL CLI`);
        console.log('Usage: jsql <command> [options]');
        if (commands.size) {
          console.log('');
          console.log('Commands:');
          for (const [name, c] of commands) {
            console.log(`  ${name.padEnd(12)} ${c.desc}`);
          }
        }
        console.log('');
        console.log('Note: optional dependency @vexify-org/yaggs is not installed; full argument parsing is unavailable.');
        console.log('      Install it with `npm install @vexify-org/yaggs` to restore rich argument parsing.');
        return;
      }

      if (first === '--version' || first === '-v' || first === 'version') {
        console.log(realPkg.version);
        return;
      }

      const cmd = commands.get(first);
      if (!cmd) {
        console.error(`Unknown command: ${first}`);
        console.error('Run `jsql --help` for the list of commands.');
        process.exitCode = 1;
        return;
      }

      // 极简参数解析：--key value / --key=value / --flag，以及位置参数。
      const parsed = { _: [] };
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('--')) {
          const eq = a.indexOf('=');
          if (eq !== -1) {
            parsed[a.slice(2, eq)] = a.slice(eq + 1);
          } else {
            const nxt = args[i + 1];
            if (nxt !== undefined && !nxt.startsWith('-')) { parsed[a.slice(2)] = nxt; i++; }
            else parsed[a.slice(2)] = true;
          }
        } else if (a.startsWith('-') && a.length > 1) {
          const key = a.slice(1);
          const nxt = args[i + 1];
          if (nxt !== undefined && !nxt.startsWith('-')) { parsed[key] = nxt; i++; }
          else parsed[key] = true;
        } else {
          parsed._.push(a);
        }
      }

      if (cmd.handler) return cmd.handler(parsed);
      console.error(`Command '${first}' has no handler.`);
      process.exitCode = 1;
    },
    };
    return self;
  };
}

module.exports = { buildYaggsFallback };
