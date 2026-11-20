#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, Symbol, Vec,
};

/// Default maximum allowable age of price feeds (5 minutes = 300 seconds).
pub const DEFAULT_MAX_STALENESS_SECONDS: u64 = 300;

/// Permitted clock drift tolerance for timestamps slightly in the future (60 seconds).
pub const MAX_FUTURE_DRIFT_SECONDS: u64 = 60;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    /// Caller is not the authorized contract administrator.
    NotAdmin = 1,
    /// Contract is already initialized.
    AlreadyInitialized = 2,
    /// Contract is not initialized.
    NotInitialized = 3,
    /// Signer is not an authorized oracle feed signer.
    UnauthorizedSigner = 4,
    /// Price feed is stale (exceeds heartbeat/staleness threshold).
    PriceStale = 5,
    /// Provided timestamp is invalid (in the future or older than existing feed round).
    InvalidTimestamp = 6,
    /// Rate must be positive and non-zero.
    InvalidRate = 7,
    /// Price feed not found for the requested base/quote pair.
    RateNotFound = 8,
    /// Cryptographic signature verification failed.
    InvalidSignature = 9,
    /// Staleness threshold must be greater than zero.
    InvalidStalenessThreshold = 10,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    MaxStalenessSeconds,
    FeedSigner(Address),
    PubkeySigner(BytesN<32>),
    Rate(Symbol, Symbol),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateData {
    pub rate: i128,
    pub decimals: u32,
    pub timestamp: u64,
    pub round: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateUpdate {
    pub base: Symbol,
    pub quote: Symbol,
    pub rate: i128,
    pub decimals: u32,
    pub timestamp: u64,
}

#[contractclient(name = "RateOracleClient")]
pub trait RateOracleTrait {
    /// Initialize Oracle with an admin and configurable maximum staleness threshold in seconds.
    fn init(env: Env, admin: Address, max_staleness_seconds: u64) -> Result<(), OracleError>;

    /// Retrieve the current administrator address.
    fn get_admin(env: Env) -> Result<Address, OracleError>;

    /// Transfer administrative authority (admin only).
    fn set_admin(env: Env, current_admin: Address, new_admin: Address) -> Result<(), OracleError>;

    /// Get the active maximum staleness threshold in seconds.
    fn get_max_staleness(env: Env) -> u64;

    /// Update the maximum staleness threshold in seconds (admin only).
    fn set_max_staleness(env: Env, admin: Address, max_staleness_seconds: u64) -> Result<(), OracleError>;

    /// Authorize a new feed signer address (admin only).
    fn add_feed_signer(env: Env, admin: Address, signer: Address) -> Result<(), OracleError>;

    /// Revoke an existing feed signer address (admin only).
    fn remove_feed_signer(env: Env, admin: Address, signer: Address) -> Result<(), OracleError>;

    /// Check if an address is an authorized feed signer.
    fn is_feed_signer(env: Env, signer: Address) -> bool;

    /// Authorize an Ed25519 public key as an off-chain feed signer (admin only).
    fn add_pubkey_signer(env: Env, admin: Address, pubkey: BytesN<32>) -> Result<(), OracleError>;

    /// Revoke an Ed25519 public key signer (admin only).
    fn remove_pubkey_signer(env: Env, admin: Address, pubkey: BytesN<32>) -> Result<(), OracleError>;

    /// Check if an Ed25519 public key is an authorized signer.
    fn is_pubkey_signer(env: Env, pubkey: BytesN<32>) -> bool;

    /// Update an exchange rate for a corridor (e.g. NGN/XLM, GHS/USDC).
    /// Requires signer.require_auth() and verifies signer authorization.
    /// Disallows stale or backwards-moving timestamps.
    fn set_rate(
        env: Env,
        signer: Address,
        base: Symbol,
        quote: Symbol,
        rate: i128,
        decimals: u32,
        timestamp: u64,
    ) -> Result<(), OracleError>;

    /// Batch update multiple exchange rates in one transaction.
    fn set_rates(
        env: Env,
        signer: Address,
        updates: Vec<RateUpdate>,
    ) -> Result<(), OracleError>;

    /// Update rate with an off-chain Ed25519 signature over serialized payload bytes.
    fn set_rate_signed(
        env: Env,
        pubkey: BytesN<32>,
        base: Symbol,
        quote: Symbol,
        rate: i128,
        decimals: u32,
        timestamp: u64,
        signature: BytesN<64>,
    ) -> Result<(), OracleError>;

    /// Retrieve the current rate for a corridor pair.
    /// Rejects stale prices older than the configured heartbeat threshold.
    fn get_rate(env: Env, base: Symbol, quote: Symbol) -> Result<i128, OracleError>;

    /// Retrieve full rate metadata (rate, decimals, timestamp, round).
    /// Rejects stale prices older than the configured heartbeat threshold.
    fn get_rate_data(env: Env, base: Symbol, quote: Symbol) -> Result<RateData, OracleError>;

    /// Retrieve full rate metadata without staleness enforcement (useful for historical review).
    fn get_rate_data_unchecked(env: Env, base: Symbol, quote: Symbol) -> Result<RateData, OracleError>;
}

#[contract]
pub struct RateOracle;

#[contractimpl]
impl RateOracleTrait for RateOracle {
    fn init(env: Env, admin: Address, max_staleness_seconds: u64) -> Result<(), OracleError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(OracleError::AlreadyInitialized);
        }
        if max_staleness_seconds == 0 {
            return Err(OracleError::InvalidStalenessThreshold);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::MaxStalenessSeconds, &max_staleness_seconds);

        env.events().publish(
            (symbol_short!("init"), admin.clone()),
            max_staleness_seconds,
        );

        Ok(())
    }

    fn get_admin(env: Env) -> Result<Address, OracleError> {
        env.storage()
            .instance()
            .get::<_, Address>(&DataKey::Admin)
            .ok_or(OracleError::NotInitialized)
    }

    fn set_admin(env: Env, current_admin: Address, new_admin: Address) -> Result<(), OracleError> {
        current_admin.require_auth();
        let admin = Self::get_admin(env.clone())?;
        if admin != current_admin {
            return Err(OracleError::NotAdmin);
        }

        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events().publish(
            (symbol_short!("set_adm"), current_admin),
            new_admin,
        );
        Ok(())
    }

    fn get_max_staleness(env: Env) -> u64 {
        env.storage()
            .instance()
            .get::<_, u64>(&DataKey::MaxStalenessSeconds)
            .unwrap_or(DEFAULT_MAX_STALENESS_SECONDS)
    }

    fn set_max_staleness(
        env: Env,
        admin: Address,
        max_staleness_seconds: u64,
    ) -> Result<(), OracleError> {
        admin.require_auth();
        let active_admin = Self::get_admin(env.clone())?;
        if active_admin != admin {
            return Err(OracleError::NotAdmin);
        }
        if max_staleness_seconds == 0 {
            return Err(OracleError::InvalidStalenessThreshold);
        }

        env.storage()
            .instance()
            .set(&DataKey::MaxStalenessSeconds, &max_staleness_seconds);

        env.events().publish(
            (symbol_short!("cfg_stale"), admin),
            max_staleness_seconds,
        );
        Ok(())
    }

    fn add_feed_signer(env: Env, admin: Address, signer: Address) -> Result<(), OracleError> {
        admin.require_auth();
        let active_admin = Self::get_admin(env.clone())?;
        if active_admin != admin {
            return Err(OracleError::NotAdmin);
        }

        env.storage()
            .instance()
            .set(&DataKey::FeedSigner(signer.clone()), &true);

        env.events().publish(
            (symbol_short!("add_sgn"), admin),
            signer,
        );
        Ok(())
    }

    fn remove_feed_signer(env: Env, admin: Address, signer: Address) -> Result<(), OracleError> {
        admin.require_auth();
        let active_admin = Self::get_admin(env.clone())?;
        if active_admin != admin {
            return Err(OracleError::NotAdmin);
        }

        env.storage()
            .instance()
            .remove(&DataKey::FeedSigner(signer.clone()));

        env.events().publish(
            (symbol_short!("rem_sgn"), admin),
            signer,
        );
        Ok(())
    }

    fn is_feed_signer(env: Env, signer: Address) -> bool {
        env.storage()
            .instance()
            .get::<_, bool>(&DataKey::FeedSigner(signer))
            .unwrap_or(false)
    }

    fn add_pubkey_signer(env: Env, admin: Address, pubkey: BytesN<32>) -> Result<(), OracleError> {
        admin.require_auth();
        let active_admin = Self::get_admin(env.clone())?;
        if active_admin != admin {
            return Err(OracleError::NotAdmin);
        }

        env.storage()
            .instance()
            .set(&DataKey::PubkeySigner(pubkey.clone()), &true);

        env.events().publish(
            (symbol_short!("add_pk"), admin),
            pubkey,
        );
        Ok(())
    }

    fn remove_pubkey_signer(env: Env, admin: Address, pubkey: BytesN<32>) -> Result<(), OracleError> {
        admin.require_auth();
        let active_admin = Self::get_admin(env.clone())?;
        if active_admin != admin {
            return Err(OracleError::NotAdmin);
        }

        env.storage()
            .instance()
            .remove(&DataKey::PubkeySigner(pubkey.clone()));

        env.events().publish(
            (symbol_short!("rem_pk"), admin),
            pubkey,
        );
        Ok(())
    }

    fn is_pubkey_signer(env: Env, pubkey: BytesN<32>) -> bool {
        env.storage()
            .instance()
            .get::<_, bool>(&DataKey::PubkeySigner(pubkey))
            .unwrap_or(false)
    }

    fn set_rate(
        env: Env,
        signer: Address,
        base: Symbol,
        quote: Symbol,
        rate: i128,
        decimals: u32,
        timestamp: u64,
    ) -> Result<(), OracleError> {
        signer.require_auth();
        if !Self::is_feed_signer(env.clone(), signer.clone()) {
            return Err(OracleError::UnauthorizedSigner);
        }

        Self::apply_rate_update(&env, base, quote, rate, decimals, timestamp)
    }

    fn set_rates(
        env: Env,
        signer: Address,
        updates: Vec<RateUpdate>,
    ) -> Result<(), OracleError> {
        signer.require_auth();
        if !Self::is_feed_signer(env.clone(), signer.clone()) {
            return Err(OracleError::UnauthorizedSigner);
        }

        for i in 0..updates.len() {
            let u = updates.get(i).unwrap();
            Self::apply_rate_update(&env, u.base, u.quote, u.rate, u.decimals, u.timestamp)?;
        }

        Ok(())
    }

    fn set_rate_signed(
        env: Env,
        pubkey: BytesN<32>,
        base: Symbol,
        quote: Symbol,
        rate: i128,
        decimals: u32,
        timestamp: u64,
        signature: BytesN<64>,
    ) -> Result<(), OracleError> {
        if !Self::is_pubkey_signer(env.clone(), pubkey.clone()) {
            return Err(OracleError::UnauthorizedSigner);
        }

        // Construct standardized payload message for signing verification
        // Format: [base (Symbol), quote (Symbol), rate (i128), decimals (u32), timestamp (u64)]
        let mut msg = Bytes::new(&env);
        // Serialize parameters deterministically
        let base_val = base.to_val();
        let quote_val = quote.to_val();
        msg.append(&Bytes::from_array(&env, &base_val.get_payload().to_be_bytes()));
        msg.append(&Bytes::from_array(&env, &quote_val.get_payload().to_be_bytes()));
        msg.append(&Bytes::from_array(&env, &rate.to_be_bytes()));
        msg.append(&Bytes::from_array(&env, &decimals.to_be_bytes()));
        msg.append(&Bytes::from_array(&env, &timestamp.to_be_bytes()));

        // Verify ed25519 signature
        env.crypto().ed25519_verify(&pubkey, &msg, &signature);

        Self::apply_rate_update(&env, base, quote, rate, decimals, timestamp)
    }

    fn get_rate(env: Env, base: Symbol, quote: Symbol) -> Result<i128, OracleError> {
        let rate_data = Self::get_rate_data(env, base, quote)?;
        Ok(rate_data.rate)
    }

    fn get_rate_data(env: Env, base: Symbol, quote: Symbol) -> Result<RateData, OracleError> {
        let rate_data = Self::get_rate_data_unchecked(env.clone(), base, quote)?;

        let now = env.ledger().timestamp();
        let max_staleness = Self::get_max_staleness(env);

        if now > rate_data.timestamp && (now - rate_data.timestamp) > max_staleness {
            return Err(OracleError::PriceStale);
        }

        Ok(rate_data)
    }

    fn get_rate_data_unchecked(env: Env, base: Symbol, quote: Symbol) -> Result<RateData, OracleError> {
        let key = DataKey::Rate(base, quote);
        env.storage()
            .instance()
            .get::<_, RateData>(&key)
            .ok_or(OracleError::RateNotFound)
    }
}

impl RateOracle {
    /// Internal validation and storage routine for a validated price update.
    fn apply_rate_update(
        env: &Env,
        base: Symbol,
        quote: Symbol,
        rate: i128,
        decimals: u32,
        timestamp: u64,
    ) -> Result<(), OracleError> {
        if rate <= 0 {
            return Err(OracleError::InvalidRate);
        }

        let now = env.ledger().timestamp();
        let max_staleness = Self::get_max_staleness(env.clone());

        // Validate timestamp boundaries
        if timestamp > now + MAX_FUTURE_DRIFT_SECONDS {
            return Err(OracleError::InvalidTimestamp);
        }
        if now > timestamp && (now - timestamp) > max_staleness {
            return Err(OracleError::PriceStale);
        }

        let key = DataKey::Rate(base.clone(), quote.clone());
        let current = env.storage().instance().get::<_, RateData>(&key);

        let round = match current {
            Some(ref existing) => {
                // Must be newer than or equal to previous round timestamp
                if timestamp < existing.timestamp {
                    return Err(OracleError::InvalidTimestamp);
                }
                existing.round + 1
            }
            None => 1,
        };

        let new_data = RateData {
            rate,
            decimals,
            timestamp,
            round,
        };

        env.storage().instance().set(&key, &new_data);

        // Emit rate update event
        env.events().publish(
            (symbol_short!("rate_upd"), base, quote),
            (rate, decimals, timestamp),
        );

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        vec, Address, BytesN, Env, Symbol,
    };

    fn setup_oracle() -> (Env, Address, Address, RateOracleClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(RateOracle, ());
        let client = RateOracleClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let signer = Address::generate(&env);

        client.init(&admin, &300); // 300 seconds (5 minutes) staleness
        client.add_feed_signer(&admin, &signer);

        (env, admin, signer, client)
    }

    #[test]
    fn test_initialization() {
        let (env, admin, _, client) = setup_oracle();
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_max_staleness(), 300);

        let duplicate_admin = Address::generate(&env);
        let res = client.try_init(&duplicate_admin, &300);
        assert!(res.is_err());
    }

    #[test]
    fn test_signer_management() {
        let (env, admin, signer, client) = setup_oracle();
        assert!(client.is_feed_signer(&signer));

        let random_user = Address::generate(&env);
        assert!(!client.is_feed_signer(&random_user));

        // Admin removes signer
        client.remove_feed_signer(&admin, &signer);
        assert!(!client.is_feed_signer(&signer));

        // Non-admin cannot add signer
        let res = client.try_add_feed_signer(&random_user, &signer);
        assert!(res.is_err());
    }

    #[test]
    fn test_set_and_get_rate_for_ngn_xlm_and_ghs_usdc() {
        let (env, _, signer, client) = setup_oracle();
        let now = 1_000_000u64;
        env.ledger().set_timestamp(now);

        let ngn = Symbol::new(&env, "NGN");
        let xlm = Symbol::new(&env, "XLM");
        let ghs = Symbol::new(&env, "GHS");
        let usdc = Symbol::new(&env, "USDC");

        // 1. Set NGN/XLM rate: 15.5000000 XLM per 1000 NGN (scaled 7 decimals)
        let ngn_xlm_rate = 15_500_000i128;
        client.set_rate(&signer, &ngn, &xlm, &ngn_xlm_rate, &7, &now);

        let fetched_ngn_xlm = client.get_rate(&ngn, &xlm);
        assert_eq!(fetched_ngn_xlm, ngn_xlm_rate);

        // 2. Set GHS/USDC rate: 15.7500 USDC per GHS (scaled 4 decimals = 157,500)
        let ghs_usdc_rate = 157_500i128;
        client.set_rate(&signer, &ghs, &usdc, &ghs_usdc_rate, &4, &now);

        let fetched_ghs_usdc = client.get_rate(&ghs, &usdc);
        assert_eq!(fetched_ghs_usdc, ghs_usdc_rate);

        // Verify metadata
        let metadata = client.get_rate_data(&ghs, &usdc);
        assert_eq!(metadata.rate, ghs_usdc_rate);
        assert_eq!(metadata.decimals, 4);
        assert_eq!(metadata.timestamp, now);
        assert_eq!(metadata.round, 1);
    }

    #[test]
    fn test_unauthorized_signer_rejected() {
        let (env, _, _, client) = setup_oracle();
        let attacker = Address::generate(&env);
        let now = 1_000_000u64;
        env.ledger().set_timestamp(now);

        let ngn = Symbol::new(&env, "NGN");
        let xlm = Symbol::new(&env, "XLM");

        let res = client.try_set_rate(&attacker, &ngn, &xlm, &10_000_000i128, &7, &now);
        assert_eq!(res, Err(Ok(OracleError::UnauthorizedSigner)));
    }

    #[test]
    fn test_stale_price_disallowed_after_heartbeat() {
        let (env, _, signer, client) = setup_oracle();
        let start_time = 1_000_000u64;
        env.ledger().set_timestamp(start_time);

        let ngn = Symbol::new(&env, "NGN");
        let xlm = Symbol::new(&env, "XLM");

        // Post fresh price at start_time
        client.set_rate(&signer, &ngn, &xlm, &15_000_000i128, &7, &start_time);

        // 4 minutes later (240s <= 300s): price is still valid
        env.ledger().set_timestamp(start_time + 240);
        assert_eq!(client.get_rate(&ngn, &xlm), 15_000_000i128);

        // 5 minutes and 1 second later (301s > 300s): price is STALE
        env.ledger().set_timestamp(start_time + 301);
        let stale_res = client.try_get_rate(&ngn, &xlm);
        assert_eq!(stale_res, Err(Ok(OracleError::PriceStale)));

        // get_rate_data_unchecked still permits historical inspection
        let historical = client.get_rate_data_unchecked(&ngn, &xlm);
        assert_eq!(historical.rate, 15_000_000i128);
    }

    #[test]
    fn test_posting_stale_price_rejected() {
        let (env, _, signer, client) = setup_oracle();
        let now = 1_000_000u64;
        env.ledger().set_timestamp(now);

        let ngn = Symbol::new(&env, "NGN");
        let xlm = Symbol::new(&env, "XLM");

        // Attempting to post a price with timestamp older than 300s
        let old_time = now - 350;
        let res = client.try_set_rate(&signer, &ngn, &xlm, &15_000_000i128, &7, &old_time);
        assert_eq!(res, Err(Ok(OracleError::PriceStale)));
    }

    #[test]
    fn test_configurable_staleness_threshold() {
        let (env, admin, signer, client) = setup_oracle();
        let start_time = 1_000_000u64;
        env.ledger().set_timestamp(start_time);

        let ngn = Symbol::new(&env, "NGN");
        let xlm = Symbol::new(&env, "XLM");
        client.set_rate(&signer, &ngn, &xlm, &15_000_000i128, &7, &start_time);

        // Advance 400 seconds (stale under 300s default)
        env.ledger().set_timestamp(start_time + 400);
        assert_eq!(client.try_get_rate(&ngn, &xlm), Err(Ok(OracleError::PriceStale)));

        // Admin widens threshold to 600s (10 minutes)
        client.set_max_staleness(&admin, &600);
        assert_eq!(client.get_max_staleness(), 600);

        // Price is now accepted
        assert_eq!(client.get_rate(&ngn, &xlm), 15_000_000i128);
    }

    #[test]
    fn test_batch_set_rates() {
        let (env, _, signer, client) = setup_oracle();
        let now = 1_000_000u64;
        env.ledger().set_timestamp(now);

        let ngn = Symbol::new(&env, "NGN");
        let xlm = Symbol::new(&env, "XLM");
        let ghs = Symbol::new(&env, "GHS");
        let usdc = Symbol::new(&env, "USDC");

        let updates = vec![
            &env,
            RateUpdate {
                base: ngn.clone(),
                quote: xlm.clone(),
                rate: 15_000_000,
                decimals: 7,
                timestamp: now,
            },
            RateUpdate {
                base: ghs.clone(),
                quote: usdc.clone(),
                rate: 155_000,
                decimals: 4,
                timestamp: now,
            },
        ];

        client.set_rates(&signer, &updates);

        assert_eq!(client.get_rate(&ngn, &xlm), 15_000_000);
        assert_eq!(client.get_rate(&ghs, &usdc), 155_000);
    }

    #[test]
    fn test_rate_not_found() {
        let (env, _, _, client) = setup_oracle();
        let eur = Symbol::new(&env, "EUR");
        let jpy = Symbol::new(&env, "JPY");

        assert_eq!(client.try_get_rate(&eur, &jpy), Err(Ok(OracleError::RateNotFound)));
    }
}
