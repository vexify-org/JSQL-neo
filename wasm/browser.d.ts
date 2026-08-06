/**
 * JSQL-NEO browser (WASM + IndexedDB) — ESM entry `jsql-neo/wasm/browser.mjs`.
 */

export type FieldType =
  | 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'datetime' | 'timestamp'
  | 'object' | 'array' | 'any';

export interface FieldDef {
  type: FieldType;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  unique?: boolean;
  required?: boolean;
  length?: number;
  default?: unknown;
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

export interface JSQLOptions {
  dbName?: string;
  persistence?: boolean;
  flushThreshold?: number;
  pageSize?: number;
}

export class JSQL {
  constructor(opts?: JSQLOptions);
  on(event: JSQLHook, fn: (...args: any[]) => unknown): this;
  onEvent(fn: (event: string, data: unknown) => void): this;
  start(): Promise<void>;
  stop(): Promise<void>;
  flush(): Promise<void>;
  createTable(name: string, schema: Schema): Promise<unknown>;
  dropTable(name: string): Promise<unknown>;
  insert(table: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<unknown>;
  findById(table: string, id: number | string): Promise<Row | null>;
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
  beginTx(): Promise<void>;
  commitTx(): Promise<void>;
  rollbackTx(): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  listDatabases(): Promise<string[]>;
  createDatabase(name: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  useDatabase(name: string): Promise<void>;
  executeSQL(sql: string, params?: unknown[]): Promise<unknown>;
  export default?: never;
}

export function init(input?: Uint8Array | ArrayBuffer | Response | WebAssembly.Module | URL | string): Promise<JSQL | void>;
