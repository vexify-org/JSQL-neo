//! 预写日志（WAL）。
//!
//! 记录格式：`[len: u64 LE][crc32: u32 LE][bincode(WalEntry)]`，头部与载荷一次性写出，
//! 每条记录带 CRC 校验。重放时遇到截断或校验失败的记录即停止，把它视为「未完整落盘」，
//! 这样即使进程在写一半时被杀，也不会把半截数据当成有效记录。

use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom, Write};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum WalOp {
    CreateTable = 0,
    DropTable = 1,
    Insert = 2,
    Update = 3,
    Remove = 4,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalEntry {
    pub tx_id: u64,
    pub op: WalOp,
    pub data: Vec<u8>,
}

/// 记录头长度：len(u64) + crc32(u32)
const HEADER_LEN: usize = 12;
/// 单条载荷上限，避免损坏的长度字段触发超大内存分配
const MAX_PAYLOAD: usize = 64 * 1024 * 1024;

fn io_err<E: std::fmt::Display>(e: E) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
}

/// 顺序重放，回调所有 `tx_id > after_tx` 的完整记录。
/// 返回成功解析的字节数（尾部残缺部分不计入）。
fn replay<R: Read>(reader: &mut R, after_tx: u64, mut on_entry: impl FnMut(WalEntry)) -> std::io::Result<u64> {
    let mut valid = 0u64;
    let mut header = [0u8; HEADER_LEN];
    loop {
        if reader.read_exact(&mut header).is_err() {
            break;
        }
        let len = u64::from_le_bytes(header[..8].try_into().unwrap()) as usize;
        let crc = u32::from_le_bytes(header[8..].try_into().unwrap());
        if len == 0 || len > MAX_PAYLOAD {
            break;
        }
        let mut body = vec![0u8; len];
        if reader.read_exact(&mut body).is_err() {
            break;
        }
        if crc32fast::hash(&body) != crc {
            break;
        }
        match bincode::deserialize::<WalEntry>(&body) {
            Ok(entry) => {
                valid += (HEADER_LEN + len) as u64;
                if entry.tx_id > after_tx {
                    on_entry(entry);
                }
            }
            Err(_) => break,
        }
    }
    Ok(valid)
}

pub struct WalWriter {
    file: std::fs::File,
    next_tx: u64,
    pending: u32,
    sync_interval: u32,
    buf: Vec<u8>,
}

impl WalWriter {
    pub fn open(path: &str) -> std::io::Result<Self> {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(path)?;
        // 从已有文件恢复 next_tx：否则重启后 tx_id 会从 1 重新开始，
        // 与历史记录撞号，`replay_after` 的增量语义就废了。
        let mut max_tx = 0u64;
        replay(&mut file, 0, |e| {
            if e.tx_id > max_tx {
                max_tx = e.tx_id;
            }
        })?;
        file.seek(SeekFrom::End(0))?;
        Ok(Self {
            file,
            next_tx: max_tx + 1,
            pending: 0,
            sync_interval: 1,
            buf: Vec::with_capacity(256),
        })
    }

    /// 每写多少条记录 fsync 一次。1 = 每条都落盘（默认，最安全）；调大换取吞吐。
    pub fn set_sync_interval(&mut self, n: u32) {
        self.sync_interval = n.max(1);
    }

    pub fn next_tx(&self) -> u64 {
        self.next_tx
    }

    pub fn append(&mut self, op: WalOp, data: Vec<u8>) -> std::io::Result<u64> {
        let tx_id = self.next_tx;
        let body = bincode::serialize(&WalEntry { tx_id, op, data }).map_err(io_err)?;
        if body.len() > MAX_PAYLOAD {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "wal record too large",
            ));
        }
        // 头 + 载荷一次 write_all，避免两次写之间被打断留下半截头部
        self.buf.clear();
        self.buf.extend_from_slice(&(body.len() as u64).to_le_bytes());
        self.buf.extend_from_slice(&crc32fast::hash(&body).to_le_bytes());
        self.buf.extend_from_slice(&body);
        self.file.write_all(&self.buf)?;

        self.next_tx += 1;
        self.pending += 1;
        if self.pending >= self.sync_interval {
            self.sync()?;
        }
        Ok(tx_id)
    }

    /// 真正落盘。`File::flush` 是空操作，WAL 必须走 `sync_data` 才算持久化。
    pub fn sync(&mut self) -> std::io::Result<()> {
        self.file.sync_data()?;
        self.pending = 0;
        Ok(())
    }

    /// `sync` 的别名
    pub fn flush(&mut self) -> std::io::Result<()> {
        self.sync()
    }

    /// 清空日志（快照落盘后调用），避免 WAL 无限增长
    pub fn truncate(&mut self) -> std::io::Result<()> {
        self.file.set_len(0)?;
        self.file.seek(SeekFrom::Start(0))?;
        self.file.sync_data()?;
        self.pending = 0;
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

    /// 增量重放：只返回 `tx_id > after_tx` 的记录。
    pub fn replay_after(&self, after_tx: u64) -> std::io::Result<Vec<WalEntry>> {
        let file = match std::fs::File::open(&self.path) {
            Ok(f) => f,
            Err(_) => return Ok(Vec::new()),
        };
        let mut reader = std::io::BufReader::new(file);
        let mut entries = Vec::new();
        replay(&mut reader, after_tx, |e| entries.push(e))?;
        Ok(entries)
    }

    /// 重放全部记录
    pub fn replay_all(&self) -> std::io::Result<Vec<WalEntry>> {
        self.replay_after(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(tag: &str) -> String {
        let mut p = std::env::temp_dir();
        p.push(format!("jsql-wal-{}-{}.log", tag, std::process::id()));
        let s = p.to_string_lossy().to_string();
        let _ = std::fs::remove_file(&s);
        s
    }

    #[test]
    fn append_replay_roundtrip() {
        let path = tmp_path("rt");
        {
            let mut w = WalWriter::open(&path).unwrap();
            for i in 0..5u8 {
                assert_eq!(w.append(WalOp::Insert, vec![i]).unwrap(), i as u64 + 1);
            }
            w.sync().unwrap();
        }
        let entries = WalReader::open(&path).replay_all().unwrap();
        assert_eq!(entries.len(), 5);
        assert_eq!(entries[3].tx_id, 4);
        assert_eq!(entries[3].op, WalOp::Insert);
        assert_eq!(entries[3].data, vec![3u8]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn replay_after_is_incremental() {
        let path = tmp_path("inc");
        {
            let mut w = WalWriter::open(&path).unwrap();
            for i in 0..5u8 {
                w.append(WalOp::Update, vec![i]).unwrap();
            }
            w.sync().unwrap();
        }
        let tail = WalReader::open(&path).replay_after(3).unwrap();
        assert_eq!(tail.len(), 2);
        assert!(tail.iter().all(|e| e.tx_id > 3));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn next_tx_is_recovered_after_reopen() {
        let path = tmp_path("recover");
        {
            let mut w = WalWriter::open(&path).unwrap();
            w.append(WalOp::Insert, vec![1]).unwrap();
            w.append(WalOp::Insert, vec![2]).unwrap();
            w.sync().unwrap();
        }
        let mut w = WalWriter::open(&path).unwrap();
        assert_eq!(w.next_tx(), 3, "tx_id 必须接着历史最大值，不能回退到 1");
        assert_eq!(w.append(WalOp::Remove, vec![3]).unwrap(), 3);
        assert_eq!(WalReader::open(&path).replay_all().unwrap().len(), 3);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn truncated_tail_is_dropped() {
        let path = tmp_path("torn");
        {
            let mut w = WalWriter::open(&path).unwrap();
            w.append(WalOp::Insert, vec![7]).unwrap();
            w.append(WalOp::Insert, vec![8]).unwrap();
            w.sync().unwrap();
        }
        // 模拟写一半被杀：尾部只剩半截垃圾
        {
            use std::io::Write as _;
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(&[9u8, 9, 9]).unwrap();
            f.sync_all().unwrap();
        }
        assert_eq!(WalReader::open(&path).replay_all().unwrap().len(), 2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn crc_mismatch_stops_replay() {
        let path = tmp_path("crc");
        {
            let mut w = WalWriter::open(&path).unwrap();
            w.append(WalOp::Insert, vec![1]).unwrap();
            w.append(WalOp::Insert, vec![2]).unwrap();
            w.sync().unwrap();
        }
        let len = std::fs::metadata(&path).unwrap().len();
        {
            use std::io::{Seek, SeekFrom, Write as _};
            let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            f.seek(SeekFrom::Start(len - 1)).unwrap();
            f.write_all(&[0xFF]).unwrap();
            f.sync_all().unwrap();
        }
        assert_eq!(WalReader::open(&path).replay_all().unwrap().len(), 1, "校验失败记录应丢弃");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn truncate_resets_log_but_keeps_tx_monotonic() {
        let path = tmp_path("trunc");
        let mut w = WalWriter::open(&path).unwrap();
        w.append(WalOp::Insert, vec![1]).unwrap();
        w.truncate().unwrap();
        assert_eq!(WalReader::open(&path).replay_all().unwrap().len(), 0);
        // tx_id 不能回落：否则消费方持有的水位线（replay_after(T)）会看不到新记录
        assert_eq!(w.append(WalOp::DropTable, vec![]).unwrap(), 2);
        let _ = std::fs::remove_file(&path);
    }
}