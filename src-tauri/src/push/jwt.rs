//! APNs provider tokens: an ES256 JWT signed with the team's `.p8` key.
//!
//! Apple's token-based auth: header `{"alg":"ES256","kid":<key id>}`, claims
//! `{"iss":<team id>,"iat":<unix seconds>}`, signed with the P-256 key from
//! App Store Connect. A token is good for an hour, and Apple rejects tokens
//! refreshed more often than every 20 minutes, so one is minted and reused
//! for [`TOKEN_TTL`].

use std::time::{Duration, Instant};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use sha2::{Digest, Sha256};

/// How long a minted token is reused (Apple: valid for 60 min, refresh no
/// more often than every 20).
pub const TOKEN_TTL: Duration = Duration::from_secs(50 * 60);

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum KeyError {
    #[error("the APNs key is empty")]
    Empty,
    #[error("the APNs key is not a PEM/base64 .p8 file")]
    NotBase64,
    #[error("the APNs key is not a P-256 private key in PKCS#8 form (the .p8 file from App Store Connect)")]
    NotP256,
    #[error("signing the APNs token failed")]
    Sign,
}

/// The `.p8` key, parsed.
pub struct SigningKey {
    pair: EcdsaKeyPair,
}

impl SigningKey {
    /// Parse the contents of an `AuthKey_<KEYID>.p8` file (PEM, or its bare
    /// base64 body).
    pub fn from_p8(pem: &str) -> Result<Self, KeyError> {
        let der = pem_to_der(pem)?;
        let pair =
            EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &der, &SystemRandom::new())
                .map_err(|_| KeyError::NotP256)?;
        Ok(Self { pair })
    }

    #[cfg(test)]
    pub fn public_key(&self) -> Vec<u8> {
        use ring::signature::KeyPair;
        self.pair.public_key().as_ref().to_vec()
    }
}

/// The DER bytes inside a PEM block (or a bare base64 body).
pub fn pem_to_der(pem: &str) -> Result<Vec<u8>, KeyError> {
    let body: String = pem
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("-----"))
        .collect::<Vec<_>>()
        .concat();
    if body.is_empty() {
        return Err(KeyError::Empty);
    }
    STANDARD.decode(body).map_err(|_| KeyError::NotBase64)
}

/// Mint a provider token issued at `issued_at` (unix seconds).
pub fn provider_token(
    key: &SigningKey,
    team_id: &str,
    key_id: &str,
    issued_at: i64,
) -> Result<String, KeyError> {
    let header = serde_json::json!({ "alg": "ES256", "kid": key_id });
    let claims = serde_json::json!({ "iss": team_id, "iat": issued_at });
    let encode = |value: &serde_json::Value| URL_SAFE_NO_PAD.encode(value.to_string().as_bytes());
    let signing_input = format!("{}.{}", encode(&header), encode(&claims));
    let signature = key
        .pair
        .sign(&SystemRandom::new(), signing_input.as_bytes())
        .map_err(|_| KeyError::Sign)?;
    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.as_ref())
    ))
}

/// The one token in use, and which credentials minted it.
#[derive(Default)]
pub struct TokenCache {
    entry: Option<CachedToken>,
}

struct CachedToken {
    fingerprint: [u8; 32],
    token: String,
    minted: Instant,
}

fn fingerprint(team_id: &str, key_id: &str, pem: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in [team_id, key_id, pem] {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    hasher.finalize().into()
}

impl TokenCache {
    /// The cached token for these credentials, or a fresh one when there is
    /// none, it is older than [`TOKEN_TTL`], or the credentials changed.
    pub fn get_or_mint(
        &mut self,
        team_id: &str,
        key_id: &str,
        pem: &str,
        now: Instant,
        unix_now: i64,
    ) -> Result<String, KeyError> {
        let fp = fingerprint(team_id, key_id, pem);
        if let Some(entry) = &self.entry {
            if entry.fingerprint == fp && now.saturating_duration_since(entry.minted) < TOKEN_TTL {
                return Ok(entry.token.clone());
            }
        }
        let key = SigningKey::from_p8(pem)?;
        let token = provider_token(&key, team_id, key_id, unix_now)?;
        self.entry = Some(CachedToken {
            fingerprint: fp,
            token: token.clone(),
            minted: now,
        });
        Ok(token)
    }

    /// Forget the token (Apple rejected it, or the settings changed).
    pub fn invalidate(&mut self) {
        self.entry = None;
    }
}

#[cfg(test)]
pub(crate) mod test_key {
    use super::*;

    /// A fresh P-256 key in the `.p8` PEM form App Store Connect hands out.
    pub fn p8_pem() -> String {
        let doc =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
                .expect("generate");
        let body = STANDARD.encode(doc.as_ref());
        let lines: Vec<&str> = body
            .as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect();
        format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            lines.join("\n")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};

    fn decode_part(part: &str) -> serde_json::Value {
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).unwrap()).unwrap()
    }

    #[test]
    fn the_token_is_an_es256_jwt_apple_can_verify() {
        let pem = test_key::p8_pem();
        let key = SigningKey::from_p8(&pem).unwrap();
        let token = provider_token(&key, "TEAM123456", "KEY1234567", 1_700_000_000).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(
            decode_part(parts[0]),
            serde_json::json!({ "alg": "ES256", "kid": "KEY1234567" })
        );
        assert_eq!(
            decode_part(parts[1]),
            serde_json::json!({ "iss": "TEAM123456", "iat": 1_700_000_000 })
        );
        let signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        assert_eq!(signature.len(), 64, "ES256 is the fixed r||s form");
        let input = format!("{}.{}", parts[0], parts[1]);
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, key.public_key())
            .verify(input.as_bytes(), &signature)
            .expect("signature verifies with the key's public half");
    }

    #[test]
    fn a_bare_base64_body_parses_too() {
        let pem = test_key::p8_pem();
        let body: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
        assert!(SigningKey::from_p8(&body).is_ok());
    }

    #[test]
    fn bad_keys_say_why() {
        assert_eq!(SigningKey::from_p8("").err(), Some(KeyError::Empty));
        assert_eq!(
            SigningKey::from_p8("-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----")
                .err(),
            Some(KeyError::NotBase64)
        );
        assert_eq!(
            SigningKey::from_p8("aGVsbG8gd29ybGQ=").err(),
            Some(KeyError::NotP256)
        );
    }

    #[test]
    fn the_cache_reuses_a_token_until_it_ages_or_the_credentials_change() {
        let pem = test_key::p8_pem();
        let mut cache = TokenCache::default();
        let t0 = Instant::now();
        let first = cache.get_or_mint("T", "K", &pem, t0, 1000).unwrap();
        let again = cache
            .get_or_mint("T", "K", &pem, t0 + Duration::from_secs(60), 1060)
            .unwrap();
        assert_eq!(first, again);
        let other_key = cache
            .get_or_mint("T", "K2", &pem, t0 + Duration::from_secs(61), 1061)
            .unwrap();
        assert_ne!(first, other_key);
        let aged = cache
            .get_or_mint(
                "T",
                "K2",
                &pem,
                t0 + Duration::from_secs(61) + TOKEN_TTL,
                4061,
            )
            .unwrap();
        assert_ne!(other_key, aged);
        cache.invalidate();
        let fresh = cache
            .get_or_mint(
                "T",
                "K2",
                &pem,
                t0 + Duration::from_secs(62) + TOKEN_TTL,
                4062,
            )
            .unwrap();
        assert_ne!(
            aged, fresh,
            "ECDSA signatures are randomized, so a new mint differs"
        );
    }
}
