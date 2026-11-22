#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env, Symbol,
};

pub const BPS_DENOMINATOR: i128 = 10_000;
const MAX_TOTAL_FEE_BPS: u32 = 9_999;

const INSTANCE_LIFETIME_THRESHOLD: u32 = 17_280;
const INSTANCE_BUMP_AMOUNT: u32 = 518_400;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 17_280;
const PERSISTENT_BUMP_AMOUNT: u32 = 518_400;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SettlementError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidFeeConfig = 3,
    CorridorNotFound = 4,
    CorridorInactive = 5,
    InvalidAmount = 6,
    ArithmeticOverflow = 7,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CorridorConfig {
    pub corridor_id: Symbol,
    pub token: Address,
    pub lp_address: Address,
    pub lp_fee_bps: u32,
    pub platform_address: Address,
    pub platform_fee_bps: u32,
    pub offramp_address: Address,
    pub offramp_fee_bps: u32,
    pub active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SettlementBreakdown {
    pub gross_amount: i128,
    pub lp_fee: i128,
    pub platform_fee: i128,
    pub offramp_fee: i128,
    pub net_payout: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CorridorStats {
    pub total_volume: i128,
    pub total_fees: i128,
    pub settlement_count: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Admin,
    Corridor(Symbol),
    Stats(Symbol),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CorridorConfigured {
    #[topic]
    pub corridor_id: Symbol,
    pub lp_fee_bps: u32,
    pub platform_fee_bps: u32,
    pub offramp_fee_bps: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CorridorStatusUpdated {
    #[topic]
    pub corridor_id: Symbol,
    pub active: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentSettled {
    #[topic]
    pub corridor_id: Symbol,
    pub payer: Address,
    pub payout_address: Address,
    pub gross_amount: i128,
    pub lp_fee: i128,
    pub platform_fee: i128,
    pub offramp_fee: i128,
    pub net_payout: i128,
}

#[contract]
pub struct SettlementContract;

impl SettlementContract {
    fn compute_split(
        config: &CorridorConfig,
        gross_amount: i128,
    ) -> Result<SettlementBreakdown, SettlementError> {
        if gross_amount <= 0 {
            return Err(SettlementError::InvalidAmount);
        }

        let lp_fee = gross_amount
            .checked_mul(i128::from(config.lp_fee_bps))
            .ok_or(SettlementError::ArithmeticOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(SettlementError::ArithmeticOverflow)?;

        let platform_fee = gross_amount
            .checked_mul(i128::from(config.platform_fee_bps))
            .ok_or(SettlementError::ArithmeticOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(SettlementError::ArithmeticOverflow)?;

        let offramp_fee = gross_amount
            .checked_mul(i128::from(config.offramp_fee_bps))
            .ok_or(SettlementError::ArithmeticOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(SettlementError::ArithmeticOverflow)?;

        let total_fees = lp_fee
            .checked_add(platform_fee)
            .and_then(|v| v.checked_add(offramp_fee))
            .ok_or(SettlementError::ArithmeticOverflow)?;

        // Any sub-stroop remainder from integer division stays in `net_payout`,
        // guaranteeing `lp_fee + platform_fee + offramp_fee + net_payout == gross_amount`
        // with zero rounding leakage.
        let net_payout = gross_amount
            .checked_sub(total_fees)
            .ok_or(SettlementError::ArithmeticOverflow)?;

        if net_payout <= 0 {
            return Err(SettlementError::InvalidAmount);
        }

        Ok(SettlementBreakdown {
            gross_amount,
            lp_fee,
            platform_fee,
            offramp_fee,
            net_payout,
        })
    }

    fn require_admin(env: &Env) -> Result<Address, SettlementError> {
        let admin = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Admin)
            .ok_or(SettlementError::NotInitialized)?;
        admin.require_auth();
        Ok(admin)
    }
}

#[contractimpl]
impl SettlementContract {
    /// Initializes the settlement contract with an administrator address.
    pub fn initialize(env: Env, admin: Address) -> Result<(), SettlementError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(SettlementError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Creates or updates a payment corridor's fee configuration.
    #[allow(clippy::too_many_arguments)]
    pub fn configure_corridor(
        env: Env,
        corridor_id: Symbol,
        token: Address,
        lp_address: Address,
        lp_fee_bps: u32,
        platform_address: Address,
        platform_fee_bps: u32,
        offramp_address: Address,
        offramp_fee_bps: u32,
    ) -> Result<(), SettlementError> {
        Self::require_admin(&env)?;

        let total_bps = lp_fee_bps
            .checked_add(platform_fee_bps)
            .and_then(|v| v.checked_add(offramp_fee_bps))
            .ok_or(SettlementError::InvalidFeeConfig)?;

        if total_bps > MAX_TOTAL_FEE_BPS {
            return Err(SettlementError::InvalidFeeConfig);
        }

        let config = CorridorConfig {
            corridor_id: corridor_id.clone(),
            token,
            lp_address,
            lp_fee_bps,
            platform_address,
            platform_fee_bps,
            offramp_address,
            offramp_fee_bps,
            active: true,
        };

        let key = DataKey::Corridor(corridor_id.clone());
        env.storage().persistent().set(&key, &config);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        CorridorConfigured {
            corridor_id,
            lp_fee_bps,
            platform_fee_bps,
            offramp_fee_bps,
        }
        .publish(&env);

        Ok(())
    }

    /// Activates or pauses an existing payment corridor.
    pub fn set_corridor_active(
        env: Env,
        corridor_id: Symbol,
        active: bool,
    ) -> Result<(), SettlementError> {
        Self::require_admin(&env)?;

        let key = DataKey::Corridor(corridor_id.clone());
        let mut config = env
            .storage()
            .persistent()
            .get::<DataKey, CorridorConfig>(&key)
            .ok_or(SettlementError::CorridorNotFound)?;

        config.active = active;
        env.storage().persistent().set(&key, &config);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        CorridorStatusUpdated {
            corridor_id,
            active,
        }
        .publish(&env);

        Ok(())
    }

    /// Atomically splits `gross_amount` from `payer` across the liquidity provider,
    /// platform treasury, local off-ramp partner, and final `payout_address` in a
    /// single contract invocation with zero rounding leakage.
    pub fn settle(
        env: Env,
        corridor_id: Symbol,
        payer: Address,
        payout_address: Address,
        gross_amount: i128,
    ) -> Result<SettlementBreakdown, SettlementError> {
        payer.require_auth();

        let key = DataKey::Corridor(corridor_id.clone());
        let config = env
            .storage()
            .persistent()
            .get::<DataKey, CorridorConfig>(&key)
            .ok_or(SettlementError::CorridorNotFound)?;

        if !config.active {
            return Err(SettlementError::CorridorInactive);
        }

        let breakdown = Self::compute_split(&config, gross_amount)?;
        let token_client = token::Client::new(&env, &config.token);

        if breakdown.lp_fee > 0 {
            token_client.transfer(&payer, &config.lp_address, &breakdown.lp_fee);
        }
        if breakdown.platform_fee > 0 {
            token_client.transfer(&payer, &config.platform_address, &breakdown.platform_fee);
        }
        if breakdown.offramp_fee > 0 {
            token_client.transfer(&payer, &config.offramp_address, &breakdown.offramp_fee);
        }
        token_client.transfer(&payer, &payout_address, &breakdown.net_payout);

        let stats_key = DataKey::Stats(corridor_id.clone());
        let mut stats = env
            .storage()
            .persistent()
            .get::<DataKey, CorridorStats>(&stats_key)
            .unwrap_or(CorridorStats {
                total_volume: 0,
                total_fees: 0,
                settlement_count: 0,
            });

        let total_fee = breakdown
            .lp_fee
            .checked_add(breakdown.platform_fee)
            .and_then(|v| v.checked_add(breakdown.offramp_fee))
            .ok_or(SettlementError::ArithmeticOverflow)?;

        stats.total_volume = stats
            .total_volume
            .checked_add(gross_amount)
            .ok_or(SettlementError::ArithmeticOverflow)?;
        stats.total_fees = stats
            .total_fees
            .checked_add(total_fee)
            .ok_or(SettlementError::ArithmeticOverflow)?;
        stats.settlement_count = stats
            .settlement_count
            .checked_add(1)
            .ok_or(SettlementError::ArithmeticOverflow)?;

        env.storage().persistent().set(&stats_key, &stats);
        env.storage().persistent().extend_ttl(
            &stats_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        PaymentSettled {
            corridor_id,
            payer,
            payout_address,
            gross_amount: breakdown.gross_amount,
            lp_fee: breakdown.lp_fee,
            platform_fee: breakdown.platform_fee,
            offramp_fee: breakdown.offramp_fee,
            net_payout: breakdown.net_payout,
        }
        .publish(&env);

        Ok(breakdown)
    }

    /// Computes the exact fee breakdown for a corridor without transferring tokens.
    pub fn preview_split(
        env: Env,
        corridor_id: Symbol,
        gross_amount: i128,
    ) -> Result<SettlementBreakdown, SettlementError> {
        let config = Self::get_corridor(env, corridor_id)?;
        Self::compute_split(&config, gross_amount)
    }

    /// Returns the configuration for `corridor_id`.
    pub fn get_corridor(env: Env, corridor_id: Symbol) -> Result<CorridorConfig, SettlementError> {
        env.storage()
            .persistent()
            .get::<DataKey, CorridorConfig>(&DataKey::Corridor(corridor_id))
            .ok_or(SettlementError::CorridorNotFound)
    }

    /// Returns cumulative settlement statistics for `corridor_id`.
    pub fn get_corridor_stats(env: Env, corridor_id: Symbol) -> CorridorStats {
        env.storage()
            .persistent()
            .get::<DataKey, CorridorStats>(&DataKey::Stats(corridor_id))
            .unwrap_or(CorridorStats {
                total_volume: 0,
                total_fees: 0,
                settlement_count: 0,
            })
    }

    /// Returns the contract administrator address.
    pub fn get_admin(env: Env) -> Result<Address, SettlementError> {
        env.storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Admin)
            .ok_or(SettlementError::NotInitialized)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::symbol_short;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::token::StellarAssetClient;

    struct Actors {
        admin: Address,
        payer: Address,
        payout: Address,
        lp: Address,
        platform: Address,
        offramp: Address,
    }

    fn setup_env() -> (Env, Address, Address, Actors) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(SettlementContract, ());
        let token_admin = Address::generate(&env);
        let stellar_asset = env.register_stellar_asset_contract_v2(token_admin);
        let token_id = stellar_asset.address();

        let actors = Actors {
            admin: Address::generate(&env),
            payer: Address::generate(&env),
            payout: Address::generate(&env),
            lp: Address::generate(&env),
            platform: Address::generate(&env),
            offramp: Address::generate(&env),
        };

        StellarAssetClient::new(&env, &token_id).mint(&actors.payer, &100_000_000);

        let client = SettlementContractClient::new(&env, &contract_id);
        client.initialize(&actors.admin);

        (env, contract_id, token_id, actors)
    }

    #[test]
    fn test_atomic_fee_splitting_in_single_invocation() {
        let (env, contract_id, token_id, actors) = setup_env();
        let client = SettlementContractClient::new(&env, &contract_id);
        let token = token::Client::new(&env, &token_id);

        let corridor = symbol_short!("USD_NGN");
        // 1.50% LP (150 bps), 0.75% platform (75 bps), 0.50% offramp (50 bps) => 2.75% total
        client.configure_corridor(
            &corridor,
            &token_id,
            &actors.lp,
            &150,
            &actors.platform,
            &75,
            &actors.offramp,
            &50,
        );

        let gross = 100_000;
        let preview = client.preview_split(&corridor, &gross);
        let result = client.settle(&corridor, &actors.payer, &actors.payout, &gross);
        assert_eq!(result, preview);

        assert_eq!(result.lp_fee, 1_500);
        assert_eq!(result.platform_fee, 750);
        assert_eq!(result.offramp_fee, 500);
        assert_eq!(result.net_payout, 97_250);
        assert_eq!(
            result.lp_fee + result.platform_fee + result.offramp_fee + result.net_payout,
            gross
        );

        assert_eq!(token.balance(&actors.lp), 1_500);
        assert_eq!(token.balance(&actors.platform), 750);
        assert_eq!(token.balance(&actors.offramp), 500);
        assert_eq!(token.balance(&actors.payout), 97_250);
        assert_eq!(token.balance(&contract_id), 0);

        let stats = client.get_corridor_stats(&corridor);
        assert_eq!(stats.total_volume, 100_000);
        assert_eq!(stats.total_fees, 2_750);
        assert_eq!(stats.settlement_count, 1);
    }

    #[test]
    fn test_zero_rounding_leakage_across_odd_and_prime_amounts() {
        let (env, contract_id, token_id, actors) = setup_env();
        let client = SettlementContractClient::new(&env, &contract_id);
        let token = token::Client::new(&env, &token_id);

        let corridor = symbol_short!("EUR_GHS");
        // Prime basis point rates: 137 bps, 73 bps, 41 bps
        client.configure_corridor(
            &corridor,
            &token_id,
            &actors.lp,
            &137,
            &actors.platform,
            &73,
            &actors.offramp,
            &41,
        );

        let amounts = [1_i128, 3, 7, 13, 99, 101, 999, 12_345, 1_000_003, 9_999_997];
        let mut expected_total_gross = 0_i128;

        for amount in amounts {
            let breakdown = client.settle(&corridor, &actors.payer, &actors.payout, &amount);
            let sum = breakdown.lp_fee
                + breakdown.platform_fee
                + breakdown.offramp_fee
                + breakdown.net_payout;
            assert_eq!(sum, amount, "rounding leakage detected for amount {amount}");
            assert!(breakdown.net_payout > 0);
            expected_total_gross += amount;
        }

        let distributed = token.balance(&actors.lp)
            + token.balance(&actors.platform)
            + token.balance(&actors.offramp)
            + token.balance(&actors.payout);
        assert_eq!(distributed, expected_total_gross);
        assert_eq!(token.balance(&contract_id), 0);

        let stats = client.get_corridor_stats(&corridor);
        assert_eq!(stats.total_volume, expected_total_gross);
        assert_eq!(stats.settlement_count, amounts.len() as u64);
    }

    #[test]
    fn test_corridor_with_zero_offramp_fee() {
        let (env, contract_id, token_id, actors) = setup_env();
        let client = SettlementContractClient::new(&env, &contract_id);
        let token = token::Client::new(&env, &token_id);

        let corridor = symbol_short!("USD_KES");
        client.configure_corridor(
            &corridor,
            &token_id,
            &actors.lp,
            &100,
            &actors.platform,
            &50,
            &actors.offramp,
            &0,
        );

        let breakdown = client.settle(&corridor, &actors.payer, &actors.payout, &10_000);
        assert_eq!(breakdown.lp_fee, 100);
        assert_eq!(breakdown.platform_fee, 50);
        assert_eq!(breakdown.offramp_fee, 0);
        assert_eq!(breakdown.net_payout, 9_850);
        assert_eq!(token.balance(&actors.offramp), 0);
    }

    #[test]
    fn test_paused_corridor_and_error_cases() {
        let (env, contract_id, token_id, actors) = setup_env();
        let client = SettlementContractClient::new(&env, &contract_id);

        // Re-initialization fails.
        assert_eq!(
            client.try_initialize(&actors.admin),
            Err(Ok(SettlementError::AlreadyInitialized))
        );

        // Total fees >= 100% rejected.
        assert_eq!(
            client.try_configure_corridor(
                &symbol_short!("BAD"),
                &token_id,
                &actors.lp,
                &5_000,
                &actors.platform,
                &5_000,
                &actors.offramp,
                &0,
            ),
            Err(Ok(SettlementError::InvalidFeeConfig))
        );

        // Unknown corridor rejected.
        assert_eq!(
            client.try_settle(&symbol_short!("NOPE"), &actors.payer, &actors.payout, &100),
            Err(Ok(SettlementError::CorridorNotFound))
        );

        let corridor = symbol_short!("USD_NGN");
        client.configure_corridor(
            &corridor,
            &token_id,
            &actors.lp,
            &100,
            &actors.platform,
            &50,
            &actors.offramp,
            &50,
        );

        // Zero and negative amounts rejected.
        assert_eq!(
            client.try_settle(&corridor, &actors.payer, &actors.payout, &0),
            Err(Ok(SettlementError::InvalidAmount))
        );
        assert_eq!(
            client.try_settle(&corridor, &actors.payer, &actors.payout, &-500),
            Err(Ok(SettlementError::InvalidAmount))
        );

        // Pausing corridor blocks settlement until re-activated.
        client.set_corridor_active(&corridor, &false);
        assert_eq!(
            client.try_settle(&corridor, &actors.payer, &actors.payout, &1_000),
            Err(Ok(SettlementError::CorridorInactive))
        );

        client.set_corridor_active(&corridor, &true);
        let res = client.settle(&corridor, &actors.payer, &actors.payout, &1_000);
        assert_eq!(res.net_payout, 980);
    }

    #[test]
    #[should_panic(expected = "Error(Auth, InvalidAction)")]
    fn test_settle_requires_payer_auth() {
        let (env, contract_id, token_id, actors) = setup_env();
        let client = SettlementContractClient::new(&env, &contract_id);
        let corridor = symbol_short!("USD_NGN");

        client.configure_corridor(
            &corridor,
            &token_id,
            &actors.lp,
            &100,
            &actors.platform,
            &50,
            &actors.offramp,
            &50,
        );

        // Clear all mocked auths so payer signature is missing.
        env.set_auths(&[]);
        client.settle(&corridor, &actors.payer, &actors.payout, &1_000);
    }

    #[test]
    #[should_panic(expected = "Error(Auth, InvalidAction)")]
    fn test_configure_corridor_requires_admin_auth() {
        let (env, contract_id, token_id, actors) = setup_env();
        let client = SettlementContractClient::new(&env, &contract_id);

        env.set_auths(&[]);
        client.configure_corridor(
            &symbol_short!("USD_NGN"),
            &token_id,
            &actors.lp,
            &100,
            &actors.platform,
            &50,
            &actors.offramp,
            &50,
        );
    }
}
