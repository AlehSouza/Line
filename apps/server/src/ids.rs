use rand::{Rng, RngCore};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static LAST: Mutex<(u64, u64)> = Mutex::new((0, 0));

fn base36(mut n: u64, width: usize) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    while out.len() < width {
        out.push(b'0');
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// IDs ordenáveis por tempo (timestamp + sequência + aleatório), em base36.
/// Ordem lexicográfica = ordem de criação, o que facilita paginar mensagens.
/// Mesmo formato do servidor antigo em Node, então bancos existentes continuam valendo.
pub fn new_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let seq = {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if now <= last.0 {
            last.1 += 1;
        } else {
            *last = (now, 0);
        }
        last.1
    };
    let mut rand = [0u8; 4];
    rand::rng().fill_bytes(&mut rand);
    let hex: String = rand.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}{}{}", base36(now, 9), base36(seq, 3), hex)
}

const INVITE_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub fn new_invite_code() -> String {
    let mut rng = rand::rng();
    (0..8)
        .map(|_| INVITE_ALPHABET[rng.random_range(0..INVITE_ALPHABET.len())] as char)
        .collect()
}

const PALETTE: [&str; 8] = [
    "#7c6af2", "#f5b700", "#2b6cff", "#e5484d", "#8e4ec6", "#12a594", "#f76b15", "#d6409f",
];

pub fn random_color() -> String {
    PALETTE[rand::rng().random_range(0..PALETTE.len())].to_string()
}

/// Data no mesmo formato do `toISOString()` do JavaScript.
pub fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_crescem_em_ordem() {
        let ids: Vec<String> = (0..1000).map(|_| new_id()).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);
        assert_eq!(ids[0].len(), 20);
    }

    #[test]
    fn base36_igual_ao_js() {
        // (1700000000000).toString(36) === "loyw3v28"
        assert_eq!(base36(1_700_000_000_000, 9), "0loyw3v28");
    }
}
