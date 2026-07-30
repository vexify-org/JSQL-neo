const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN_NAME = process.platform === 'win32' ? 'jsql-neo-server.exe' : 'jsql-neo-server';
const BP = path.join(__dirname, 'bin', BIN_NAME);

function main() {
    if (fs.existsSync(BP)) {
        fs.chmodSync(BP, 0o755);
        console.log(`[jsql-neo] binary ready: ${BP}`);
        return;
    }

    // Build from source
    const serverDir = path.join(__dirname, '..', 'jsql-neo-server');
    if (fs.existsSync(path.join(serverDir, 'Cargo.toml'))) {
        console.log('[jsql-neo] building Rust server from source...');
        try {
            execSync('cargo build --release', { cwd: serverDir, stdio: 'inherit' });
            const src = path.join(serverDir, 'target', 'release', BIN_NAME);
            if (fs.existsSync(src)) {
                fs.mkdirSync(path.join(__dirname, 'bin'), { recursive: true });
                fs.copyFileSync(src, BP);
                fs.chmodSync(BP, 0o755);
                console.log(`[jsql-neo] binary built: ${BP}`);
                return;
            }
        } catch (e) {
            console.warn('[jsql-neo] cargo build failed:', e.message);
        }
    }

    console.warn(`[jsql-neo] binary not found at ${BP}`);
    console.warn('[jsql-neo] install Rust from https://rustup.rs and run: npm run build');
}

main();
