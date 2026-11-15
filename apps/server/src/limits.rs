//! Limites contra abuso de recursos (memória, disco) por usuário.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Soma de bytes por chave numa janela móvel (ex.: quanto cada usuário enviou nas últimas 24 h).
pub struct ByteQuota {
    map: Mutex<HashMap<String, Vec<(Instant, u64)>>>,
    pub max: u64,
    window: Duration,
}

impl ByteQuota {
    pub fn new(max: u64, window: Duration) -> Self {
        Self { map: Mutex::default(), max, window }
    }

    /// Quanto `key` já usou dentro da janela.
    pub fn used(&self, key: &str) -> u64 {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let window = self.window;
        map.retain(|_, v| {
            v.retain(|(t, _)| now.duration_since(*t) < window);
            !v.is_empty()
        });
        map.get(key).map(|v| v.iter().map(|(_, n)| n).sum()).unwrap_or(0)
    }

    pub fn add(&self, key: &str, bytes: u64) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(key.to_string()).or_default().push((Instant::now(), bytes));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn soma_por_chave() {
        let q = ByteQuota::new(100, Duration::from_secs(60));
        q.add("a", 40);
        q.add("a", 30);
        q.add("b", 5);
        assert_eq!(q.used("a"), 70);
        assert_eq!(q.used("b"), 5);
        assert_eq!(q.used("c"), 0);
    }
}
