# SendAm Soroban Smart Contracts

This directory contains Soroban smart contracts and shared libraries for SendAm's on-chain settlement and governance rails.

## Workspace Layout

- `contracts/common`: Common governance, timelock, and upgradeable contract primitives (`contracts/common/src/upgrade.rs`).
- `contracts/oracle`: On-chain FX Rate Oracle for corridor feeds like NGN/XLM and GHS/USDC (`contracts/oracle/src/lib.rs`).

## Upgradeable Contract Pattern (`contracts/common/src/upgrade.rs`)

Mainnet contracts require secure bug fixes and code updates without sacrificing decentralization or user fund safety. The `UpgradeManager` provides a two-step timelocked upgrade pattern:

### Security Guardrails

1. **Admin Authorization**: Code upgrades can only be proposed and executed by the verified administrator address (`admin.require_auth()`).
2. **48-Hour Timelock**: Upgrades enforce a mandatory 48-hour delay (`172,800` seconds) between proposal and execution.
3. **Audit Trail Events**:
   - `propose`: Emitted when an upgrade is scheduled with target WASM hash and unlock timestamp.
   - `cancel`: Emitted if an admin cancels a scheduled upgrade prior to execution.
   - `upgrade`: Emitted upon successful execution with `(old_wasm_hash, new_wasm_hash)`.
4. **WASM Replacement**: Invokes `env.deployer().update_current_contract_wasm()` to atomically upgrade contract bytecode in place while preserving contract storage.

### Usage in Contracts

```rust
use sendam_contract_common::{UpgradeManager, Upgradeable, UpgradeProposal, UpgradeError};

#[contract]
pub struct MyContract;

#[contractimpl]
impl Upgradeable for MyContract {
    fn init(env: Env, admin: Address, initial_wasm_hash: BytesN<32>) {
        UpgradeManager::init(&env, &admin, &initial_wasm_hash).unwrap();
    }

    fn get_admin(env: Env) -> Address {
        UpgradeManager::get_admin(&env).unwrap()
    }

    fn set_admin(env: Env, current_admin: Address, new_admin: Address) {
        UpgradeManager::set_admin(&env, &current_admin, &new_admin).unwrap();
    }

    fn propose_upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> u64 {
        UpgradeManager::propose_upgrade(&env, &admin, &new_wasm_hash).unwrap()
    }

    fn cancel_upgrade(env: Env, admin: Address) {
        UpgradeManager::cancel_upgrade(&env, &admin).unwrap();
    }

    fn get_pending_upgrade(env: Env) -> Option<UpgradeProposal> {
        UpgradeManager::get_pending_upgrade(&env)
    }

    fn get_wasm_hash(env: Env) -> BytesN<32> {
        UpgradeManager::get_current_wasm_hash(&env)
    }

    fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) {
        UpgradeManager::upgrade(&env, &admin, &new_wasm_hash).unwrap();
    }
}
```

## Rate Oracle Contract (`contracts/oracle/src/lib.rs`)

Provides tamper-resistant, verifiable on-chain FX rate feeds for cross-border African payment corridors (`NGN/XLM`, `GHS/USDC`).

### Security Features

1. **Signer Verification**: Only authorized feeder identities (addresses or verified Ed25519 keypairs) can publish rates (`signer.require_auth()`).
2. **Heartbeat / Staleness Enforcement**: Queries via `get_rate(base, quote)` automatically disallow prices older than the configurable threshold (default: 300 seconds / 5 minutes) via `OracleError::PriceStale`.
3. **Monotonic Sequence**: Rejects timestamps older than previous updates or in the future beyond permitted clock drift.
4. **Single & Batch Invocations**: Supports updating individual corridor rates (`set_rate`) or atomic batch updates (`set_rates`).

### Usage Example

```rust
use sendam_contract_oracle::{RateOracleClient, RateUpdate};

// Querying on-chain rate
let rate = oracle_client.get_rate(&Symbol::new(&env, "NGN"), &Symbol::new(&env, "XLM"));
```
