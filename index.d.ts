/**
 * JSQL-NEO — Rust-powered embedded database (Native / WASM / Pure JS)
 * with a MySQL-compatible server mode.
 */

declare namespace JSQLNeo {
  export type FieldType =
    | 'string' | 'text' | 'varchar'
    | 'integer' | 'int' | 'bigint'
    | 'float' | 'double' | 'number'
    | 'boolean'
    | 'date' | 'datetime' | 'timestamp'
    | 'object' | 'json' | 'array'
    | 'any' | 'binary';

  export interface FieldDef {
    type: FieldType;
    primaryKey?: boolean;
    autoIncrement?: boolean;
    unique?: boolean;
    required?: boolean;
    nullable?: boolean;
    length?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    default?: unknown;
    check?: string;
    ref?: string;
    computed?: boolean;
  }

  export type Schema = Record<string, FieldDef>;

  export interface Row {
    id: number | string;
    fields?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
    [key: string]: unknown;
  }

  export interface FindOptions {
    limit?: number;
    offset?: number;
  }

  export interface JSQLOptions {
    dataDir?: string;
    flushThreshold?: number;
    modules?: boolean;
    persistence?: boolean;
    dbName?: string;
  }

  export type JSQLHook =
    | 'beforeInsert' | 'afterInsert'
    | 'beforeUpdate' | 'afterUpdate'
    | 'beforeDelete' | 'afterDelete'
    | 'beforeFind' | 'afterFind'
    | 'beforeCreateTable' | 'afterCreateTable'
    | 'beforeDropTable' | 'afterDropTable'
    | 'beforeFlush' | 'afterFlush'
    | 'beforeCount' | 'afterCount'
    | 'onStart' | 'onStop';

  export interface JSQLPlugin {
    name?: string;
    install?(db: JSQL, ctx: PluginContext): void;
    onEvent?(event: string, data: unknown): void;
    hooks?: Partial<Record<JSQLHook, (...args: any[]) => unknown>>;
  }

  export interface PluginContext {
    name: string;
    engine: JSQL;
    plugin: JSQLPlugin;
    on(hook: JSQLHook, fn: (...args: any[]) => unknown): JSQL;
    onEvent(fn: (event: string, data: unknown) => void): JSQL;
    emit(eventName: string, data: unknown): void;
    tables(): string[];
    hasTable(name: string): boolean;
    getTableSchema(name: string): Schema | null;
  }

  export class JSQL {
    constructor(opts?: JSQLOptions);
    use(plugin: JSQLPlugin | ((db: JSQL) => void)): this;
    on(event: JSQLHook, fn: (...args: any[]) => unknown): this;
    onEvent(fn: (event: string, data: unknown) => void): this;
    start(): Promise<void>;
    stop(): Promise<void>;
    flush(): Promise<void>;
    createTable(name: string, schema: Schema): Promise<unknown>;
    dropTable(name: string): Promise<unknown>;
    insert(table: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<unknown>;
    insertMany(table: string, data: Record<string, unknown>[]): Promise<unknown>;
    findById(table: string, id: number | string | bigint): Promise<Row | null>;
    findByIds(table: string, ids: Array<number | string>): Promise<Row[] | null>;
    find(table: string, filter?: Record<string, unknown>, opts?: FindOptions): Promise<Row[]>;
    count(table: string): Promise<number>;
    updateById(table: string, id: number | string, data: Record<string, unknown>): Promise<unknown>;
    updateByIds(table: string, entries: Array<[number | string, Record<string, unknown>]>): Promise<unknown>;
    removeById(table: string, id: number | string): Promise<unknown>;
    removeByIds(table: string, ids: Array<number | string>): Promise<unknown>;
    hasTable(name: string): Promise<boolean>;
    getTables(): Promise<string[]>;
    getTableSchema(name: string): Promise<Schema | null>;
  }

  export class NativeJSQL extends JSQL {}

  export interface MysqlServerOptions {
    port?: number;
    host?: string;
    dataDir?: string;
    defaultDatabase?: string;
    noAuth?: boolean;
    auth?: Record<string, string>;
    allowComments?: boolean;
    safety?: boolean;
    maxConnections?: number;
    handshakeTimeout?: number;
    maxAuthFails?: number;
  }

  export class MysqlServer {
    constructor(options?: MysqlServerOptions);
    listen(cb?: (err?: Error) => void): this;
    close(cb?: () => void): void;
    readonly address: { port: number; address: string; family: string } | null;
    listDatabases(): Promise<string[]>;
    createDatabase(name: string, opts?: { ifNotExists?: boolean }): Promise<void>;
    dropDatabase(name: string, opts?: { ifExists?: boolean }): Promise<void>;
  }

  export function createMysqlServer(options?: MysqlServerOptions): MysqlServer;

  export interface RedisServerOptions {
    port?: number;
    host?: string;
    password?: string | null;
    dataDir?: string | null;
    onQuery?: (cmd: string, args: string[]) => void;
  }

  export class RedisServer {
    constructor(options?: RedisServerOptions);
    listen(): this;
    stop(): void;
    execute(cmd: string, args: string[]): string | number | string[] | null | 'OK' | 'PONG';
  }

  export function createRedisServer(options?: RedisServerOptions): RedisServer;

  export interface WebUIOptions {
    port?: number;
    host?: string;
    dataDir?: string;
    readonly?: boolean;
  }

  export class WebUI {
    constructor(options?: WebUIOptions);
    start(): Promise<number>;
    stop(): Promise<void>;
    listDatabases(): { name: string; tables: number }[];
  }

  export interface MigrateResult {
    created?: string[];
    inserted?: number;
    errors?: { line?: number; error: string }[];
  }

  export interface MigrateTools {
    normalizeSchema(schema: Record<string, unknown>): Record<string, unknown>;
    parseCSV(text: string): string[][];
    toCSV(rows: Record<string, unknown>[], columns?: string[]): string;
    exportTableToJSON(db: unknown, table: string): { schema: unknown; rows: unknown[] };
    exportAllToJSON(db: unknown): Record<string, unknown>;
    importFromJSON(db: unknown, data: Record<string, unknown>): Promise<MigrateResult>;
    exportTableToCSV(db: unknown, table: string): string;
    importFromCSV(db: unknown, table: string, csv: string, opts?: { schema?: unknown }): Promise<MigrateResult>;
    importDump(db: unknown, sql: string, opts?: { strict?: boolean }): Promise<MigrateResult>;
    importDumpFile(db: unknown, file: string, opts?: { strict?: boolean }): Promise<MigrateResult>;
    exportToFile(db: unknown, table: string, outFile: string): Promise<number>;
  }

  export const migrate: MigrateTools;
  export function exportTableToJSON(db: unknown, table: string): { schema: unknown; rows: unknown[] };
  export function exportAllToJSON(db: unknown): Record<string, unknown>;
  export function importFromJSON(db: unknown, data: Record<string, unknown>): Promise<MigrateResult>;
  export function exportTableToCSV(db: unknown, table: string): string;
  export function importFromCSV(db: unknown, table: string, csv: string, opts?: { schema?: unknown }): Promise<MigrateResult>;
  export function importDump(db: unknown, sql: string, opts?: { strict?: boolean }): Promise<MigrateResult>;
  export function importDumpFile(db: unknown, file: string, opts?: { strict?: boolean }): Promise<MigrateResult>;
  export function exportToFile(db: unknown, table: string, outFile: string): Promise<number>;

  export interface ConnectionOptions {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
  }

  export interface ConnectionResult {
    insertId: number | null;
    affectedRows: number;
    rows: unknown[];
    fields?: unknown[];
  }

  export class Connection {
    constructor(options?: ConnectionOptions);
    connect(cb?: (err?: Error) => void): void;
    query(sql: string, params?: unknown[], cb?: (err: Error | null, result: ConnectionResult) => void): void;
    execute(sql: string, params?: unknown[], cb?: (err: Error | null, result: ConnectionResult) => void): void;
    beginTransaction(cb?: (err?: Error) => void): void;
    commit(cb?: (err?: Error) => void): void;
    rollback(cb?: (err?: Error) => void): void;
    end(): void;
    format(sql: string, params?: unknown[]): string;
    escape(value: unknown): string;
    escapeId(value: string): string;
  }

  export class Pool {
    constructor(options?: ConnectionOptions & { max?: number });
    query(sql: string, params?: unknown[], cb?: (err: Error | null, result: ConnectionResult) => void): void;
    getConnection(cb: (err: Error | null, conn: Connection) => void): void;
    end(): void;
  }

  export function createConnection(options?: ConnectionOptions): Connection;
  export function createPool(options?: ConnectionOptions & { max?: number }): Pool;

  export interface SQLResult {
    ok: boolean;
    type: string;
    table?: string | null;
    columns?: string[];
    rows?: unknown[][];
    raw?: unknown[];
    affectedRows?: number;
    insertId?: number | null;
    ids?: unknown[];
    error?: string;
  }

  export interface SQLOptions {
    allowComments?: boolean;
    safety?: boolean;
    maxStatements?: number;
    session?: Record<string, unknown>;
  }

  export function executeSQL(engine: unknown, sql: string, paramsOrOpts?: unknown[] | SQLOptions, opts?: SQLOptions): Promise<SQLResult>;
  export function parseSQL(sql: string): unknown;
  export function splitStatements(sql: string): string[];
  export function applyParams(sql: string, values: unknown[]): string;
  export function escapeValue(value: unknown): string;
  export function escapeId(value: string): string;

  export interface DatabaseOptions {
    dataDir?: string;
    persist?: boolean;
    inMemoryOnly?: boolean;
  }

  export class Database {
    constructor(options?: DatabaseOptions);
    createTable(name: string, schema: Schema): Promise<unknown>;
    insert(table: string, data: Record<string, unknown>): Promise<unknown>;
    find(table: string, filter?: Record<string, unknown>): Promise<Row[]>;
    update(table: string, filter: Record<string, unknown>, data: Record<string, unknown>): Promise<number>;
    remove(table: string, filter: Record<string, unknown>): Promise<number>;
    findOne(table: string, filter?: Record<string, unknown>): Promise<Row | null>;
    count(table: string): Promise<number>;
    getTables(): Promise<string[]>;
    dropTable(name: string): Promise<void>;
    getTableSchema(name: string): Promise<Schema | null>;
  }

  export class Table {
    constructor(name: string, schema: Schema, db?: unknown);
    insert(data: Record<string, unknown>): Promise<unknown>;
    find(filter?: Record<string, unknown>): Promise<Row[]>;
    updateById(id: number | string, data: Record<string, unknown>): Promise<unknown>;
    removeById(id: number | string): Promise<unknown>;
    count(): Promise<number>;
  }

  export class Query {
    constructor(table: unknown);
    exec(): Promise<Row[]>;
    then(resolve: (rows: Row[]) => unknown, reject?: (err: Error) => unknown): Promise<unknown>;
  }

  export class BTree {
    constructor(order?: number);
    insert(key: unknown, value: unknown): void;
    find(key: unknown): unknown;
    range(min: unknown, max: unknown): unknown[];
  }

  export class Cache {
    constructor(options?: Record<string, unknown>);
    get(key: string): unknown;
    set(key: string, value: unknown, ttlMs?: number): void;
    del(key: string): void;
    flush(): void;
    close(): void;
  }

  export class Plugin {
    static create(plugin: JSQLPlugin): JSQLPlugin;
  }

  export class ModuleManager {
    constructor(opts?: { cwd?: string });
    applyTo(engine: JSQL): void;
  }

  export class JSQL_Error extends Error {
    code: number;
    codeKey: string;
    args: unknown[];
  }

  export const ErrorCodes: Record<string, { code: number; msg: string }>;

  export class JSQLFormat {
    constructor(db: unknown);
    dump(): string;
    load(dump: string): void;
  }

  export class Datastore {
    constructor(options?: DatabaseOptions);
    insert(docs: unknown): Promise<unknown>;
    find(query?: unknown): Promise<unknown[]>;
    update(query: unknown, update: unknown): Promise<number>;
    remove(query: unknown): Promise<number>;
    loadDatabase(): Promise<void>;
    persistence: { persistCachedDatabase: (cb?: (err?: Error) => void) => void };
  }
}

export = JSQLNeo;
