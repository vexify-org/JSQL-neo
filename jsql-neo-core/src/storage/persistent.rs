use std::collections::HashMap;
use std::io::{Read, Write};
use crate::engine::table::{Table, FieldValue};
use crate::engine::Engine;
use crate::types::*;
use super::wal::{WalOp, WalWriter, WalReader};

pub struct PersistentEngine {
    tables: HashMap<String, Table>,
    wal: WalWriter,
    data_dir: String,
}

impl PersistentEngine {
    pub fn open(data_dir: &str) -> std::io::Result<Self> {
        std::fs::create_dir_all(data_dir)?;

        let wal_path = format!("{}/wal.log", data_dir);
        let snapshot_path = format!("{}/snapshot.json", data_dir);

        let wal = WalWriter::open(&wal_path)?;
        let (snapshot_tx, mut tables) = Self::load_snapshot(&snapshot_path)?;

        let reader = WalReader::open(&wal_path);
        let entries = reader.replay_after(snapshot_tx)?;

        for entry in &entries {
            match entry.op {
                WalOp::CreateTable => {
                    let def: TableDefinition = serde_json::from_slice(&entry.data).unwrap_or_else(|_|
                        TableDefinition { name: entry.table.clone(), schema: HashMap::new() }
                    );
                    tables.insert(def.name.clone(), Table::new(def.name, def.schema));
                }
                WalOp::DropTable => {
                    tables.remove(&entry.table);
                }
                WalOp::Insert => {
                    let rows: Vec<HashMap<String, serde_json::Value>> =
                        serde_json::from_slice(&entry.data).unwrap_or_default();
                    if let Some(t) = tables.get_mut(&entry.table) {
                        t.add_rows(rows);
                    }
                }
                WalOp::Update => {
                    if let Ok((id, data)) = serde_json::from_slice::<(u64, HashMap<String, serde_json::Value>)>(&entry.data) {
                        if let Some(t) = tables.get_mut(&entry.table) {
                            t.update_row(id, data);
                        }
                    }
                }
                WalOp::Delete => {
                    if let Ok(id) = serde_json::from_slice::<u64>(&entry.data) {
                        if let Some(t) = tables.get_mut(&entry.table) {
                            t.remove_row(id);
                        }
                    }
                }
            }
        }

        Ok(PersistentEngine { tables, wal, data_dir: data_dir.to_string() })
    }

    fn load_snapshot(path: &str) -> std::io::Result<(u64, HashMap<String, Table>)> {
        let mut file = match std::fs::File::open(path) {
            Ok(f) => f,
            Err(_) => return Ok((0, HashMap::new())),
        };
        let mut content = String::new();
        file.read_to_string(&mut content)?;

        #[derive(serde::Deserialize)]
        struct Snapshot {
            tx_id: u64,
            tables: Vec<TableSnapshot>,
        }

        #[derive(serde::Deserialize)]
        struct TableSnapshot {
            name: String,
            schema: Schema,
            rows: Vec<RowStoreSnapshot>,
            next_id: u64,
        }

        #[derive(serde::Deserialize)]
        struct RowStoreSnapshot {
            id: u64,
            fields: HashMap<String, serde_json::Value>,
            #[serde(default)]
            created_at: Option<serde_json::Value>,
            #[serde(default)]
            updated_at: Option<serde_json::Value>,
        }

        let snap: Snapshot = match serde_json::from_str(&content) {
            Ok(s) => s,
            Err(_) => return Ok((0, HashMap::new())),
        };

        fn ts_to_u64(ts: &Option<serde_json::Value>) -> u64 {
            match ts {
                Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0),
                Some(serde_json::Value::String(s)) => {
                    s.parse::<u64>().unwrap_or_else(|_| {
                        use chrono::DateTime;
                        DateTime::parse_from_rfc3339(s).map(|dt| dt.timestamp_millis() as u64).unwrap_or(0)
                    })
                }
                _ => 0,
            }
        }

        let mut tables = HashMap::new();
        for ts in snap.tables {
            let mut table = Table::new(ts.name.clone(), ts.schema);
            table.next_id = ts.next_id;
            let nf = table.field_order.len();
            table.values.reserve(ts.rows.len() * nf);
            for rs in ts.rows {
                let values_start = table.values.len();
                for name in &table.field_order {
                    let jv = rs.fields.get(name).cloned().unwrap_or(serde_json::Value::Null);
                    table.values.push(FieldValue::from_json(jv));
                }
                table.rows.push(crate::engine::table::RowStore {
                    id: rs.id,
                    values_start,
                    num_values: nf,
                    created_at: ts_to_u64(&rs.created_at),
                    updated_at: ts_to_u64(&rs.updated_at),
                });
            }
            tables.insert(ts.name, table);
        }

        Ok((snap.tx_id, tables))
    }

    pub fn sync(&self) -> std::io::Result<()> {
        self.wal.sync_all()
    }

    pub fn save_snapshot(&self) -> std::io::Result<()> {
        let snapshot_path = format!("{}/snapshot.json", self.data_dir);

        let table_snaps: Vec<_> = self.tables.iter().map(|(name, table)| {
            serde_json::json!({
                "name": name,
                "schema": table.schema,
                "rows": table.rows.iter().map(|r| serde_json::json!({
                    "id": r.id,
                    "fields": table.to_row_map(table.get_row_values(r)),
                    "created_at": r.created_at,
                    "updated_at": r.updated_at,
                })).collect::<Vec<_>>(),
                "next_id": table.next_id,
            })
        }).collect();

        #[derive(serde::Serialize)]
        struct SnapshotOut {
            tx_id: u64,
            tables: Vec<serde_json::Value>,
        }

        let snap = SnapshotOut {
            tx_id: self.wal.current_tx(),
            tables: table_snaps,
        };

        let tmp = format!("{}/snapshot.json.tmp", self.data_dir);
        {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(serde_json::to_string(&snap)?.as_bytes())?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &snapshot_path)?;

        Ok(())
    }
}

impl Engine for PersistentEngine {
    fn create_table(&mut self, def: TableDefinition) -> Result<(), String> {
        if self.tables.contains_key(&def.name) {
            return Err(format!("table '{}' already exists", def.name));
        }
        let data = serde_json::to_vec(&def).map_err(|e| e.to_string())?;
        self.wal.append(WalOp::CreateTable, &def.name, &data).map_err(|e| e.to_string())?;
        self.tables.insert(def.name.clone(), Table::new(def.name, def.schema));
        Ok(())
    }

    fn has_table(&self, name: &str) -> bool {
        self.tables.contains_key(name)
    }

    fn list_tables(&self) -> Vec<String> {
        self.tables.keys().cloned().collect()
    }

    fn drop_table(&mut self, name: &str) -> Result<(), String> {
        self.tables.remove(name).ok_or_else(|| format!("table '{}' not found", name))?;
        self.wal.append(WalOp::DropTable, name, &[]).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn insert(&mut self, table: &str, fields: Vec<HashMap<String, serde_json::Value>>) -> Result<Vec<u64>, String> {
        let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
        let ids = t.add_rows(fields.clone());
        let data = serde_json::to_vec(&fields).map_err(|e| e.to_string())?;
        self.wal.append(WalOp::Insert, table, &data).map_err(|e| e.to_string())?;
        Ok(ids)
    }

    fn find_by_id(&self, table: &str, id: u64) -> Result<Option<Row>, String> {
        let t = self.tables.get(table).ok_or_else(|| format!("table '{}' not found", table))?;
        Ok(t.get_row(id))
    }

    fn find_by_id_json(&self, table: &str, id: u64) -> Result<Option<String>, String> {
        let t = self.tables.get(table).ok_or_else(|| format!("table '{}' not found", table))?;
        Ok(t.get_row_json(id))
    }

    fn find(&self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>,
            limit: Option<usize>, offset: Option<usize>,
            cursor: Option<String>,
            order_by: &Option<String>, order: &Option<String>) -> Result<(Vec<Row>, Option<String>, bool), String> {
        let t = self.tables.get(table).ok_or_else(|| format!("table '{}' not found", table))?;
        let off = cursor.as_deref().and_then(|c| c.strip_prefix('c')?.parse().ok()).or(offset);
        let off_val = off.unwrap_or(0);
        let probe_limit = limit.map(|l| l + 1);
        let all = t.find_rows(filter, probe_limit, off, order_by, order);
        let has_more = limit.map_or(false, |l| all.len() > l);
        let rows: Vec<Row> = all.into_iter().take(limit.unwrap_or(usize::MAX)).collect();
        let next_cursor = if has_more { Some(format!("c{}", off_val + limit.unwrap())) } else { None };
        Ok((rows, next_cursor, has_more))
    }

    fn count(&self, table: &str) -> Result<usize, String> {
        let t = self.tables.get(table).ok_or_else(|| format!("table '{}' not found", table))?;
        Ok(t.count())
    }

    fn update_by_id(&mut self, table: &str, id: u64, data: HashMap<String, serde_json::Value>) -> Result<bool, String> {
        let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
        let result = t.update_row(id, data.clone());
        if result {
            let payload = serde_json::to_vec(&(id, &data)).map_err(|e| e.to_string())?;
            self.wal.append(WalOp::Update, table, &payload).map_err(|e| e.to_string())?;
        }
        Ok(result)
    }

    fn remove_by_id(&mut self, table: &str, id: u64) -> Result<bool, String> {
        let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
        let result = t.remove_row(id);
        if result {
            let payload = serde_json::to_vec(&id).map_err(|e| e.to_string())?;
            self.wal.append(WalOp::Delete, table, &payload).map_err(|e| e.to_string())?;
        }
        Ok(result)
    }

    fn update_by_filter(&mut self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>,
                        data: HashMap<String, serde_json::Value>) -> Result<usize, String> {
        let t = self.tables.get(table).ok_or_else(|| format!("table '{}' not found", table))?;
        let ids: Vec<u64> = t.rows.iter()
            .filter(|r| filter.as_ref().map_or(true, |f| t.row_matches(r, f)))
            .map(|r| r.id)
            .collect();
        let count = ids.len();
        for id in &ids {
            let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
            t.update_row(*id, data.clone());
            let payload = serde_json::to_vec(&(*id, &data)).map_err(|e| e.to_string())?;
            self.wal.append(WalOp::Update, table, &payload).map_err(|e| e.to_string())?;
        }
        Ok(count)
    }

    fn remove_by_filter(&mut self, table: &str, filter: &Option<HashMap<String, serde_json::Value>>) -> Result<usize, String> {
        let t = self.tables.get(table).ok_or_else(|| format!("table '{}' not found", table))?;
        let ids: Vec<u64> = t.rows.iter()
            .filter(|r| filter.as_ref().map_or(true, |f| t.row_matches(r, f)))
            .map(|r| r.id)
            .collect();
        let count = ids.len();
        for id in &ids {
            let t = self.tables.get_mut(table).ok_or_else(|| format!("table '{}' not found", table))?;
            t.remove_row(*id);
            let payload = serde_json::to_vec(id).map_err(|e| e.to_string())?;
            self.wal.append(WalOp::Delete, table, &payload).map_err(|e| e.to_string())?;
        }
        Ok(count)
    }

    fn begin_tx(&mut self) -> Result<String, String> {
        Err("transactions not supported directly; use TxManager".into())
    }

    fn commit_tx(&mut self, _tx_id: &str) -> Result<(), String> {
        Err("transactions not supported directly; use TxManager".into())
    }

    fn rollback_tx(&mut self, _tx_id: &str) -> Result<(), String> {
        Err("transactions not supported directly; use TxManager".into())
    }
}
