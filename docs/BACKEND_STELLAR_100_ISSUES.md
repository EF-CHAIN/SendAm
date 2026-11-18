# SendAm 100 Backend, Stellar & Soroban Issue Backlog

**Project:** `EF-CHAIN/SendAm`  
**Target Areas:** `apps/api`, `contracts/`, `packages/shared`, `prisma/`, `observability/`, `deploy/`  
**Focus:** Soroban Smart Contracts, Stellar Horizon & RPC, SEPs (SEP-10/24/31/38), Key Custody & KMS, WhatsApp & Voice Engine, Compliance & AML, Payment Orchestration, Background Queues, and DevOps Security.

---

## Executive Summary

Following the full implementation and merger of SendAm's 120 frontend issues (`#716`–`#835`), this document establishes the next **100 production-grade, actionable issues** required to close the on-chain loop, achieve production readiness, and qualify SendAm for Band B / Band A in the Stellar Drips Wave / SCF program.

### Distribution by Category:
1. **Soroban Smart Contracts & On-Chain Settlement (Issues 1–15):** Escrow, Timelocks, Smart Wallets, Soroban RPC, and Rust SDK.
2. **Stellar Ecosystem Proposals (SEPs) & Anchor Rails (Issues 16–28):** SEP-1, SEP-10, SEP-12, SEP-24, SEP-31, SEP-38, Federation.
3. **Wallet Engine, Key Custody & KMS Security (Issues 29–42):** KMS Envelope Encryption, Key Rotation, Multi-Sig, Muxed Accounts.
4. **WhatsApp Conversational Interface & Voice Pipeline (Issues 43–56):** Webhook Security, Deepgram/Whisper, Interactive Payloads, FSM.
5. **Compliance, KYC, AML & Risk Decisioning (Issues 57–70):** Smile ID/Dojah, Sanctions/PEP, Velocity Limits, Argon2id PIN, Erasure.
6. **Payment Orchestrator, FX Rates & Idempotency (Issues 71–82):** Rate Aggregation, Double-Entry Ledger, Path Payments, Stroop Math.
7. **Background Queues, Workers & Distributed Jobs (Issues 83–92):** BullMQ Concurrency, DLQ Recovery, Horizon Cursor Resilience.
8. **Observability, Infrastructure, CI/CD & Security Hardening (Issues 93–100):** OpenTelemetry, Prometheus, PII Redaction, SAST.

---

## Category 1: Soroban Smart Contracts & On-Chain Settlement

### Issue 1: Initialize Soroban Workspace and Escrow Smart Contract in `contracts/escrow`
- **Target Area:** `contracts/escrow/src/lib.rs`, `Cargo.toml`
- **Problem:** SendAm currently relies purely on Horizon payment operations. There is no on-chain Soroban contract to hold cross-border payments in conditional escrow until WhatsApp recipient confirmation.
- **Required Work:** Scaffold a Cargo Soroban workspace; implement an Escrow contract with `deposit`, `release`, and `refund` methods; enforce authorization with `Address::require_auth()`.
- **Acceptance Criteria:** Escrow contract compiles with `soroban-sdk` v20+; tests verify depositor funds cannot be released without arbiter/recipient signature.
- **Labels:** `soroban, smart-contracts, rust, stellar, difficulty: high, points: 200`

### Issue 2: Implement Time-Locked Escrow with Multi-Party Release in Soroban
- **Target Area:** `contracts/escrow/src/timelock.rs`
- **Problem:** If a WhatsApp recipient fails to claim a remittance or confirm their phone number within a deadline, funds remain indefinitely locked unless an automated expiration release exists.
- **Required Work:** Implement expiration ledger height/timestamp checks using `env.ledger().timestamp()`; allow sender clawback after timeout.
- **Acceptance Criteria:** Contract automatically permits sender refund once expiration timestamp passes; rejects premature refund attempts.
- **Labels:** `soroban, smart-contracts, timelock, difficulty: medium, points: 150`

### Issue 3: Develop Soroban Payment Corridor Settlement Contract with Fee Distribution
- **Target Area:** `contracts/settlement/src/lib.rs`
- **Problem:** Cross-border corridor settlement splits fees between liquidity providers, local off-ramp partners, and the platform. Manual fee distribution off-chain creates accounting delays and counterparty risk.
- **Required Work:** Implement atomic fee splitting in Soroban; distribute incoming payments to LP, platform fee address, and payout address in one invocation.
- **Acceptance Criteria:** Single contract call splits gross amount into net payout and fee slices without rounding leakage.
- **Labels:** `soroban, settlement, fees, difficulty: high, points: 200`

### Issue 4: Implement On-Chain Attestation Registry Contract for Verified WhatsApp Identities
- **Target Area:** `contracts/attestation/src/lib.rs`
- **Problem:** Other Stellar dApps and anchors cannot verify that a customer's public key corresponds to a verified phone number without centralized API lookups.
- **Required Work:** Create an Attestation Registry contract storing cryptographic hashes of verified phone numbers (SHA-256 + salt) mapped to Stellar public keys with expiration timestamps.
- **Acceptance Criteria:** Attestations can only be written by authorized compliance signers; read methods allow trustless verification of identity hashes.
- **Labels:** `soroban, identity, attestation, privacy, difficulty: high, points: 200`

### Issue 5: Build Soroban Smart Wallet Factory for Account Abstraction and WebAuthn Passkeys
- **Target Area:** `contracts/smart-wallet/src/factory.rs`
- **Problem:** Direct-custody keypairs require storing secrets on backend servers. A smart wallet factory enables deploying individual smart accounts for users supporting passkey authentication.
- **Required Work:** Implement Soroban factory pattern deploying minimal proxy contract accounts; store secp256r1/ed25519 verification keys.
- **Acceptance Criteria:** Factory deploys deterministic smart contract wallets; deployed wallets support transaction execution verified against passkey signatures.
- **Labels:** `soroban, account-abstraction, passkeys, difficulty: high, points: 200`

### Issue 6: Add Soroban Contract Deployment and Initialization Script with Network Passphrase Validation
- **Target Area:** `scripts/deploy-soroban.js`, `apps/api/src/config/soroban.js`
- **Problem:** No automated CLI script exists in the repository to build, optimize (via `soroban contract optimize`), deploy, and commit contract IDs to environment configurations.
- **Required Work:** Create node/bash deployment automation reading compiled `.wasm`, deploying via Soroban RPC, capturing contract ID, and validating network passphrase (testnet/mainnet).
- **Acceptance Criteria:** Running `npm run deploy:contracts:testnet` compiles, optimizes, deploys, and writes contract IDs to `.env` with validation.
- **Labels:** `soroban, devops, scripts, deployment, difficulty: medium, points: 150`

### Issue 7: Implement Soroban RPC Client in `apps/api/src/blockchain/soroban.client.js`
- **Target Area:** `apps/api/src/blockchain/soroban.client.js`
- **Problem:** `apps/api` only instantiates `StellarSdk.Horizon.Server` and lacks a dedicated Soroban RPC client (`StellarSdk.rpc.Server`) for simulating and sending contract invocations.
- **Required Work:** Build a resilient Soroban RPC client with endpoint failover, status polling, and exponential backoff on `getHealth` and `getTransaction`.
- **Acceptance Criteria:** Client successfully simulates contract calls and retrieves confirmed transaction results via Soroban RPC.
- **Labels:** `backend, soroban, rpc, stellar-sdk, difficulty: medium, points: 150`

### Issue 8: Implement Event Subscription Daemon for Soroban Contract Topic Filtering
- **Target Area:** `apps/api/src/blockchain/eventListener.js`
- **Problem:** Contract state changes (e.g. Escrow funded, Attestation updated) must trigger instant WhatsApp message notifications without polling individual transactions.
- **Required Work:** Implement an event listener using `getEvents` RPC method; filter by contract ID and topic; parse XDR event values and dispatch to BullMQ notification queue.
- **Acceptance Criteria:** Emitted contract events are captured within 5 seconds, parsed from ScVal to JavaScript objects, and dispatched to queues.
- **Labels:** `backend, soroban, events, queues, difficulty: medium, points: 150`

### Issue 9: Add Soroban Unit and Integration Test Harness with Rust `soroban-sdk::Env`
- **Target Area:** `contracts/escrow/src/test.rs`
- **Problem:** Soroban smart contract logic must be verified locally without deploying to testnet to ensure zero regressions on gas limits and reentrancy.
- **Required Work:** Write comprehensive Rust tests using `soroban_sdk::Env::default()`, mocking token clients (SAC), client accounts, and time jumps.
- **Acceptance Criteria:** `cargo test` executes 20+ scenarios including unauthorized caller rejection, expired escrow claims, and reentrancy resilience.
- **Labels:** `soroban, testing, rust, difficulty: medium, points: 150`

### Issue 10: Implement Soroban Transaction Simulation and Footprint Extraction prior to Submission
- **Target Area:** `apps/api/src/blockchain/soroban.simulator.js`
- **Problem:** Invoking Soroban contracts directly without prior simulation leads to failed transactions, wasted gas fees, and unhandled ledger footprint conflicts.
- **Required Work:** Implement `simulateTransaction` pipeline; extract read/write resource footprints and minimum resource fees; inject footprints into final transaction envelope.
- **Acceptance Criteria:** All contract invocations pass through simulation before signing; fails early with clear error messaging if simulation reverts.
- **Labels:** `backend, soroban, simulation, fees, difficulty: high, points: 200`

### Issue 11: Build Stellar Channel Account Pool to Prevent Sequence Number Collisions
- **Target Area:** `apps/api/src/wallet/channelAccountPool.js`
- **Problem:** High-volume concurrent WhatsApp payments using a single funding or platform account fail with Horizon `tx_bad_seq` sequence number collisions.
- **Required Work:** Implement a channel account pool managing dedicated channel keypairs for transaction submission while keeping the base account as the sole source of funds.
- **Acceptance Criteria:** Channel pool supports 50 concurrent payment submissions without sequence collision; channels auto-replenish reserves when low.
- **Labels:** `backend, stellar, concurrency, scaling, difficulty: high, points: 200`

### Issue 12: Add Automated Fee-Bump (SEP-0015 / Protocol 20) Wrapper for High-Traffic Stellar Submissions
- **Target Area:** `apps/api/src/wallet/feeBump.js`
- **Problem:** During periods of Stellar network congestion, payments can sit unconfirmed or get dropped if base fee surges above initial envelope bid.
- **Required Work:** Wrap transactions in `FeeBumpTransactionBuilder`; monitor transaction status and automatically bump fee bid if unconfirmed after 3 ledgers (~15s).
- **Acceptance Criteria:** Stalled transactions are automatically rebroadcast with boosted fee; prevents double-spend and succeeds under ledger congestion.
- **Labels:** `backend, stellar, fee-bump, protocol-20, difficulty: medium, points: 150`

### Issue 13: Implement Soroban Upgradeable Contract Pattern with Admin Role and Timelock
- **Target Area:** `contracts/common/src/upgrade.rs`
- **Problem:** Contracts deployed to mainnet cannot receive bug fixes or security patches unless an upgrade pattern with admin authorization exists.
- **Required Work:** Implement `upgrade(new_wasm_hash)` method gated by admin address check; require 48-hour timelock delay before applying code upgrades.
- **Acceptance Criteria:** Contract code hash can only be updated by admin; upgrade event is emitted with old and new hash; rejects non-admin callers.
- **Labels:** `soroban, governance, security, difficulty: medium, points: 150`

### Issue 14: Create On-Chain Rate Oracle Contract for NGN/XLM and GHS/USDC Corridor Feeds
- **Target Area:** `contracts/oracle/src/lib.rs`
- **Problem:** Off-chain FX quotes cannot be verified on-chain by escrow or settlement contracts, creating trust dependency on backend servers.
- **Required Work:** Create an Oracle contract accepting signed price feed updates with timestamp and heartbeat validation; expose `get_rate(base, quote)` query.
- **Acceptance Criteria:** Disallows stale prices older than configurable threshold (e.g. 5 minutes); verifies feed signer signature.
- **Labels:** `soroban, oracle, fx, difficulty: high, points: 200`

### Issue 15: Add Cross-Contract Call Support for Liquidity Pool Swaps via Stellar Asset Contract (SAC)
- **Target Area:** `contracts/settlement/src/swap.rs`
- **Problem:** Users sending NGN want recipients to receive USDC or XLM seamlessly. The settlement contract must interact directly with Stellar Asset Contracts.
- **Required Work:** Call Soroban SAC token interface (`token::Client`) for balance queries, token transfers, and automated swaps against liquidity pools.
- **Acceptance Criteria:** Settlement contract executes cross-contract token transfer and swap atomically within a single invocation.
- **Labels:** `soroban, cross-contract, sac, liquidity, difficulty: high, points: 200`

---

## Category 2: Stellar Ecosystem Proposals (SEPs) & Anchor Integrations

### Issue 16: Implement SEP-1 `stellar.toml` Discovery and Auto-Validation Route
- **Target Area:** `apps/api/src/routes/wellKnown.routes.js`, `.well-known/stellar.toml`
- **Problem:** SendAm cannot be discovered by Stellar wallets and ecosystem tools because it lacks a standard `/.well-known/stellar.toml` file declaring federation, SEP-10, and org details.
- **Required Work:** Serve dynamically configured `stellar.toml` with CORS enabled; validate format against Stellar TOML specifications; expose admin endpoint to test validity.
- **Acceptance Criteria:** `curl https://<domain>/.well-known/stellar.toml` returns valid TOML declaring `NETWORK_PASSPHRASE`, `SIGNING_KEY`, `WEB_AUTH_ENDPOINT`, and currency definitions.
- **Labels:** `stellar, sep-1, toml, ecosystem, difficulty: trivial, points: 100`

### Issue 17: Implement Complete SEP-10 Web Authentication Challenge-Response Flow
- **Target Area:** `apps/api/src/services/sep10.service.js`, `apps/api/src/routes/auth.routes.js`
- **Problem:** While `Sep10Challenge` model exists in Prisma, the full SEP-10 challenge creation, validation, and JWT session minting flow is not exposed to external wallets.
- **Required Work:** Build standard endpoints: `GET /auth` (issues challenge transaction) and `POST /auth` (validates client signature and returns JWT); enforce single-use replay protection.
- **Acceptance Criteria:** Standard Stellar clients (Freighter, Albedo, CLI) can authenticate against SendAm endpoints conforming to SEP-10 specification.
- **Labels:** `security, sep-10, authentication, stellar, difficulty: high, points: 200`

### Issue 18: Add SEP-10 Client Token Refresh, Expiry Invalidation, and Network Domain Binding
- **Target Area:** `apps/api/src/services/sep10.service.js`
- **Problem:** Expired or compromised SEP-10 tokens cannot be revoked dynamically, and challenges do not strictly enforce `HOME_DOMAIN` client attribution.
- **Required Work:** Bind issued challenges to `home_domain` and client domain; store token hash in Redis with TTL; implement token revocation endpoint.
- **Acceptance Criteria:** Tokens signed for wrong home domain are rejected; revoked tokens fail authorization immediately.
- **Labels:** `security, sep-10, token, difficulty: medium, points: 150`

### Issue 19: Implement SEP-12 KYC API Client for Customer Identity Data Submission
- **Target Area:** `apps/api/src/services/sep12.client.js`
- **Problem:** To utilize licensed Stellar anchors for off-ramping to African bank accounts, SendAm must programmatically submit user KYC fields to the anchor via SEP-12.
- **Required Work:** Implement SEP-12 client supporting `GET /customer` and `PUT /customer`; map SendAm `KycProfile` fields (first name, last name, ID type, number) to SEP-12 format.
- **Acceptance Criteria:** Client successfully queries customer status and submits KYC data returning customer ID from test anchor.
- **Labels:** `stellar, sep-12, kyc, anchors, difficulty: high, points: 200`

### Issue 20: Implement SEP-24 Interactive Deposit and Withdrawal Flow for Fiat On/Off Ramps
- **Target Area:** `apps/api/src/services/sep24.client.js`, `apps/api/src/routes/sep24.routes.js`
- **Problem:** Users wanting to deposit local fiat or withdraw Stellar assets to cash cannot access anchor webviews directly through WhatsApp.
- **Required Work:** Implement SEP-24 client initiating interactive deposit/withdraw sessions; generate short URL sent to user via WhatsApp message to complete payment details in browser.
- **Acceptance Criteria:** User receives interactive link; completes anchor flow; anchor posts transaction confirmation to callback route.
- **Labels:** `stellar, sep-24, on-ramp, off-ramp, difficulty: high, points: 200`

### Issue 21: Add SEP-24 Transaction Status Polling and Webhook Event Callback Handlers
- **Target Area:** `apps/api/src/jobs/sep24Poll.job.js`
- **Problem:** Once a user begins an interactive SEP-24 flow, SendAm must monitor anchor progress (`pending_user_transfer_start`, `completed`, etc.) and notify the user.
- **Required Work:** Build a background worker polling `/transaction` endpoint for active SEP-24 operations; update database status; send WhatsApp progress updates.
- **Acceptance Criteria:** Transitions through all SEP-24 lifecycle states are tracked; terminal states (`completed`, `error`) trigger appropriate customer notifications.
- **Labels:** `backend, sep-24, background-worker, difficulty: medium, points: 150`

### Issue 22: Implement SEP-31 Cross-Border Payment Rail Adapter for Receiving Anchors
- **Target Area:** `apps/api/src/services/sep31.client.js`
- **Problem:** SendAm cannot execute direct B2B cross-border payments with recipient bank disbursement without integrating the SEP-31 Cross-Border Payments protocol.
- **Required Work:** Implement SEP-31 API adapter: query `/info`, create transaction with sender/receiver SEP-12 customer IDs and payout asset; submit Stellar payment to anchor address with memo.
- **Acceptance Criteria:** Successfully initiates and completes testnet cross-border remittance through SEP-31 anchor mock.
- **Labels:** `stellar, sep-31, remittance, payments, difficulty: high, points: 200`

### Issue 23: Add SEP-38 RFQ and Firm Quote Engine Integration for Corridor Conversions
- **Target Area:** `apps/api/src/services/sep38.client.js`, `apps/api/src/pricing/quote.service.js`
- **Problem:** SendAm calculates corridor quotes using third-party APIs instead of binding quotes directly from the Stellar anchors executing the settlement.
- **Required Work:** Implement SEP-38 client querying `/prices` and `/quote` endpoints; obtain guaranteed firm quotes with expiration timestamps for trade execution.
- **Acceptance Criteria:** User receives guaranteed quote locked for 60 seconds; payment orchestrator executes trade within quote validity window.
- **Labels:** `stellar, sep-38, quotes, fx, difficulty: high, points: 200`

### Issue 24: Implement SEP-6 Programmatic Deposit and Withdrawal Rails for Legacy Anchors
- **Target Area:** `apps/api/src/services/sep6.client.js`
- **Problem:** Some partner financial institutions in developing markets only support non-interactive SEP-6 endpoints for mobile money disbursements (e.g. M-Pesa, MTN Mobile Money).
- **Required Work:** Implement SEP-6 programmatic client querying `/deposit` and `/withdraw` with required payment destination parameters (phone, bank account).
- **Acceptance Criteria:** Successfully submits programmatic withdrawal request and handles instructions/memo response.
- **Labels:** `stellar, sep-6, mobile-money, difficulty: medium, points: 150`

### Issue 25: Implement Stellar Federation Server (SEP-2) Mapping `phone*sendam.io` to Stellar Addresses
- **Target Area:** `apps/api/src/routes/federation.routes.js`
- **Problem:** External Stellar wallets cannot send payments to SendAm users using human-readable federation addresses (e.g. `+2348012345678*sendam.io`).
- **Required Work:** Implement SEP-2 federation lookup endpoint responding to `GET /federation?q=...&type=name`; return public key and memo for requested phone alias.
- **Acceptance Criteria:** Querying standard federation endpoint returns valid JSON with `account_id` and optional `memo`; returns 404 for unknown users.
- **Labels:** `stellar, sep-2, federation, ux, difficulty: medium, points: 150`

### Issue 26: Add Anchor Directory Registry with Dynamic Corridor Capability Health Checks
- **Target Area:** `apps/api/src/services/anchorRegistry.service.js`
- **Problem:** If a partner anchor experiences downtime, payment flows fail abruptly without fallback to alternative corridors or anchors.
- **Required Work:** Maintain registry of approved anchors with periodic health checks (`GET /info`); automatically route corridors away from degraded anchors.
- **Acceptance Criteria:** Degraded anchors are marked inactive; payment orchestrator falls back to secondary rail or informs user before payment attempt.
- **Labels:** `backend, anchors, resilience, difficulty: medium, points: 150`

### Issue 27: Implement SEP-30 Recovery Signer Support for Direct Custody Key Recovery
- **Target Area:** `apps/api/src/services/sep30.client.js`
- **Problem:** If a user loses access to their phone or custody keys, there is no standardized recovery protocol to regain access to account funds.
- **Required Work:** Implement SEP-30 Recovery Signer client allowing users to register recovery identities and execute multi-party threshold signature recovery.
- **Acceptance Criteria:** Account can be recovered by providing required recovery credentials verified by recovery signers.
- **Labels:** `stellar, sep-30, recovery, security, difficulty: high, points: 200`

### Issue 28: Add Automated Anchor Mock Test Server for Local SEP-10/24/31/38 Development
- **Target Area:** `apps/api/test/mocks/anchorServer.js`
- **Problem:** Developers cannot test full SEP end-to-end flows locally without external network access to live testnet anchors.
- **Required Work:** Build an in-memory Express mock server implementing SEP-10 challenge issuance, SEP-24 webview simulation, SEP-31 remittance, and SEP-38 quotes.
- **Acceptance Criteria:** Full automated test suite runs offline against local anchor mock server with 100% determinism.
- **Labels:** `testing, mocks, anchors, dev-experience, difficulty: medium, points: 150`

---

## Category 3: Wallet Engine, Key Custody & KMS Security

### Issue 29: Integrate AWS KMS Provider for Versioned Envelope Encryption of Private Keys
- **Target Area:** `apps/api/src/services/kms/awsKms.provider.js`
- **Problem:** `crypto.service.js` has a local provider abstraction, but no real AWS KMS client implementing `generateDataKey` and `decryptDataKey` using remote master keys (CMK).
- **Required Work:** Implement AWS KMS provider with `@aws-sdk/client-kms`; encrypt local data encryption keys (DEK); store key ID and ciphertext in database.
- **Acceptance Criteria:** Master encryption keys never exist on SendAm servers; secret decryption calls AWS KMS with IAM policy validation.
- **Labels:** `security, kms, aws, encryption, difficulty: high, points: 200`

### Issue 30: Add HashiCorp Vault Transit Engine Integration for Zero-Exposure Key Decryption
- **Target Area:** `apps/api/src/services/kms/vaultTransit.provider.js`
- **Problem:** For self-hosted and multi-cloud production deployments, AWS KMS creates vendor lock-in. A HashiCorp Vault Transit secret engine provider is needed.
- **Required Work:** Implement Vault Transit provider using official Vault API; delegate encryption/decryption of private keys to Vault service.
- **Acceptance Criteria:** Integration tests verify round-trip encryption/decryption against local Vault container with token renewal.
- **Labels:** `security, vault, kms, multi-cloud, difficulty: high, points: 200`

### Issue 31: Implement Automated Key Rotation Worker with Resumable Batch Re-Encryption
- **Target Area:** `apps/api/src/services/secret-rotation.service.js`, `apps/api/src/jobs/keyRotation.job.js`
- **Problem:** When an encryption key is rotated to a new version, thousands of stored customer wallets must be re-encrypted without downtime or risk of partial failure.
- **Required Work:** Implement batch rotation worker reading wallets with old `keyVersion`; decrypting with old key and re-encrypting with `CURRENT_VERSION`; supporting checkpoint resume.
- **Acceptance Criteria:** Script re-encrypts 10,000 wallets in batches of 100; survives process interruption and resumes from last processed ID.
- **Labels:** `backend, security, rotation, jobs, difficulty: medium, points: 150`

### Issue 32: Replace In-Memory Decryption with Hardware Security Module (HSM) Signing Service
- **Target Area:** `apps/api/src/wallet/hsmSigner.js`
- **Problem:** Decrypting private keys into Node.js heap memory poses vulnerability risks in the event of memory dumps or remote code execution.
- **Required Work:** Implement remote signing client that sends transaction hashes to an isolated signing service/HSM, returning Ed25519 signatures without exporting private keys.
- **Acceptance Criteria:** Transactions are signed without raw private keys ever residing in API process memory.
- **Labels:** `security, hsm, ed25519, signing, difficulty: high, points: 200`

### Issue 33: Add Stellar Muxed Account (`MED25519`) Routing for Virtual Sub-Wallets
- **Target Area:** `apps/api/src/wallet/muxedAccounts.js`
- **Problem:** Generating a separate on-chain base account for every user requires funding base reserves (1 XLM + trustlines). Muxed accounts allow pooling under master accounts.
- **Required Work:** Implement muxed address encoding/decoding (`M...`) with 64-bit user sub-account IDs; route incoming payments to user balances based on muxed ID.
- **Acceptance Criteria:** Users can receive funds on unique `MED25519` addresses; deposit listener accurately credits user balance based on sub-account ID.
- **Labels:** `stellar, muxed-accounts, wallet, efficiency, difficulty: medium, points: 150`

### Issue 34: Implement Multi-Signature Quorum Policy (2-of-3) for High-Value Transactions
- **Target Area:** `apps/api/src/wallet/multisig.js`
- **Problem:** Transactions exceeding compliance thresholds (e.g. > $1,000) are signed with single keys, creating vulnerability to internal compromise.
- **Required Work:** Configure Stellar account thresholds (low, medium, high) and add platform compliance signer and operator signer; require 2-of-3 signatures for high-tier transfers.
- **Acceptance Criteria:** Low-value transfers execute with single key; transfers over threshold require two valid signatures before submission succeeds.
- **Labels:** `stellar, multisig, security, compliance, difficulty: high, points: 200`

### Issue 35: Build Cryptographic Seed Backup and Passphrase Mnemonic Recovery Engine
- **Target Area:** `apps/api/src/wallet/mnemonic.service.js`
- **Problem:** Users who want to export their wallet to another Stellar app (e.g. Lobstr, Freighter) cannot currently generate standard BIP-39 12-word recovery phrases.
- **Required Work:** Implement BIP-39 mnemonic generation and derivation; provide secure, one-time export API gated by PIN and SMS verification.
- **Acceptance Criteria:** Generates valid 12-word English mnemonic compatible with standard Stellar derivation path; logs export event in audit log.
- **Labels:** `wallet, bip39, export, custody, difficulty: medium, points: 150`

### Issue 36: Enforce Stellar Minimum Balance (Base Reserve + Trustline Subentries) Calculation
- **Target Area:** `apps/api/src/wallet/balanceCalculator.js`
- **Problem:** Sending maximum balance without reserving minimum on-chain balance causes transaction failure with `op_underfunded`.
- **Required Work:** Calculate available spendable balance: `totalBalance - (2 + numSubentries) * baseReserve - fee`; display spendable balance clearly to users.
- **Acceptance Criteria:** Users cannot initiate payments exceeding spendable balance; prevents failed transaction submissions due to base reserve violations.
- **Labels:** `stellar, balance, calculations, ux, difficulty: trivial, points: 100`

### Issue 37: Implement Trustline Auto-Establishment for Asset Corridors (USDC, EURC, NGNT)
- **Target Area:** `apps/api/src/wallet/trustlines.js`
- **Problem:** When a user receives an asset for the first time, the transaction fails if the account has not established a trustline to the asset issuer.
- **Required Work:** Build trustline manager checking existing trustlines via Horizon; automatically submit `ChangeTrustOperation` with fee-bump before asset transfer.
- **Acceptance Criteria:** Automatically detects missing trustline and creates it seamlessly; handles insufficient XLM base reserve gracefully.
- **Labels:** `stellar, trustlines, assets, automation, difficulty: medium, points: 150`

### Issue 38: Add Private Key Redaction and Memory Zeroing via `Buffer.fill(0)` on Garbage Collection
- **Target Area:** `apps/api/src/utils/securityMemory.js`
- **Problem:** Sensitive buffers holding decrypted secret keys or PINs remain in Node.js V8 heap until garbage collection, leaving a window for memory scraping.
- **Required Work:** Wrap sensitive secret handling in disposable structures; immediately invoke `buf.fill(0)` after signature generation is complete.
- **Acceptance Criteria:** Automated memory test verifies buffers are zeroed immediately after signing; secret strings do not linger in heap snapshots.
- **Labels:** `security, memory, hardening, v8, difficulty: medium, points: 150`

### Issue 39: Implement Emergency Fund Freezing and Revocation Mechanism for Compromised Wallets
- **Target Area:** `apps/api/src/wallet/emergencyFreeze.js`
- **Problem:** In the event of reported phone theft or unauthorized account access, operators need an immediate mechanism to freeze wallet activity and rotate signer keys.
- **Required Work:** Implement emergency freeze endpoint: sets signer weight to 0, adds platform recovery signer with weight 1, and cancels pending transactions.
- **Acceptance Criteria:** Compromised account cannot submit transactions; existing funds are secured under platform recovery key until ownership re-verified.
- **Labels:** `security, emergency, operations, difficulty: high, points: 200`

### Issue 40: Build Ephemeral Hot Wallet Pool with Automated Replenishment from Cold Storage
- **Target Area:** `apps/api/src/wallet/hotWalletPool.js`
- **Problem:** Funding all user accounts from a single hot wallet exposes high liquidity to operational risk if the hot wallet key is compromised.
- **Required Work:** Maintain a pool of low-balance hot wallets; automatically trigger multi-sig replenishment transactions when liquidity dips below safety threshold.
- **Acceptance Criteria:** Hot wallets maintain capped balances (e.g. < 500 XLM); automated alerts fire on low liquidity.
- **Labels:** `wallet, liquidity, security, operations, difficulty: medium, points: 150`

### Issue 41: Add Deterministic Key Derivation (BIP-44 / SLIP-0010) for Stellar Path `m/44'/148'/0'`
- **Target Area:** `apps/api/src/wallet/hdWallet.js`
- **Problem:** Generating individual random keypairs creates high backup complexity. Deterministic derivation allows restoring accounts from a single master seed.
- **Required Work:** Implement SLIP-0010 Ed25519 HD derivation for path `m/44'/148'/<account>'`; derive child keypairs dynamically.
- **Acceptance Criteria:** Generates identical keypairs matching official Stellar HD wallet test vectors.
- **Labels:** `stellar, hd-wallet, derivation, bip44, difficulty: medium, points: 150`

### Issue 42: Implement WebAuthn Passkey Signing Adapter for Direct Customer Custody
- **Target Area:** `apps/api/src/wallet/passkeyAdapter.js`
- **Problem:** Users who prefer complete self-custody over managed custody should be able to authorize transfers using FaceID/TouchID on mobile.
- **Required Work:** Integrate WebAuthn challenge generation and secp256r1 signature validation against Soroban smart wallet accounts.
- **Acceptance Criteria:** User authorizes payment on mobile web passkey prompt; signature verified on-chain without backend storing secrets.
- **Labels:** `webauthn, passkeys, self-custody, mobile, difficulty: high, points: 200`

---

## Category 4: WhatsApp Conversational Interface & Voice Pipeline

### Issue 43: Implement HMAC-SHA256 Webhook Signature Verification (`X-Hub-Signature-256`)
- **Target Area:** `apps/api/src/middlewares/verifyMetaWebhook.js`
- **Problem:** WhatsApp inbound webhooks must be cryptographically verified against `WHATSAPP_APP_SECRET`. Unverified endpoints allow spoofing fake payment messages.
- **Required Work:** Implement raw-body HMAC-SHA256 verification checking `X-Hub-Signature-256` header using `crypto.timingSafeEqual`.
- **Acceptance Criteria:** Valid Meta signatures pass; forged or missing signatures receive 401 Unauthorized and are dropped with security alert.
- **Labels:** `security, whatsapp, webhook, authentication, difficulty: medium, points: 150`

### Issue 44: Implement Meta Graph API 24-Hour Customer Care Window Tracker and Template Fallback
- **Target Area:** `apps/api/src/services/whatsapp.service.js`
- **Problem:** Meta rejects free-form text messages if more than 24 hours have elapsed since the user's last inbound message. Outbound notifications fail silently.
- **Required Work:** Track `lastUserInboundAt` in Redis; if window > 24 hours, automatically dispatch registered Meta WhatsApp message templates instead of free text.
- **Acceptance Criteria:** System routes outbound notifications through approved templates when outside 24h window; logs template message status.
- **Labels:** `whatsapp, templates, messaging, compliance, difficulty: medium, points: 150`

### Issue 45: Build Interactive WhatsApp List Messages and Quick Reply Button Builders
- **Target Area:** `apps/api/src/whatsapp/interactivePayloads.js`
- **Problem:** All outgoing messages currently use plain text strings, forcing users to type numbers or words manually instead of tapping interactive buttons.
- **Required Work:** Implement builders for interactive WhatsApp payloads: Quick Reply buttons (e.g. `[Confirm Payment]`, `[Cancel]`) and List Menus (e.g. Corridor selection).
- **Acceptance Criteria:** Interactive payloads render native WhatsApp buttons; user taps trigger callback payloads parsed accurately by inbound router.
- **Labels:** `whatsapp, interactive, ui, ux, difficulty: medium, points: 150`

### Issue 46: Integrate Deepgram Voice Note Streaming Transcription Pipeline with Audio Normalization
- **Target Area:** `apps/api/src/voice/deepgram.service.js`
- **Problem:** WhatsApp audio notes (`.ogg` Opus format) sent by users must be downloaded from Meta Graph CDN, converted, and transcribed with low latency.
- **Required Work:** Download audio with correlation ID; stream directly to Deepgram Nova-2 API; return transcript text and confidence score in < 2 seconds.
- **Acceptance Criteria:** Audio note transcription completes in under 2 seconds; handles low-bitrate voice notes with accurate word error rates.
- **Labels:** `voice, deepgram, ai, transcription, difficulty: high, points: 200`

### Issue 47: Implement Local Whisper Transcription Fallback for Audio Note Intent Extraction
- **Target Area:** `apps/api/src/voice/whisperFallback.service.js`
- **Problem:** If Deepgram experiences an outage or API rate limiting, voice note processing halts completely, breaking voice-to-cash functionality.
- **Required Work:** Implement local fallback to lightweight Whisper (or self-hosted OpenAI-compatible endpoint); automatically switch on Deepgram 5xx errors.
- **Acceptance Criteria:** Voice notes automatically transcribe via fallback during simulated primary API outage.
- **Labels:** `voice, whisper, resilience, fallback, difficulty: medium, points: 150`

### Issue 48: Build Natural Language Intent Parser for Multilingual African Corridors (Pidgin, Hausa, Yoruba, Swahili)
- **Target Area:** `apps/api/src/voice/intentParser.js`
- **Problem:** Users dictate payments in regional vernacular (e.g. "Send two k to Emeka", "Ba Aminu dubu biyar", "Transfer 50 cedis"). Standard parsers fail.
- **Required Work:** Implement intent and entity extraction parser recognizing regional slang, currency keywords (`k`, `quid`, `dubu`, `naira`, `cedis`), and contact names.
- **Acceptance Criteria:** Successfully parses 50 sample regional phrases into structured JSON: `{ action: 'SEND', amount: 2000, currency: 'NGN', recipient: 'Emeka' }`.
- **Labels:** `nlp, voice, internationalization, ux, difficulty: high, points: 200`

### Issue 49: Implement Voice Note Biometric Speaker Identification and Anti-Spoofing Check
- **Target Area:** `apps/api/src/voice/speakerVerification.js`
- **Problem:** Fraudsters could forward a user's forwarded voice note or synthesize AI voices to initiate unauthorized payment transfers.
- **Required Work:** Compare incoming voice embedding against enrolled user voice profile; verify minimum confidence threshold before prompting for PIN.
- **Acceptance Criteria:** Voice notes from mismatched speakers trigger security challenge; prevents replay attacks.
- **Labels:** `voice, biometrics, security, fraud, difficulty: high, points: 200`

### Issue 50: Build Conversational Finite State Machine (FSM) with Redis Session Persistence
- **Target Area:** `apps/api/src/whatsapp/conversationFsm.js`
- **Problem:** Multi-step conversational flows (e.g. Onboarding -> Enter Amount -> Pick Corridor -> Enter PIN) stored in memory crash if the server restarts.
- **Required Work:** Build an FSM with states (`IDLE`, `AWAITING_AMOUNT`, `AWAITING_CONFIRMATION`, `AWAITING_PIN`); persist state and session context in Redis with 10-minute TTL.
- **Acceptance Criteria:** User state is preserved across server restarts; session expires cleanly after inactivity with informative resume prompt.
- **Labels:** `backend, fsm, redis, state-management, difficulty: high, points: 200`

### Issue 51: Add Fuzzy Contact Name Resolution and Phonebook Alias Matching in Chat Flow
- **Target Area:** `apps/api/src/services/contactMatcher.js`
- **Problem:** Users often misspell contact names in chat or voice notes (e.g. "Send to Chisom" vs saved contact "Chizom").
- **Required Work:** Implement Levenshtein / Jaro-Winkler fuzzy matching against user's saved contacts; if confidence > 85%, ask confirmation; if ambiguous, present List Picker.
- **Acceptance Criteria:** Matches slightly misspelled names; prompts user to disambiguate when multiple contacts match closely.
- **Labels:** `nlp, contacts, search, ux, difficulty: medium, points: 150`

### Issue 52: Implement Interactive WhatsApp PIN Entry Flow with Masked Asterisk Feedback
- **Target Area:** `apps/api/src/whatsapp/pinFlow.js`
- **Problem:** Asking users to type their raw 4-digit PIN in plain WhatsApp chat leaves PINs visible in chat history on their phone screen.
- **Required Work:** Provide option for ephemeral one-time PIN web token or immediately delete/overwrite plain text PIN prompt; confirm entry with masked string (`****`).
- **Acceptance Criteria:** PIN is never stored unhashed in logs or database; guidance sent to user to delete message from chat.
- **Labels:** `security, whatsapp, pin, privacy, difficulty: medium, points: 150`

### Issue 53: Add Audio Receipt Generation and Outbound Voice Note Confirmation Dispatch
- **Target Area:** `apps/api/src/voice/voiceReceipt.js`
- **Problem:** For illiterate or visually impaired users in rural communities, text-based receipts are unusable.
- **Required Work:** Implement Text-to-Speech (TTS) pipeline generating 10-second audio receipt ("Your payment of 5000 Naira to Musa has been delivered on Stellar"); send as WhatsApp voice note.
- **Acceptance Criteria:** Outbound voice note receipt is generated and delivered within 5 seconds of transaction confirmation on Stellar.
- **Labels:** `voice, tts, accessibility, receipts, difficulty: medium, points: 150`

### Issue 54: Implement WhatsApp Inbound Message De-Duplication with Redis TTL Cache
- **Target Area:** `apps/api/src/middlewares/dedupMessages.js`
- **Problem:** Meta webhooks periodically deliver duplicate webhook events when HTTP 200 responses are delayed, causing duplicate payment intents.
- **Required Work:** Cache `entry[0].changes[0].value.messages[0].id` in Redis using `SET key 1 NX EX 300`; return 200 OK immediately if message ID was already seen.
- **Acceptance Criteria:** Duplicate inbound messages delivered within 5 minutes are processed exactly once; zero duplicate charges.
- **Labels:** `backend, redis, idempotency, whatsapp, difficulty: trivial, points: 100`

### Issue 55: Build Conversational Disambiguation Flow for Ambiguous Transfer Amounts and Corridors
- **Target Area:** `apps/api/src/whatsapp/disambiguation.js`
- **Problem:** When a user types "Send 50", it is ambiguous whether they mean 50 USD, 50 NGN, or 50 GHS.
- **Required Work:** Detect ambiguous currency and amount intents; prompt user with quick buttons: `[50 USD ($)]`, `[50,000 NGN (₦)]`, `[50 GHS (₵)]`.
- **Acceptance Criteria:** Ambiguous inputs trigger clarification dialog before creating payment quotes.
- **Labels:** `whatsapp, ux, validation, difficulty: trivial, points: 100`

### Issue 56: Implement Automated Customer Support Escalation and Human Agent Handoff via WhatsApp
- **Target Area:** `apps/api/src/support/agentHandoff.js`
- **Problem:** When the bot fails to understand a user three times in a row, the user gets frustrated with no path to human support.
- **Required Work:** Track consecutive unrecognized intents; pause bot automation for that phone number; notify support dashboard and create ticket in `SupportCase` model.
- **Acceptance Criteria:** User typing "help" or failing 3 times is paused from bot and assigned to admin queue; bot resumes when ticket is closed.
- **Labels:** `support, operations, customer-service, difficulty: medium, points: 150`

---

## Category 5: Compliance, KYC, AML & Risk Decisioning

### Issue 57: Integrate Smile ID / Dojah API for Tier-1 BVN and NIN Verification in Nigeria
- **Target Area:** `apps/api/src/compliance/providers/smileId.js`
- **Problem:** Users in Nigeria cannot graduate from Tier 0 (unverified, low limit) to Tier 1 without automated Bank Verification Number (BVN) / National Identity Number (NIN) validation.
- **Required Work:** Implement verification client sending hashed BVN/NIN to Smile ID/Dojah; match name and DOB against user account; store verification reference.
- **Acceptance Criteria:** Valid BVN elevates user to Tier 1 instantly; mismatched or invalid credentials are rejected with audit log entry.
- **Labels:** `compliance, kyc, nigeria, bvn, difficulty: high, points: 200`

### Issue 58: Integrate Ghana Card and Kenya ID Automated Verification for Pan-African Corridors
- **Target Area:** `apps/api/src/compliance/providers/ghanaKenyaKyc.js`
- **Problem:** Non-Nigerian users in Ghana and Kenya cannot complete automated KYC verification, blocking cross-border corridors.
- **Required Work:** Implement identity verification adapters for Ghana Card and Kenyan National ID via approved regional KYC provider.
- **Acceptance Criteria:** Ghana and Kenya users can verify identities via WhatsApp upload or web prompt, elevating account limits.
- **Labels:** `compliance, kyc, ghana, kenya, difficulty: high, points: 200`

### Issue 59: Implement Automated OFAC, UN, and PEP Sanctions Screening for Senders and Receivers
- **Target Area:** `apps/api/src/compliance/sanctionsScreening.js`
- **Problem:** Financial compliance regulations require screening counterparty names against international sanctions lists before broadcasting blockchain transactions.
- **Required Work:** Screen user names against OpenSanctions / Dow Jones API prior to payment execution; flag exact and fuzzy phonetic matches (Soundex/Metaphone).
- **Acceptance Criteria:** Flagged PEP/Sanctions hits immediately suspend transaction for compliance review and notify compliance officer.
- **Labels:** `compliance, aml, sanctions, legal, difficulty: high, points: 200`

### Issue 60: Build Real-Time Transaction Velocity and Volume Limit Engine Across KYC Tiers
- **Target Area:** `apps/api/src/compliance/velocityLimits.js`
- **Problem:** Fraudsters can drain wallets or execute money laundering via rapid micro-transactions without hitting per-transaction maximum caps.
- **Required Work:** Enforce rolling limits: Tier 0 ($50/day, max 2 tx/hr), Tier 1 ($500/day, max 5 tx/hr), Tier 2 ($5,000/day); check Redis sliding window before authorization.
- **Acceptance Criteria:** Transactions exceeding hourly velocity or 24-hour cumulative limit are rejected with informative upgrade prompt.
- **Labels:** `compliance, limits, fraud-prevention, redis, difficulty: medium, points: 150`

### Issue 61: Implement Suspicious Activity Reporting (SAR) Automated Detection and Audit Flagging
- **Target Area:** `apps/api/src/compliance/sarDetection.js`
- **Problem:** Structuring (smurfing) transactions just below reporting thresholds ($9,900) must be automatically detected for regulatory filing.
- **Required Work:** Implement rule-based detection analyzing user transfer patterns over 7-day windows; automatically generate SAR draft report in database.
- **Acceptance Criteria:** Suspicious patterns (rapid multiple transactions under threshold) automatically trigger SAR draft and compliance alert.
- **Labels:** `compliance, sar, aml, reporting, difficulty: medium, points: 150`

### Issue 62: Add Secure PIN Hashing with Argon2id, Memory Cost Tuning, and Per-User Salt
- **Target Area:** `apps/api/src/services/pin.service.js`
- **Problem:** Some PIN hashes still rely on legacy algorithms or generic scrypt configs without standardized Argon2id memory-hardness parameters.
- **Required Work:** Implement Argon2id hashing with recommended OWASP parameters (memoryCost: 65536 KiB, timeCost: 3, parallelism: 1); auto-upgrade old hashes on successful login.
- **Acceptance Criteria:** PINs are hashed using Argon2id; verification timing is safe against side-channel analysis; legacy hashes upgrade seamlessly.
- **Labels:** `security, argon2, passwords, hashing, difficulty: medium, points: 150`

### Issue 63: Implement Exponential Lockout Policy and Notification Alerting for Failed PIN Attempts
- **Target Area:** `apps/api/src/compliance/pinLockout.js`
- **Problem:** Repeated brute force attacks against a user's 4-digit PIN can compromise the account if lockout delays are insufficient.
- **Required Work:** Lock account for 5 mins after 3 failed attempts, 30 mins after 5 attempts, and require manual operator unlock after 7 attempts; send security alert SMS/WhatsApp.
- **Acceptance Criteria:** Exponential delays enforced; locked accounts reject all PIN verification attempts until cooldown period expires.
- **Labels:** `security, brute-force, pin, difficulty: trivial, points: 100`

### Issue 64: Build Privacy-Compliant User Erasure (GDPR / NDPR) Pipeline with Cryptographic Tombstoning
- **Target Area:** `apps/api/src/services/userErasure.service.js`
- **Problem:** When a user requests account deletion under GDPR / NDPR, financial audit logs must be retained while personal data (phone, name, IP) must be irreversibly erased.
- **Required Work:** Implement erasure pipeline: anonymize `phoneNumber` to random hash, nullify WhatsApp name, delete unencrypted KYC files, and mark `anonymizedAt`.
- **Acceptance Criteria:** Personal data cannot be retrieved after erasure; transaction history remains mathematically sound for accounting audits.
- **Labels:** `privacy, gdpr, ndpr, compliance, difficulty: medium, points: 150`

### Issue 65: Implement Legal Hold Enforcement Freezing Deletion and Data Purges
- **Target Area:** `apps/api/src/compliance/legalHold.js`
- **Problem:** If a user under regulatory investigation or subpoena requests account deletion, the system must block erasure to prevent spoliation of evidence.
- **Required Work:** Check `legalHold: true` status in `User` model; explicitly reject erasure and data purge jobs; record attempt in audit log.
- **Acceptance Criteria:** User marked with legal hold cannot be deleted or anonymized by user or automated TTL jobs.
- **Labels:** `compliance, legal, security, difficulty: trivial, points: 100`

### Issue 66: Add Audit Log Cryptographic Chaining with SHA-256 Hashes for Non-Repudiation
- **Target Area:** `apps/api/src/compliance/auditChain.js`
- **Problem:** Database administrators could theoretically alter past audit log entries without detection unless records are cryptographically chained.
- **Required Work:** Each `AuditLog` entry stores `previousHash` and `currentHash = SHA256(previousHash + recordData + timestamp)`; provide verification utility.
- **Acceptance Criteria:** Verification script detects any modified, inserted, or deleted audit log row; guarantees tamper-evident record keeping.
- **Labels:** `security, audit, cryptography, non-repudiation, difficulty: medium, points: 150`

### Issue 67: Build Risk Scoring Machine Learning Feature Extractor for Geo-IP and Device Fingerprinting
- **Target Area:** `apps/api/src/compliance/riskEngine.js`
- **Problem:** Static risk scores do not adapt to suspicious indicators like Tor exit nodes, mismatched country codes, or high-risk IP subnets.
- **Required Work:** Extract features: IP risk score, country match between phone and IP, account age, transaction frequency; output dynamic risk score (0–100).
- **Acceptance Criteria:** Transactions with risk score > 80 require stepped-up authentication (PIN + OTP); risk score > 95 automatically blocks transfer.
- **Labels:** `compliance, risk-scoring, ml, security, difficulty: high, points: 200`

### Issue 68: Implement Compliance Document Storage with AES-256 Client-Side Encryption in S3
- **Target Area:** `apps/api/src/compliance/documentStorage.js`
- **Problem:** Uploaded passport/national ID images stored directly in S3 are vulnerable to cloud credential leaks.
- **Required Work:** Encrypt image bytes client-side before streaming to S3 using ephemeral per-file encryption keys; store metadata in encrypted DB columns.
- **Acceptance Criteria:** Raw files in S3 are unreadable ciphertexts; only decrypted on demand by authorized compliance officers.
- **Labels:** `security, s3, encryption, kyc, difficulty: medium, points: 150`

### Issue 69: Add Automated Daily/Monthly Tier Limit Reset Cron with Timezone Normalization
- **Target Area:** `apps/api/src/jobs/resetLimits.job.js`
- **Problem:** Daily transaction limit calculations using UTC cause limits to reset at unexpected local times (e.g. 1:00 AM West Africa Time).
- **Required Work:** Implement timezone-aware rolling window limit queries in PostgreSQL; avoid bulk midnight reset locks by evaluating sliding 24-hour windows.
- **Acceptance Criteria:** Limit calculations use sliding 24-hour windows instead of naive midnight truncation; performs fast indexed queries.
- **Labels:** `database, limits, cron, performance, difficulty: trivial, points: 100`

### Issue 70: Build Transaction Monitoring Dashboard with One-Click Regulatory CSV/PDF Export
- **Target Area:** `apps/api/src/admin/controllers/complianceExport.controller.js`
- **Problem:** Compliance officers must generate official regulatory transaction reports on short notice during financial audits.
- **Required Work:** Implement streaming export endpoint filtering by date, corridor, amount, and risk tier; generate formatted CSV and signed PDF reports.
- **Acceptance Criteria:** Streams 50,000 transaction records to CSV without running out of memory; includes all mandatory regulatory fields.
- **Labels:** `admin, reporting, compliance, streaming, difficulty: medium, points: 150`

---

## Category 6: Payment Orchestrator, FX Rates & Idempotency

### Issue 71: Implement Multi-Provider FX Rate Aggregator with Staleness Circuit Breaker
- **Target Area:** `apps/api/src/pricing/fxAggregator.js`
- **Problem:** Relying on a single FX provider (ExchangeRate-API) causes quote failures when the provider is down, or executes bad trades if rates are stale.
- **Required Work:** Query ExchangeRate-API, CoinGecko, and Binance P2P API in parallel; compute median rate; reject rates older than 60 seconds with circuit breaker.
- **Acceptance Criteria:** Rate engine falls back across providers seamlessly; rejects stale feeds and alerts operators.
- **Labels:** `pricing, fx, circuit-breaker, resilience, difficulty: medium, points: 150`

### Issue 72: Build Dynamic Corridor Fee and Margin Calculator with Floor/Cap Thresholds
- **Target Area:** `apps/api/src/pricing/feeCalculator.js`
- **Problem:** Fixed percentage fees result in negative margins on small micro-payments due to fixed Stellar network and off-ramp banking charges.
- **Required Work:** Implement tiered fee formula: `fee = clamp(amount * ratePercentage + baseCost, minFee, maxFee)`; support per-corridor fee rules.
- **Acceptance Criteria:** Margin is guaranteed positive on all transaction sizes; fee rules are configurable via admin API without redeploying code.
- **Labels:** `pricing, fees, business-logic, difficulty: trivial, points: 100`

### Issue 73: Implement Atomic Payment Idempotency Engine with Database Mutex Locking
- **Target Area:** `apps/api/src/payment/idempotency.js`
- **Problem:** If a user double-taps "Send" or the network retries a webhook, concurrent requests could execute two real Stellar payments.
- **Required Work:** Acquire database row-level lock (`SELECT ... FOR UPDATE`) or Redis Redlock on idempotency key; store transaction hash on completion.
- **Acceptance Criteria:** Concurrent requests with same idempotency key return identical transaction result; zero possibility of duplicate blockchain broadcast.
- **Labels:** `payment, idempotency, concurrency, postgres, difficulty: high, points: 200`

### Issue 74: Build Double-Entry Financial Accounting Ledger for System Clearing Accounts
- **Target Area:** `apps/api/src/payment/doubleEntryLedger.js`
- **Problem:** Simple balance columns cannot detect accounting discrepancies or internal database corruption without immutable credit/debit ledger entries.
- **Required Work:** Implement double-entry ledger table (`LedgerEntry` with `debitAccountId`, `creditAccountId`, `amount`, `currency`); ensure sum of all debits equals credits.
- **Acceptance Criteria:** Every money movement creates balanced debit and credit entries; invariant checker verifies zero ledger discrepancy daily.
- **Labels:** `payment, accounting, ledger, database, difficulty: high, points: 200`

### Issue 75: Implement Automated Stellar Payment Failure Detection and Instant Fiat Refund Dispatch
- **Target Area:** `apps/api/src/payment/refundEngine.js`
- **Problem:** If a Stellar payment fails after off-ramp fiat has been deducted (e.g. invalid memo or expired trustline), funds get stuck in limbo.
- **Required Work:** Catch Stellar Horizon rejection errors; immediately trigger reversal job in BullMQ; credit user balance and notify user on WhatsApp.
- **Acceptance Criteria:** Failed blockchain transactions trigger automatic internal balance refund within 3 seconds with user notification.
- **Labels:** `payment, refunds, error-handling, resilience, difficulty: medium, points: 150`

### Issue 76: Add Path Payment Strict Receive / Strict Send Router for Optimized Cross-Asset Swaps
- **Target Area:** `apps/api/src/payment/pathPaymentRouter.js`
- **Problem:** Converting NGN to GHS requires finding the cheapest liquidity path on Stellar (e.g. NGN -> XLM -> USDC -> GHS) rather than naive direct trades.
- **Required Work:** Query Horizon `/paths/strict-receive` and `/paths/strict-send`; select route with lowest slippage and transfer fee; construct `PathPaymentStrictReceiveOperation`.
- **Acceptance Criteria:** Automatically executes optimal multi-hop path payment on Stellar; limits maximum source amount to prevent slippage losses.
- **Labels:** `stellar, path-payment, dex, liquidity, difficulty: high, points: 200`

### Issue 77: Implement Stellar Transaction Memo Verification and Reconciliation Engine
- **Target Area:** `apps/api/src/payment/memoReconciliation.js`
- **Problem:** Deposits sent to exchange accounts or shared omnibus wallets with missing or malformed memos cannot be credited automatically.
- **Required Work:** Validate memo requirements per destination address; verify incoming memo against expected deposit reference; handle unmatched deposits in exception queue.
- **Acceptance Criteria:** Valid memos credit accounts instantly; missing/invalid memos route to admin reconciliation dashboard.
- **Labels:** `stellar, memos, reconciliation, operations, difficulty: medium, points: 150`

### Issue 78: Build Automated End-of-Day Ledger Reconciliation Worker against Horizon Ledger Closes
- **Target Area:** `apps/api/src/jobs/reconcileLedger.job.js`
- **Problem:** Discrepancies between local database transaction state and on-chain Stellar ledger history must be detected and resolved daily.
- **Required Work:** Fetch all closed transactions for platform accounts from Horizon for the preceding 24 hours; compare hashes and amounts with database records.
- **Acceptance Criteria:** Identifies missing, pending, or mismatched transactions; generates daily reconciliation audit report.
- **Labels:** `jobs, reconciliation, audit, stellar, difficulty: high, points: 200`

### Issue 79: Implement Split Payment and Multi-Recipient Batch Settlement Worker
- **Target Area:** `apps/api/src/payment/batchSettlement.js`
- **Problem:** Group payments (e.g. splitting a restaurant bill or payroll distribution) sent via individual transactions incur high fees and latency.
- **Required Work:** Build multi-payment transaction builder bundling up to 100 `PaymentOperation`s into a single Stellar transaction envelope.
- **Acceptance Criteria:** Bundles multiple transfers into single transaction; all recipients credited in one ledger close (~5 seconds).
- **Labels:** `stellar, batching, efficiency, payments, difficulty: medium, points: 150`

### Issue 80: Add Support for Scheduled and Recurring WhatsApp Payment Mandates
- **Target Area:** `apps/api/src/payment/recurringPayments.js`
- **Problem:** Users wanting to pay monthly bills or weekly family remittances must initiate transfers manually every time.
- **Required Work:** Implement scheduled payment worker; allow users to configure recurrence (daily, weekly, monthly) in WhatsApp; require PIN confirmation before initial schedule.
- **Acceptance Criteria:** Scheduled worker executes recurring payment on designated date; notifies user 24h prior with option to pause or cancel.
- **Labels:** `payment, recurring, automation, ux, difficulty: medium, points: 150`

### Issue 81: Build Real-Time Fee Rebate and Loyalty Cashback Calculation Engine
- **Target Area:** `apps/api/src/pricing/loyaltyRebate.js`
- **Problem:** Encouraging transaction volume requires incentive loops like fee discounts or XLM cashback for frequent cross-border remitters.
- **Required Work:** Track user 30-day transaction volume; calculate fee tier discount; credit cashback tokens or fee vouchers automatically.
- **Acceptance Criteria:** Eligible users receive automatic fee reduction at quote creation; cashback credited upon payment confirmation.
- **Labels:** `pricing, loyalty, rewards, growth, difficulty: trivial, points: 100`

### Issue 82: Implement Currency Rounding and Truncation Guard for Stellar Stroop Precision (7 Decimals)
- **Target Area:** `apps/api/src/utils/money.js`
- **Problem:** JavaScript floating-point math leads to precision errors (e.g. `0.1 + 0.2 = 0.30000000000000004`), causing Horizon transaction rejections.
- **Required Work:** Standardize money calculations using `BigNumber.js` or native `BigInt` stroop integers (1 XLM = 10,000,000 stroops); truncate cleanly to 7 decimal places.
- **Acceptance Criteria:** Comprehensive unit tests verify zero precision loss; transactions never fail due to invalid decimal place formatting.
- **Labels:** `utils, math, precision, bug-prevention, difficulty: trivial, points: 100`

---

## Category 7: Background Queues, Workers & Distributed Jobs

### Issue 83: Implement BullMQ Worker Concurrency Isolation and Graceful Shutdown Lifecycle
- **Target Area:** `apps/api/src/queues/queueManager.js`
- **Problem:** Deploying new backend versions while workers are processing payments can kill active transactions mid-flight, leaving state inconsistent.
- **Required Work:** Implement graceful shutdown hooks capturing `SIGTERM`/`SIGINT`; allow active jobs to finish processing within 30-second timeout; pause queue intake.
- **Acceptance Criteria:** Server shuts down cleanly without terminating active in-flight payment jobs; resumed workers pick up uncompleted jobs.
- **Labels:** `devops, queues, bullmq, graceful-shutdown, difficulty: medium, points: 150`

### Issue 84: Add Redis Cluster Connection Sentinel and Sentinel Failover Reconnection Logic
- **Target Area:** `apps/api/src/config/redis.js`
- **Problem:** A single Redis instance failure halts all BullMQ queues and WhatsApp webhook processing.
- **Required Work:** Configure ioredis Sentinel / Cluster support with automatic reconnection, heartbeat pinging, and exponential retry backoff.
- **Acceptance Criteria:** Queues survive master Redis node crash and failover to replica without dropping queued jobs.
- **Labels:** `infrastructure, redis, high-availability, difficulty: medium, points: 150`

### Issue 85: Implement Exponential Backoff with Jitter for Transient Network / Horizon Errors
- **Target Area:** `apps/api/src/queues/retryStrategy.js`
- **Problem:** Retrying failed Stellar requests immediately during Horizon rate limits (`429 Too Many Requests`) exacerbates network throttling.
- **Required Work:** Implement exponential backoff with full jitter formula: `sleep = rand(0, min(maxBackoff, baseBackoff * 2^attempt))`.
- **Acceptance Criteria:** Retry intervals spread across randomized windows; relieves pressure during Horizon rate limit events.
- **Labels:** `queues, resilience, backoff, algorithms, difficulty: trivial, points: 100`

### Issue 86: Build Dead-Letter Queue (DLQ) Monitoring and Automated Operator Re-Queue Service
- **Target Area:** `apps/api/src/queues/dlqManager.js`
- **Problem:** Jobs that fail after all retries are exhausted sit in failed state with no visibility for support engineers.
- **Required Work:** Move permanently failed jobs to Dead-Letter Queue; alert Slack/Discord webhook with error stack trace; provide admin CLI to inspect and re-queue.
- **Acceptance Criteria:** Failed jobs trigger operator alerts; admin can re-run fixed jobs with one click without database manipulation.
- **Labels:** `queues, dlq, monitoring, operations, difficulty: medium, points: 150`

### Issue 87: Implement Horizon Paging Cursor Persistence and Gapless Deposit Stream Recovery
- **Target Area:** `apps/api/src/jobs/deposits.jobs.js`
- **Problem:** If the deposit listener worker restarts, it must resume exactly from the last saved Horizon cursor without skipping transactions or duplicating deposits.
- **Required Work:** Store confirmed paging cursor atomically in PostgreSQL within the payment receipt transaction; resume from saved cursor on startup.
- **Acceptance Criteria:** Worker recovers from crash without missing deposits; duplicate webhooks or replay cursor calls do not double-credit users.
- **Labels:** `stellar, deposits, cursor, reliability, difficulty: high, points: 200`

### Issue 88: Build Outbound Webhook Delivery Dispatcher with Signature Verification for Partners
- **Target Area:** `apps/api/src/services/partnerWebhooks.js`
- **Problem:** B2B merchant partners receiving payments need automated webhooks dispatched to their backend endpoints when customer payments settle.
- **Required Work:** Build webhook dispatcher queue; sign payload with HMAC-SHA256 secret; retry up to 5 times with exponential backoff on non-200 responses.
- **Acceptance Criteria:** Webhook events delivered with signature header; logs delivery status and response latency in audit history.
- **Labels:** `backend, webhooks, b2b, integration, difficulty: medium, points: 150`

### Issue 89: Implement Background PDF Receipt Generation Worker with AWS S3 Presigned URL Dispatch
- **Target Area:** `apps/api/src/jobs/generateReceipt.job.js`
- **Problem:** Generating PDF receipts synchronously in HTTP request threads causes high CPU spikes and delays WhatsApp replies.
- **Required Work:** Offload PDF generation to background worker using PDFKit; upload to S3; generate short-lived presigned download URL (24h) sent via chat.
- **Acceptance Criteria:** PDF receipt generated and uploaded in background in < 1 second; link delivered to user via WhatsApp message.
- **Labels:** `jobs, pdf, s3, receipts, difficulty: medium, points: 150`

### Issue 90: Add Job Priority Queuing: Urgent Payment Submissions vs Deferred Bulk Notifications
- **Target Area:** `apps/api/src/queues/priorityQueues.js`
- **Problem:** Bulk marketing notifications or daily statement generation can saturate BullMQ worker pools, delaying urgent payment submissions.
- **Required Work:** Configure priority levels: Priority 1 (Payment Submission), Priority 2 (Webhook Intake), Priority 3 (Receipts), Priority 4 (Bulk Messaging).
- **Acceptance Criteria:** High-priority payment jobs process immediately even when thousands of low-priority notification jobs are queued.
- **Labels:** `queues, performance, prioritization, difficulty: trivial, points: 100`

### Issue 91: Implement BullMQ Queue Metrics Exporter for Redis Memory and Worker Latency
- **Target Area:** `apps/api/src/observability/queueMetrics.js`
- **Problem:** Operators cannot observe queue depth, job wait times, or worker starvation before customer complaints occur.
- **Required Work:** Expose Prometheus gauges: `bullmq_waiting_jobs_count`, `bullmq_active_jobs_count`, `bullmq_job_duration_seconds`.
- **Acceptance Criteria:** Queue metrics exported at `/metrics` endpoint; Grafana dashboard visualizes queue health in real time.
- **Labels:** `observability, prometheus, bullmq, metrics, difficulty: trivial, points: 100`

### Issue 92: Build Automated Stale Job Purge and Job History Archival Pipeline
- **Target Area:** `apps/api/src/jobs/purgeQueueHistory.job.js`
- **Problem:** Millions of completed job records retained in Redis consume expensive RAM and degrade Redis performance over time.
- **Required Work:** Implement daily cleanup job removing completed and failed job metadata older than 7 days using `queue.clean()`.
- **Acceptance Criteria:** Prevents Redis memory bloat; keeps Redis memory footprint below 200MB under continuous operation.
- **Labels:** `redis, maintenance, performance, cleanup, difficulty: trivial, points: 100`

---

## Category 8: Observability, Infrastructure, CI/CD & Security Hardening

### Issue 93: Implement OpenTelemetry Distributed Tracing for End-to-End WhatsApp-to-Stellar Lifecycle
- **Target Area:** `apps/api/src/observability/tracing.js`
- **Problem:** Debugging latency bottlenecks across WhatsApp webhook -> Deepgram voice -> Backend -> Horizon ledger submission requires distributed tracing.
- **Required Work:** Instrument Express, BullMQ, Prisma, and `@stellar/stellar-sdk` with OpenTelemetry NodeSDK; propagate `traceparent` headers.
- **Acceptance Criteria:** Single distributed trace visualizes timeline from inbound WhatsApp webhook to on-chain Stellar transaction confirmation.
- **Labels:** `observability, opentelemetry, tracing, performance, difficulty: high, points: 200`

### Issue 94: Add Prometheus Metrics for Stellar Submission Latency, Ledger Failures, and Gas Costs
- **Target Area:** `apps/api/src/observability/stellarMetrics.js`
- **Problem:** Lack of real-time monitoring for Stellar network fee spikes, Horizon latency, or error code distribution (`tx_bad_auth`, `tx_insufficient_balance`).
- **Required Work:** Expose Prometheus metrics: `stellar_tx_submission_duration_seconds`, `stellar_tx_result_total{result="success|fail"}`, `stellar_base_fee_stroops`.
- **Acceptance Criteria:** `/metrics` endpoint exports Stellar metrics scraped by Prometheus; alerts trigger if failure rate exceeds 2% over 5 minutes.
- **Labels:** `observability, prometheus, metrics, monitoring, difficulty: medium, points: 150`

### Issue 95: Implement PII and Secret Sanitization Middleware Redacting Phone Numbers, Keys, and PINs
- **Target Area:** `apps/api/src/utils/logger.js`, `apps/api/src/middlewares/redactPii.js`
- **Problem:** Logs exported to Datadog/CloudWatch could inadvertently contain customer phone numbers, private keys (`S...`), or PINs.
- **Required Work:** Implement regex sanitization in Winston logger replacing Stellar secret keys, 4-digit PINs, and raw phone numbers with masked tokens.
- **Acceptance Criteria:** Unit tests verify secret keys (`S[A-Z0-9]{55}`) and phone numbers are completely redacted from all log output streams.
- **Labels:** `security, logging, privacy, pii, difficulty: trivial, points: 100`

### Issue 96: Harden Dockerfile with Multi-Stage Builds, Rootless Execution, and Minimal Alpine Base
- **Target Area:** `deploy/Dockerfile`, `docker-compose.production.yml`
- **Problem:** Running Docker containers as `root` user or including development dependencies in production images creates severe security exposure.
- **Required Work:** Rewrite `Dockerfile` with multi-stage build; copy only production dependencies; create and execute under non-root user `node`.
- **Acceptance Criteria:** Container runs as non-root UID 1000; final image size reduced by > 50%; passes vulnerability scanning with 0 critical CVEs.
- **Labels:** `docker, devops, security, hardening, difficulty: medium, points: 150`

### Issue 97: Implement Distributed Database Migration Advisory Locks for Zero-Downtime Prisma Deploys
- **Target Area:** `scripts/run-migrations.js`
- **Problem:** Running `prisma migrate deploy` across multiple autoscaling container replicas simultaneously causes database schema lock deadlocks.
- **Required Work:** Wrap Prisma migration runner in PostgreSQL advisory lock (`pg_advisory_lock`); release lock after migration succeeds.
- **Acceptance Criteria:** Multiple concurrent migration runs execute sequentially without deadlock or table corruption.
- **Labels:** `database, prisma, migrations, devops, difficulty: trivial, points: 100`

### Issue 98: Add Automated Stellar Testnet Integration Test Pipeline with Disposable Friendbot Accounts
- **Target Area:** `.github/workflows/stellar-integration.yml`, `tests/integration/stellar.test.js`
- **Problem:** CI only runs mocked unit tests; regressions in Horizon integration or Stellar SDK changes are not caught against the live testnet.
- **Required Work:** Implement GitHub Actions workflow generating random keypairs, funding via Friendbot, submitting test payments, and asserting ledger confirmation.
- **Acceptance Criteria:** Automated integration test passes against live Stellar testnet on every release PR.
- **Labels:** `ci, testing, stellar, testnet, difficulty: medium, points: 150`

### Issue 99: Implement Trivy and Semgrep Static Application Security Testing (SAST) in GitHub Actions
- **Target Area:** `.github/workflows/security-scan.yml`
- **Problem:** Vulnerabilities in npm dependencies or insecure code patterns (SQL injection, hardcoded secrets, weak crypto) could merge undetected.
- **Required Work:** Add Semgrep SAST scan rules for Node.js and Rust; add Trivy container and dependency vulnerability scan to CI pull request checks.
- **Acceptance Criteria:** PRs introducing security vulnerabilities or high-severity CVEs are automatically blocked in CI.
- **Labels:** `security, sast, semgrep, trivy, ci, difficulty: trivial, points: 100`

### Issue 100: Build Production Health Check Endpoint Probing PostgreSQL, Redis, Horizon, and KMS
- **Target Area:** `apps/api/src/routes/health.routes.js`
- **Problem:** Standard `/health` returns 200 OK even if downstream databases, Redis queues, or Stellar Horizon connections are broken.
- **Required Work:** Implement `/health/deep` endpoint verifying database connection (`SELECT 1`), Redis ping (`PING`), Horizon health check, and KMS provider responsiveness.
- **Acceptance Criteria:** Returns HTTP 200 if all dependent systems are operational; returns HTTP 503 Service Unavailable with degraded component details if any fail.
- **Labels:** `observability, health-check, devops, reliability, difficulty: trivial, points: 100`

