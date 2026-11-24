#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowDeposited {
    #[topic]
    pub escrow_id: u64,
    pub depositor: Address,
    pub recipient: Address,
    pub amount: i128,
    pub expires_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowReleased {
    #[topic]
    pub escrow_id: u64,
    pub caller: Address,
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRefunded {
    #[topic]
    pub escrow_id: u64,
    pub caller: Address,
    pub depositor: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowDisputed {
    #[topic]
    pub escrow_id: u64,
    pub caller: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowResolved {
    #[topic]
    pub escrow_id: u64,
    pub destination: Address,
    pub amount: i128,
    pub to_recipient: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowExtended {
    #[topic]
    pub escrow_id: u64,
    pub new_expires_at: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    EscrowAlreadyExists = 1,
    EscrowNotFound = 2,
    InvalidAmount = 3,
    InvalidExpiry = 4,
    InvalidParties = 5,
    Unauthorized = 6,
    InvalidStatus = 7,
    EscrowExpired = 8,
    EscrowNotExpired = 9,
    ReentrancyDetected = 10,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Active,
    Released,
    Refunded,
    Disputed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub id: u64,
    pub depositor: Address,
    pub recipient: Address,
    pub arbiter: Address,
    pub token: Address,
    pub amount: i128,
    pub created_at: u64,
    pub expires_at: u64,
    pub status: EscrowStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Escrow(u64),
    ReentrancyLock,
}

#[contract]
pub struct EscrowContract;

impl EscrowContract {
    fn acquire_lock(env: &Env) -> Result<(), EscrowError> {
        let locked: bool = env
            .storage()
            .instance()
            .get(&DataKey::ReentrancyLock)
            .unwrap_or(false);
        if locked {
            return Err(EscrowError::ReentrancyDetected);
        }
        env.storage()
            .instance()
            .set(&DataKey::ReentrancyLock, &true);
        Ok(())
    }

    fn release_lock(env: &Env) {
        env.storage()
            .instance()
            .set(&DataKey::ReentrancyLock, &false);
    }

    fn load_escrow(env: &Env, escrow_id: u64) -> Result<Escrow, EscrowError> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(EscrowError::EscrowNotFound)
    }

    fn save_escrow(env: &Env, escrow: &Escrow) {
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow.id), escrow);
    }
}

#[contractimpl]
impl EscrowContract {
    /// Deposits tokens into a time-locked conditional escrow.
    /// The depositor must authorize the call and token transfer.
    #[allow(clippy::too_many_arguments)]
    pub fn deposit(
        env: Env,
        escrow_id: u64,
        depositor: Address,
        recipient: Address,
        arbiter: Address,
        token: Address,
        amount: i128,
        expires_at: u64,
    ) -> Result<Escrow, EscrowError> {
        Self::acquire_lock(&env)?;

        let result = (|| {
            depositor.require_auth();

            if amount <= 0 {
                return Err(EscrowError::InvalidAmount);
            }

            if depositor == recipient {
                return Err(EscrowError::InvalidParties);
            }

            let now = env.ledger().timestamp();
            if expires_at <= now {
                return Err(EscrowError::InvalidExpiry);
            }

            if env.storage().persistent().has(&DataKey::Escrow(escrow_id)) {
                return Err(EscrowError::EscrowAlreadyExists);
            }

            let escrow = Escrow {
                id: escrow_id,
                depositor: depositor.clone(),
                recipient: recipient.clone(),
                arbiter: arbiter.clone(),
                token: token.clone(),
                amount,
                created_at: now,
                expires_at,
                status: EscrowStatus::Active,
            };

            // Checks-Effects-Interactions: persist escrow record before external token call.
            Self::save_escrow(&env, &escrow);

            let token_client = token::Client::new(&env, &token);
            token_client.transfer(&depositor, env.current_contract_address(), &amount);

            EscrowDeposited {
                escrow_id,
                depositor,
                recipient,
                amount,
                expires_at,
            }
            .publish(&env);

            Ok(escrow)
        })();

        Self::release_lock(&env);
        result
    }

    /// Releases an active, non-expired escrow to the recipient.
    /// Authorized callers: depositor or arbiter.
    pub fn release(env: Env, escrow_id: u64, caller: Address) -> Result<Escrow, EscrowError> {
        Self::acquire_lock(&env)?;

        let result = (|| {
            caller.require_auth();

            let mut escrow = Self::load_escrow(&env, escrow_id)?;

            if escrow.status != EscrowStatus::Active {
                return Err(EscrowError::InvalidStatus);
            }

            if caller != escrow.depositor && caller != escrow.arbiter {
                return Err(EscrowError::Unauthorized);
            }

            let now = env.ledger().timestamp();
            if now >= escrow.expires_at {
                return Err(EscrowError::EscrowExpired);
            }

            // Update state before external transfer to prevent reentrancy drains.
            escrow.status = EscrowStatus::Released;
            Self::save_escrow(&env, &escrow);

            let token_client = token::Client::new(&env, &escrow.token);
            token_client.transfer(
                &env.current_contract_address(),
                &escrow.recipient,
                &escrow.amount,
            );

            EscrowReleased {
                escrow_id,
                caller,
                recipient: escrow.recipient.clone(),
                amount: escrow.amount,
            }
            .publish(&env);

            Ok(escrow)
        })();

        Self::release_lock(&env);
        result
    }

    /// Refunds escrowed tokens back to the depositor.
    /// - Depositor may refund once `env.ledger().timestamp() >= expires_at`.
    /// - Recipient or arbiter may cancel and refund an Active escrow at any time.
    pub fn refund(env: Env, escrow_id: u64, caller: Address) -> Result<Escrow, EscrowError> {
        Self::acquire_lock(&env)?;

        let result = (|| {
            caller.require_auth();

            let mut escrow = Self::load_escrow(&env, escrow_id)?;

            if escrow.status != EscrowStatus::Active {
                return Err(EscrowError::InvalidStatus);
            }

            let now = env.ledger().timestamp();
            if caller == escrow.depositor {
                if now < escrow.expires_at {
                    return Err(EscrowError::EscrowNotExpired);
                }
            } else if caller != escrow.arbiter && caller != escrow.recipient {
                return Err(EscrowError::Unauthorized);
            }

            // Update state before external transfer to prevent reentrancy drains.
            escrow.status = EscrowStatus::Refunded;
            Self::save_escrow(&env, &escrow);

            let token_client = token::Client::new(&env, &escrow.token);
            token_client.transfer(
                &env.current_contract_address(),
                &escrow.depositor,
                &escrow.amount,
            );

            EscrowRefunded {
                escrow_id,
                caller,
                depositor: escrow.depositor.clone(),
                amount: escrow.amount,
            }
            .publish(&env);

            Ok(escrow)
        })();

        Self::release_lock(&env);
        result
    }

    /// Flags an active, non-expired escrow as disputed.
    /// Authorized callers: depositor or recipient.
    pub fn dispute(env: Env, escrow_id: u64, caller: Address) -> Result<Escrow, EscrowError> {
        caller.require_auth();

        let mut escrow = Self::load_escrow(&env, escrow_id)?;

        if escrow.status != EscrowStatus::Active {
            return Err(EscrowError::InvalidStatus);
        }

        if caller != escrow.depositor && caller != escrow.recipient {
            return Err(EscrowError::Unauthorized);
        }

        let now = env.ledger().timestamp();
        if now >= escrow.expires_at {
            return Err(EscrowError::EscrowExpired);
        }

        escrow.status = EscrowStatus::Disputed;
        Self::save_escrow(&env, &escrow);

        EscrowDisputed { escrow_id, caller }.publish(&env);

        Ok(escrow)
    }

    /// Resolves a disputed escrow. Only the assigned arbiter may invoke this method.
    pub fn resolve_dispute(
        env: Env,
        escrow_id: u64,
        to_recipient: bool,
    ) -> Result<Escrow, EscrowError> {
        Self::acquire_lock(&env)?;

        let result = (|| {
            let mut escrow = Self::load_escrow(&env, escrow_id)?;
            escrow.arbiter.require_auth();

            if escrow.status != EscrowStatus::Disputed {
                return Err(EscrowError::InvalidStatus);
            }

            let destination = if to_recipient {
                escrow.status = EscrowStatus::Released;
                escrow.recipient.clone()
            } else {
                escrow.status = EscrowStatus::Refunded;
                escrow.depositor.clone()
            };

            Self::save_escrow(&env, &escrow);

            let token_client = token::Client::new(&env, &escrow.token);
            token_client.transfer(
                &env.current_contract_address(),
                &destination,
                &escrow.amount,
            );

            EscrowResolved {
                escrow_id,
                destination,
                amount: escrow.amount,
                to_recipient,
            }
            .publish(&env);

            Ok(escrow)
        })();

        Self::release_lock(&env);
        result
    }

    /// Extends the expiration timestamp of an active escrow.
    /// Only the depositor may extend, and the new expiry must be strictly greater.
    pub fn extend_expiry(
        env: Env,
        escrow_id: u64,
        new_expires_at: u64,
    ) -> Result<Escrow, EscrowError> {
        let mut escrow = Self::load_escrow(&env, escrow_id)?;
        escrow.depositor.require_auth();

        if escrow.status != EscrowStatus::Active {
            return Err(EscrowError::InvalidStatus);
        }

        let now = env.ledger().timestamp();
        if new_expires_at <= escrow.expires_at || new_expires_at <= now {
            return Err(EscrowError::InvalidExpiry);
        }

        escrow.expires_at = new_expires_at;
        Self::save_escrow(&env, &escrow);

        EscrowExtended {
            escrow_id,
            new_expires_at,
        }
        .publish(&env);

        Ok(escrow)
    }

    /// Returns the stored escrow record for `escrow_id`.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<Escrow, EscrowError> {
        Self::load_escrow(&env, escrow_id)
    }

    /// Returns whether the contract's reentrancy guard is currently locked.
    pub fn is_locked(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::ReentrancyLock)
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod test;
