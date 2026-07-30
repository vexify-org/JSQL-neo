use std::collections::HashMap;
use rustc_hash::FxHashMap;
use crate::types::{Row, Schema, FieldType};
use std::fmt::Write;

#[derive(Debug, Clone, PartialEq, Default)]
pub enum FieldValue {
    #[default]
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    String(String),
}

impl FieldValue {
    pub fn from_json(jv: serde_json::Value) -> Self {
        match jv {
            serde_json::Value::Null => FieldValue::Null,
            serde_json::Value::Bool(b) => FieldValue::Bool(b),
            serde_json::Value::Number(n) => {
                n.as_i64().map(FieldValue::Int)
                    .or_else(|| n.as_f64().map(FieldValue::Float))
                    .unwrap_or(FieldValue::Null)
            }
            serde_json::Value::String(s) => FieldValue::String(s),
            _ => FieldValue::Null,
        }
    }

    fn to_json(&self) -> serde_json::Value {
        match self {
            FieldValue::Null => serde_json::Value::Null,
            FieldValue::Bool(b) => serde_json::Value::Bool(*b),
            FieldValue::Int(n) => serde_json::Value::Number((*n).into()),
            FieldValue::Float(f) => serde_json::Number::from_f64(*f)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null),
            FieldValue::String(s) => serde_json::Value::String(s.clone()),
        }
    }

    pub fn write_json(&self, out: &mut String) {
        match self {
            FieldValue::Null => out.push_str("null"),
            FieldValue::Bool(true) => out.push_str("true"),
            FieldValue::Bool(false) => out.push_str("false"),
            FieldValue::Int(n) => {
                out.push_str(itoa::Buffer::new().format(*n));
            }
            FieldValue::Float(f) => {
                out.push_str(ryu::Buffer::new().format_finite(*f));
            }
            FieldValue::String(s) => {
                write_json_string(out, s);
            }
        }
    }

    pub fn eq_json(&self, jv: &serde_json::Value) -> bool {
        match (self, jv) {
            (FieldValue::Null, serde_json::Value::Null) => true,
            (FieldValue::Bool(a), serde_json::Value::Bool(b)) => a == b,
            (FieldValue::Int(a), serde_json::Value::Number(n)) => n.as_i64() == Some(*a),
            (FieldValue::Float(a), serde_json::Value::Number(n)) => n.as_f64() == Some(*a),
            (FieldValue::String(a), serde_json::Value::String(b)) => a == b,
            _ => false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RowStore {
    pub id: u64,
    pub values_start: usize,
    pub num_values: usize,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone)]
pub struct Table {
    pub name: String,
    pub schema: Schema,
    pub field_order: Vec<String>,
    pub field_index: HashMap<String, usize>,
    pub rows: Vec<RowStore>,
    pub values: Vec<FieldValue>,
    pub next_id: u64,
    pub pk_field: Option<String>,
    pub pk_index: FxHashMap<u64, usize>,
}

fn default_value(ft: &FieldType) -> FieldValue {
    match ft {
        FieldType::Integer => FieldValue::Int(0),
        FieldType::Float => FieldValue::Float(0.0),
        FieldType::String => FieldValue::String(String::new()),
        FieldType::Boolean => FieldValue::Bool(false),
    }
}

fn now_millis() -> u64 {
    #[cfg(feature = "wasm")]
    {
        js_sys::Date::now() as u64
    }
    #[cfg(not(feature = "wasm"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}

fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                write!(out, "\\u{:04x}", c as u32).unwrap();
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn millis_to_string(ms: u64) -> String {
    #[cfg(feature = "wasm")]
    {
        let d = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(ms as f64));
        d.to_iso_string().as_string().unwrap_or_else(|| "2026-01-01T00:00:00Z".into())
    }
    #[cfg(not(feature = "wasm"))]
    {
        let secs = ms / 1000;
        let nanos = ((ms % 1000) * 1_000_000) as u32;
        let dt = chrono::DateTime::from_timestamp(secs as i64, nanos)
            .unwrap_or_default();
        dt.to_rfc3339()
    }
}

impl Table {
    pub fn new(name: String, schema: Schema) -> Self {
        let pk_field = schema.iter()
            .find(|(_, f)| f.primary_key)
            .map(|(name, _)| name.clone());

        let mut field_order: Vec<String> = schema.keys().cloned().collect();
        field_order.sort();
        let field_index: HashMap<String, usize> = field_order.iter()
            .enumerate().map(|(i, n)| (n.clone(), i)).collect();

        Self {
            name, schema, field_order, field_index,
            rows: Vec::new(), values: Vec::new(), next_id: 1, pk_field,
            pk_index: FxHashMap::default(),
        }
    }

    pub fn to_row_map(&self, values: &[FieldValue]) -> HashMap<String, serde_json::Value> {
        let mut map = HashMap::with_capacity(self.field_order.len());
        for (i, name) in self.field_order.iter().enumerate() {
            if let Some(v) = values.get(i) {
                map.insert(name.clone(), v.to_json());
            }
        }
        map
    }

    pub fn push_row_values(&mut self, id: u64, values: Vec<FieldValue>, now: u64) {
        let num_values = values.len();
        let values_start = self.values.len();
        self.values.extend(values);
        self.rows.push(RowStore { id, values_start, num_values, created_at: now, updated_at: now });
    }

    pub fn get_row_values(&self, rs: &RowStore) -> &[FieldValue] {
        &self.values[rs.values_start..][..rs.num_values]
    }

    pub fn get_row_values_mut(&mut self, rs: &RowStore) -> &mut [FieldValue] {
        let start = rs.values_start;
        &mut self.values[start..][..rs.num_values]
    }

    fn to_row(&self, rs: &RowStore) -> Row {
        Row {
            id: rs.id,
            fields: self.to_row_map(self.get_row_values(rs)),
            created_at: Some(millis_to_string(rs.created_at)),
            updated_at: Some(millis_to_string(rs.updated_at)),
        }
    }

    pub fn add_rows(&mut self, fields_batch: Vec<HashMap<String, serde_json::Value>>) -> Vec<u64> {
        let now = now_millis();
        let batch_len = fields_batch.len();
        let mut ids = Vec::with_capacity(batch_len);
        self.pk_index.reserve(batch_len);
        self.rows.reserve(batch_len);
        self.values.reserve(batch_len * self.field_order.len());

        let pk_auto_key = self.pk_field.as_deref().and_then(|pk| {
            self.schema.get(pk).and_then(|fs| {
                if fs.auto_increment { Some(pk.to_string()) } else { None }
            })
        });

        for mut fields in fields_batch {
            let id = self.next_id;
            self.next_id += 1;

            if let Some(ref pk_key) = pk_auto_key {
                fields.insert(pk_key.clone(), serde_json::Value::Number(id.into()));
            }

            let values_start = self.values.len();
            if fields.len() < self.schema.len() {
                for (name, fs) in &self.schema {
                    if let Some(v) = fields.remove(name) {
                        self.values.push(FieldValue::from_json(v));
                    } else {
                        self.values.push(default_value(&fs.field_type));
                    }
                }
            } else {
                for name in &self.field_order {
                    self.values.push(fields.remove(name).map(FieldValue::from_json).unwrap_or(FieldValue::Null));
                }
            }

            let idx = self.rows.len();
            self.pk_index.insert(id, idx);
            self.rows.push(RowStore { id, values_start, num_values: self.field_order.len(), created_at: now, updated_at: now });
            ids.push(id);
        }
        ids
    }

    pub fn add_rows_vec(&mut self, field_names: &[String], batch: Vec<Vec<serde_json::Value>>) -> Vec<u64> {
        let batch_fv: Vec<Vec<FieldValue>> = batch.into_iter()
            .map(|row| row.into_iter().map(FieldValue::from_json).collect())
            .collect();
        self.add_rows_vec_fv(field_names, batch_fv)
    }

    pub fn add_rows_vec_fv(&mut self, field_names: &[String], batch: Vec<Vec<FieldValue>>) -> Vec<u64> {
        let now = now_millis();
        let batch_len = batch.len();
        let mut ids = Vec::with_capacity(batch_len);
        self.pk_index.reserve(batch_len);
        self.rows.reserve(batch_len);
        self.values.reserve(batch_len * self.field_order.len());

        let pk_auto_key = self.pk_field.as_deref().and_then(|pk| {
            self.schema.get(pk).and_then(|fs| {
                if fs.auto_increment { Some(pk.to_string()) } else { None }
            })
        });

        // fast path: field_names match field_order
        if field_names.len() == self.field_order.len()
            && field_names.iter().zip(&self.field_order).all(|(a, b)| a == b)
        {
            let pk_idx = pk_auto_key.as_ref().and_then(|pk| self.field_index.get(pk.as_str()).copied());
            for mut row_vals in batch {
                let id = self.next_id;
                self.next_id += 1;
                if row_vals.len() < self.field_order.len() {
                    row_vals.resize(self.field_order.len(), FieldValue::Null);
                }
                if let Some(pi) = pk_idx {
                    if pi < row_vals.len() {
                        row_vals[pi] = FieldValue::Int(id as i64);
                    }
                }
                let values_start = self.values.len();
                self.values.append(&mut row_vals);
                let idx = self.rows.len();
                self.pk_index.insert(id, idx);
                self.rows.push(RowStore { id, values_start, num_values: self.field_order.len(), created_at: now, updated_at: now });
                ids.push(id);
            }
            return ids;
        }

        // slow path: remap field names
        let remap: Vec<Option<usize>> = self.field_order.iter()
            .map(|name| field_names.iter().position(|fname| fname == name))
            .collect();

        for mut row_vals in batch {
            let id = self.next_id;
            self.next_id += 1;
            let values_start = self.values.len();
            for (i, remapped_si) in remap.iter().enumerate() {
                if let Some(si) = *remapped_si {
                    if si < row_vals.len() {
                        self.values.push(std::mem::take(&mut row_vals[si]));
                        continue;
                    }
                }
                if let Some(ref pk_key) = pk_auto_key {
                    if self.field_order[i] == *pk_key {
                        self.values.push(FieldValue::Int(id as i64));
                        continue;
                    }
                }
                if let Some(name) = self.field_order.get(i) {
                    if let Some(fs) = self.schema.get(name) {
                        if let Some(ref default) = fs.default {
                            self.values.push(FieldValue::from_json(default.clone()));
                        } else if !fs.nullable {
                            self.values.push(default_value(&fs.field_type));
                        } else {
                            self.values.push(FieldValue::Null);
                        }
                    } else {
                        self.values.push(FieldValue::Null);
                    }
                }
            }
            let idx = self.rows.len();
            self.pk_index.insert(id, idx);
            self.rows.push(RowStore { id, values_start, num_values: self.field_order.len(), created_at: now, updated_at: now });
            ids.push(id);
        }
        ids
    }

    pub fn row_matches(&self, r: &RowStore, filter: &HashMap<String, serde_json::Value>) -> bool {
        let vals = self.get_row_values(r);
        filter.iter().all(|(k, v)| {
            self.field_index.get(k)
                .and_then(|&pos| vals.get(pos))
                .map_or(false, |fv| fv.eq_json(v))
        })
    }

    pub fn get_row(&self, id: u64) -> Option<Row> {
        let idx = *self.pk_index.get(&id)?;
        self.rows.get(idx).map(|r| self.to_row(r))
    }

    pub fn get_row_json(&self, id: u64) -> Option<String> {
        let idx = *self.pk_index.get(&id)?;
        self.rows.get(idx).map(|r| self.to_row_json_string(r))
    }

    pub fn get_rows_json(&self, ids: &[u64]) -> String {
        let mut out = String::with_capacity(ids.len() * 128);
        out.push('[');
        let mut first = true;
        for &id in ids {
            if let Some(&idx) = self.pk_index.get(&id) {
                if let Some(rs) = self.rows.get(idx) {
                    if !first { out.push(','); }
                    first = false;
                    out.push_str(&self.to_row_json_string(rs));
                }
            }
        }
        out.push(']');
        out
    }

    fn to_row_json_string(&self, rs: &RowStore) -> String {
        let vals = self.get_row_values(rs);
        let mut out = String::with_capacity(128);
        out.push_str(r#"{"id":"#);
        out.push_str(itoa::Buffer::new().format(rs.id));
        out.push_str(r#","fields":{"#);
        for (i, name) in self.field_order.iter().enumerate() {
            if i > 0 { out.push(','); }
            write_json_string(&mut out, name);
            out.push(':');
            if let Some(v) = vals.get(i) {
                v.write_json(&mut out);
            } else {
                out.push_str("null");
            }
        }
        out.push_str("},\"created_at\":");
        write_json_string(&mut out, &millis_to_string(rs.created_at));
        out.push_str(",\"updated_at\":");
        write_json_string(&mut out, &millis_to_string(rs.updated_at));
        out.push('}');
        out
    }

    pub fn update_row(&mut self, id: u64, data: HashMap<String, serde_json::Value>) -> bool {
        let idx = match self.pk_index.get(&id) {
            Some(i) => *i,
            None => return false,
        };
        // Use raw index access to update values without borrow conflicts
        if idx < self.rows.len() {
            let row = &mut self.rows[idx];
            let nv = row.num_values;
            let s = row.values_start;
            for (k, v) in data {
                if let Some(&pos) = self.field_index.get(&k) {
                    if pos < nv {
                        self.values[s + pos] = FieldValue::from_json(v);
                    }
                }
            }
            self.rows[idx].updated_at = now_millis();
            true
        } else {
            false
        }
    }

    pub fn update_rows(&mut self, batch: Vec<(u64, HashMap<String, serde_json::Value>)>) -> usize {
        let mut count = 0;
        let now = now_millis();
        for (id, data) in batch {
            if let Some(&idx) = self.pk_index.get(&id) {
                if idx < self.rows.len() {
                    let row = &mut self.rows[idx];
                    let nv = row.num_values;
                    let s = row.values_start;
                    for (k, v) in data {
                        if let Some(&pos) = self.field_index.get(&k) {
                            if pos < nv {
                                self.values[s + pos] = FieldValue::from_json(v);
                            }
                        }
                    }
                    self.rows[idx].updated_at = now;
                    count += 1;
                }
            }
        }
        count
    }

    pub fn remove_row(&mut self, id: u64) -> bool {
        let idx = match self.pk_index.get(&id) {
            Some(i) => *i,
            None => return false,
        };
        self.pk_index.remove(&id);
        let last = self.rows.len() - 1;
        if idx != last {
            self.pk_index.insert(self.rows[last].id, idx);
        }
        self.rows.swap_remove(idx);
        true
    }

    pub fn remove_rows(&mut self, ids: &[u64]) -> usize {
        let mut count = 0;
        let mut indices: Vec<(usize, u64)> = Vec::with_capacity(ids.len());
        for &id in ids {
            if let Some(&idx) = self.pk_index.get(&id) {
                indices.push((idx, id));
                count += 1;
            }
        }
        indices.sort_unstable_by(|a, b| b.0.cmp(&a.0));
        for (idx, id) in indices {
            self.pk_index.remove(&id);
            let last = self.rows.len() - 1;
            if idx != last {
                self.pk_index.insert(self.rows[last].id, idx);
            }
            self.rows.swap_remove(idx);
        }
        count
    }

    pub fn remove_row_by_idx(&mut self, idx: usize) {
        let last = self.rows.len() - 1;
        if idx < last {
            let swapped_id = self.rows[last].id;
            self.pk_index.insert(swapped_id, idx);
        }
        self.pk_index.remove(&self.rows[idx].id);
        self.rows.swap_remove(idx);
    }

    pub fn count(&self) -> usize {
        self.rows.len()
    }

    pub fn find_rows(&self, filter: &Option<HashMap<String, serde_json::Value>>,
                     limit: Option<usize>, offset: Option<usize>,
                     order_by: &Option<String>, order: &Option<String>) -> Vec<Row> {
        let mut results: Vec<&RowStore> = self.rows.iter().collect();

        if let Some(ref f) = filter {
            let filter_indices: Vec<(usize, &serde_json::Value)> = f.iter()
                .filter_map(|(k, v)| self.field_index.get(k).map(|&pos| (pos, v)))
                .collect();
            results.retain(|r| {
                let vals = self.get_row_values(r);
                filter_indices.iter().all(|(pos, v)| {
                    vals.get(*pos).map_or(false, |fv| fv.eq_json(v))
                })
            });
        }

        if let Some(ref field) = order_by {
            let desc = order.as_deref() == Some("desc");
            if let Some(&pos) = self.field_index.get(field) {
                results.sort_by(|a, b| {
                    let vals_a = self.get_row_values(a);
                    let vals_b = self.get_row_values(b);
                    let cmp = cmp_field_values(vals_a.get(pos), vals_b.get(pos));
                    if desc { cmp.reverse() } else { cmp }
                });
            }
        }

        let o = offset.unwrap_or(0);
        let l = limit.unwrap_or(usize::MAX);
        results.into_iter().skip(o).take(l).map(|r| self.to_row(r)).collect()
    }
}

fn cmp_field_values(a: Option<&FieldValue>, b: Option<&FieldValue>) -> std::cmp::Ordering {
    match (a, b) {
        (Some(FieldValue::Int(na)), Some(FieldValue::Int(nb))) => na.cmp(nb),
        (Some(FieldValue::Float(na)), Some(FieldValue::Float(nb))) => na.partial_cmp(nb).unwrap_or(std::cmp::Ordering::Equal),
        (Some(FieldValue::String(sa)), Some(FieldValue::String(sb))) => sa.cmp(sb),
        (Some(FieldValue::Bool(ba)), Some(FieldValue::Bool(bb))) => ba.cmp(bb),
        (Some(a), Some(b)) => format!("{:?}", a).cmp(&format!("{:?}", b)),
        (Some(_), None) => std::cmp::Ordering::Greater,
        (None, Some(_)) => std::cmp::Ordering::Less,
        (None, None) => std::cmp::Ordering::Equal,
    }
}
