use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WalOp {
    CreateTable,
    DropTable,
    Insert,
    Update,
    Remove,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalEntry {
    pub tx_id: u64,
    pub op: WalOp,
    pub data: Vec<u8>,
}

pub struct WalWriter {
    path: String,
    file: Option<std::fs::File>,
    next_tx: u64,
}

impl WalWriter {
    pub fn open(path: &str) -> std::io::Result<Self> {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        Ok(Self { path: path.to_string(), file: Some(file), next_tx: 1 })
    }

    #[allow(dead_code)]
    pub fn append(&mut self, op: WalOp, data: Vec<u8>) -> std::io::Result<u64> {
        let tx_id = self.next_tx;
        self.next_tx += 1;
        let entry = WalEntry { tx_id, op, data };
        let buf = bincode::serialize(&entry).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        if let Some(ref mut file) = self.file {
            let len = buf.len() as u64;
            file.write_all(&len.to_le_bytes())?;
            file.write_all(&buf)?;
            file.flush()?;
        }
        Ok(tx_id)
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        if let Some(ref mut file) = self.file {
            file.flush()?;
        }
        Ok(())
    }
}

pub struct WalReader {
    path: String,
}

impl WalReader {
    pub fn open(path: &str) -> Self {
        Self { path: path.to_string() }
    }

    pub fn replay_after(&self, _after_tx: u64) -> std::io::Result<Vec<WalEntry>> {
        let file = match std::fs::File::open(&self.path) {
            Ok(f) => f,
            Err(_) => return Ok(Vec::new()),
        };
        let mut reader = std::io::BufReader::new(file);
        let mut entries = Vec::new();
        loop {
            let mut len_buf = [0u8; 8];
            if reader.read_exact(&mut len_buf).is_err() { break; }
            let len = u64::from_le_bytes(len_buf) as usize;
            let mut buf = vec![0u8; len];
            if reader.read_exact(&mut buf).is_err() { break; }
            if let Ok(entry) = bincode::deserialize::<WalEntry>(&buf) {
                entries.push(entry);
            }
        }
        Ok(entries)
    }
}