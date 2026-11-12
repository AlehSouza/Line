use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::Path;
use subtle::ConstantTimeEq;

/// Mesmos parâmetros do `crypto.scrypt` do Node (N=16384, r=8, p=1),
/// então senhas criadas pelo servidor antigo continuam funcionando.
fn scrypt_params() -> scrypt::Params {
    scrypt::Params::new(14, 8, 1).expect("parâmetros do scrypt")
}

pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let mut hash = [0u8; 64];
    scrypt::scrypt(password.as_bytes(), &salt, &scrypt_params(), &mut hash).expect("scrypt");
    format!("scrypt${}${}", B64.encode(salt), B64.encode(hash))
}

pub fn verify_password(password: &str, stored: &str) -> bool {
    let mut parts = stored.split('$');
    let (Some("scrypt"), Some(salt), Some(hash)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let (Ok(salt), Ok(expected)) = (B64.decode(salt), B64.decode(hash)) else {
        return false;
    };
    if expected.is_empty() {
        return false;
    }
    let mut actual = vec![0u8; expected.len()];
    if scrypt::scrypt(password.as_bytes(), &salt, &scrypt_params(), &mut actual).is_err() {
        return false;
    }
    actual.ct_eq(&expected).into()
}

/// Usa JWT_SECRET se existir; senão gera um segredo e guarda em DATA_DIR/jwt-secret.
pub fn resolve_jwt_secret(data_dir: &Path, from_env: Option<&str>, persist: bool) -> Vec<u8> {
    if let Some(secret) = from_env.filter(|s| !s.is_empty()) {
        return secret.as_bytes().to_vec();
    }
    if !persist {
        let mut bytes = vec![0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        return bytes;
    }
    let file = data_dir.join("jwt-secret");
    if !file.exists() {
        let mut bytes = [0u8; 48];
        rand::rng().fill_bytes(&mut bytes);
        std::fs::write(&file, B64.encode(bytes)).expect("não consegui gravar o jwt-secret");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
        }
    }
    std::fs::read_to_string(&file)
        .expect("não consegui ler o jwt-secret")
        .trim()
        .as_bytes()
        .to_vec()
}

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String,
    iat: u64,
    exp: u64,
}

/// Tokens de sessão: JWT HS256 válido por 30 dias (igual para REST e WebSocket).
pub struct Tokens {
    encoding: EncodingKey,
    decoding: DecodingKey,
}

impl Tokens {
    pub fn new(secret: &[u8]) -> Self {
        Self {
            encoding: EncodingKey::from_secret(secret),
            decoding: DecodingKey::from_secret(secret),
        }
    }

    pub fn sign(&self, user_id: &str) -> String {
        let iat = jsonwebtoken::get_current_timestamp();
        let claims = Claims {
            sub: user_id.to_string(),
            iat,
            exp: iat + 30 * 24 * 60 * 60,
        };
        jsonwebtoken::encode(&Header::new(Algorithm::HS256), &claims, &self.encoding)
            .expect("assinar token")
    }

    pub fn verify(&self, token: &str) -> Option<String> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 0;
        jsonwebtoken::decode::<Claims>(token, &self.decoding, &validation)
            .ok()
            .map(|d| d.claims.sub)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn senha_confere() {
        let h = hash_password("senha123");
        assert!(verify_password("senha123", &h));
        assert!(!verify_password("errada", &h));
    }

    #[test]
    fn le_hash_gerado_pelo_node() {
        // Gerado com o servidor antigo: crypto.scrypt('senha123', salt, 64)
        let stored = include_str!("../test/fixtures/node-scrypt-hash.txt").trim();
        assert!(verify_password("senha123", stored));
    }

    #[test]
    fn token_ida_e_volta() {
        let t = Tokens::new(b"segredo");
        let tok = t.sign("abc");
        assert_eq!(t.verify(&tok).as_deref(), Some("abc"));
        assert_eq!(Tokens::new(b"outro").verify(&tok), None);
    }
}
