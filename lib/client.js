const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function binPath() {
    const dir = path.join(__dirname, '..', 'bin');
    const name = process.platform === 'win32' ? 'jsql-neo-server.exe' : 'jsql-neo-server';
    return path.join(dir, name);
}

class JSQL {
    constructor(opts = {}) {
        this.host = opts.host || '127.0.0.1';
        this.port = opts.port || 6379;
        this.dataDir = opts.dataDir || null;
        this._process = null;
    }

    async start() {
        if (this._process) return;
        const bp = binPath();
        if (!fs.existsSync(bp)) {
            throw new Error(`jsql-neo-server binary not found at ${bp}. Run 'npm run postinstall' to build it.`);
        }
        const args = [];
        if (this.dataDir) {
            args.push('--data-dir', this.dataDir);
        }
        this._process = spawn(bp, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                JSQL_HOST: this.host,
                JSQL_PORT: String(this.port),
                ...(this.dataDir ? { JSQL_DATA_DIR: this.dataDir } : {}),
            }
        });
        this._process.stdout.on('data', d => process.stdout.write(d));
        this._process.stderr.on('data', d => process.stderr.write(d));
        this._process.on('exit', (code) => { this._process = null; });
        await this._waitForServer();
    }

    async stop() {
        if (!this._process) return;
        this._process.kill();
        await new Promise(r => setTimeout(r, 500));
        this._process = null;
    }

    _waitForServer(retries = 20) {
        return new Promise((resolve, reject) => {
            const tryConnect = (n) => {
                if (n <= 0) return reject(new Error('server did not start'));
                const req = http.get(`http://${this.host}:${this.port}/health`, (res) => {
                    if (res.statusCode === 200) resolve();
                    else setTimeout(() => tryConnect(n - 1), 200);
                });
                req.on('error', () => setTimeout(() => tryConnect(n - 1), 200));
                req.setTimeout(500, () => { req.destroy(); setTimeout(() => tryConnect(n - 1), 200); });
            };
            tryConnect(retries);
        });
    }

    async _request(method, path, body) {
        return new Promise((resolve, reject) => {
            const opts = {
                hostname: this.host,
                port: this.port,
                path,
                method,
                headers: body ? { 'Content-Type': 'application/json' } : {},
            };
            const req = http.request(opts, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error(`invalid JSON: ${data}`)); }
                });
            });
            req.on('error', reject);
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    async createTable(name, schema) {
        return this._request('POST', `/db/${name}`, schema);
    }
    async dropTable(name) {
        return this._request('DELETE', `/db/${name}`);
    }
    async insert(table, data) {
        return this._request('POST', `/db/${table}/insert`, { data: Array.isArray(data) ? data : [data] });
    }
    async insertMany(table, data) {
        return this._request('POST', `/db/${table}/insertMany`, { data });
    }
    async findById(table, id) {
        return this._request('GET', `/db/${table}/${id}`);
    }
    async find(table, query = {}) {
        return this._request('POST', `/db/${table}/find`, query);
    }
    async count(table) {
        return this._request('GET', `/db/${table}/count`);
    }
    async updateById(table, id, data) {
        return this._request('PUT', `/db/${table}/${id}`, { data });
    }
    async removeById(table, id) {
        return this._request('DELETE', `/db/${table}/${id}`);
    }
    async updateByFilter(table, filter, data) {
        return this._request('POST', `/db/${table}/update`, { filter, data });
    }
    async removeByFilter(table, filter) {
        return this._request('POST', `/db/${table}/remove`, { filter });
    }
}

module.exports = { JSQL };
