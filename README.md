# Token Creator

Create and launch **four.meme** tokens from Node.js.  
Uploads your image, prepares the token on the four.meme API, calls the on-chain `createToken` (paying the **0.01 BNB** creation fee + optional **presale BNB**), and (optionally) **approves** a spender to fast sell the supply for the deploying wallet.

---

## Features
- See local references in docs/ for API/ABI details.

- Single command to launch one or many tokens (from templates).
- Sends **0.01 BNB** creation fee **+** `presaleBNB` in the same transaction.
- Optional **post-create `approve`** for fast selling later.
- Parallel **or** sequential launches (env-controlled).

---

## Requirements

- **Node.js 18+** (works with ESM + `ethers@6`).
- Some BNB on each deployer wallet:  
  `required ≈ 0.01 (fee) + presaleBNB + gas`.


---

## Configure

### 1) `.env`

```ini
# Primary RPC used to SEND transactions (required)
BSC_RPC_URL=https://your-primary-bsc-rpc.example

# Optional: a different RPC used only for polling receipts (recommended for free tier rpc plans to avoid rate limits)
SECONDARY_RPC_URL=https://your-secondary-bsc-rpc.example

# Path to your templates file
TEMPLATES_PATH=./data/templates.json

# Polling cadence for receipt checks (tune if hitting rate limits)
POLL_INTERVAL_MS=3000
POLL_JITTER_MS=400

# How to launch multiple templates: 'parallel' or 'sequential'
LAUNCH_MODE=parallel

# If LAUNCH_MODE=parallel, cap concurrency (0 = unbounded)
CONCURRENCY=0
```

**Notes**
- If you only have one RPC, you can omit `SECONDARY_RPC_URL` and polling will use `BSC_RPC_URL`.
- If you ever see provider rate-limit errors, increase `POLL_INTERVAL_MS` or add a `SECONDARY_RPC_URL`.

---

### 2) `templates.json`

An array of token templates. Each template includes both the **token content** and the **wallet** that will deploy it.

#### Schema (per template)

| Field | Type | Required | Example / Notes |
|---|---|---:|---|
| `name` | string | ✅ | `"CATJAM"` |
| `symbol` | string | ✅ | `"CJAM"` |
| `desc` | string | ✅ | Short description |
| `imagePath` | string | ✅ | Local path to PNG/JPG |
| `label` | string | ✅ | One of: `Meme/AI/Defi/Games/Infra/De-Sci/Social/Depin/Charity/Others` |
| `presaleBNB` | string/number | ✅ | e.g. `"0.01"` (added to `msg.value`) |
| `onlyMPC` | boolean | ✅ | `false` for regular wallet |
| `webUrl` | string | ❌ | Optional, leave `""` to omit |
| `twitterUrl` | string | ❌ | Optional |
| `telegramUrl` | string | ❌ | Optional |
| `launchDelayMs` | number | ❌ | Default `60000` (ms from “now”) |
| `rpcUrl` | string | ❌ | Per-template override (else uses `BSC_RPC_URL`) |
| `approveAfterCreate` | boolean | ❌ | Default `true` |
| `approveSpender` | string | ❌ | Address to receive allowance (defaults to TokenManager2) |
| `approveAmountTokens` | string/number | ❌ | Default `"1000000000"` (full supply) |
| `wallet.accountAddress` | string | ✅ | Must match private key |
| `wallet.privateKey` | string | ✅ | `0x...` (keep secure!) |

#### Example

```json
[
  {
    "name": "TEST1",
    "symbol": "TEST1",
    "desc": "NOMINAL TESTING",
    "imagePath": "./assets/sample-token.png",
    "label": "Meme",
    "presaleBNB": "0.01",
    "onlyMPC": false,
    "webUrl": "",
    "twitterUrl": "",
    "telegramUrl": "",
    "launchDelayMs": 60000,
    "rpcUrl": "https://your-primary-bsc-rpc.example",
    "approveAfterCreate": true,
    "approveSpender": "0x5c952063c7fc8610FFDB798152D69F0B9550762b",
    "approveAmountTokens": "1000000000",
    "wallet": {
      "accountAddress": "0xYourDeployerAddress",
      "privateKey": "0xYourPrivateKey"
    }
  }
]
```

> ⚠️ **Security:** This file contains private keys. Keep it out of source control; add it to `.gitignore` and restrict file permissions.

---



## References

These files document Four.meme�s API and on-chain ABIs used by this launcher:
- `docs/API-Documents.md` � General API docs overview used while building the script.
- `docs/API-CreateToken.md` � Create-token REST flow and payload notes used to prepare `createArg` and signatures.
- `docs/TokenManager2.lite.abi` � Minimal ABI for TokenManager2 used by on-chain `createToken` submission.
- `docs/TokenManagerHelper3.abi` � Helper ABI for related contract interactions and discovery.

Official documentation
- Four.meme Protocol Integration Guide: https://four-meme.gitbook.io/four.meme/protocol-integration

These references are included to make development auditable and to help users verify behavior against official docs.
## Install

```bash
npm install
```

---

## Run

### Using Node
```bash
node src/tokenCreator.js
```

### Using npm script (optional)

```bash
npm run launch
```

### Control parallelism

- **Sequential**
  ```ini
  LAUNCH_MODE=sequential
  ```
- **Parallel (unbounded)**
  ```ini
  LAUNCH_MODE=parallel
  CONCURRENCY=0
  ```
- **Parallel (bounded)**
  ```ini
  LAUNCH_MODE=parallel
  CONCURRENCY=3
  ```

---

## What it logs (example)

```
[1/3] launch TEST1 (TEST ONE) wallet 0x8D5e…8046
[0x8D5e…8046] submit TEST1: 0x2314…c2d3 (value 0.02 BNB)
[0x8D5e…8046] created TEST1: 0x81199A…4444 (block 66081179) https://four.meme/token/0x81199A…4444
[0x8D5e…8046] approve: 0x2705…0e8d → 0x5c9520…762b amount 1000000000
[0x8D5e…8046] approved TEST1 in block 66081183
```

A **Summary** of all results prints at the end.

---

## How it works (quick)

1. **Auth** with four.meme (message-signing).
2. **Upload** the token image (returns hosted `imgUrl`).
3. **Prepare** creation via API (returns `createArg` + `signature`).
4. **Send** `createToken(createArg, sign)` on TokenManager2 with  
   `msg.value = 0.01 BNB (fee) + presaleBNB`.
5. **Poll** for the receipt; decode `TokenCreate` to get the token address.
6. **Optional**: `approve(spender, 1,000,000,000)` on the new token.

---

## Environment details

- `BSC_RPC_URL` – Primary RPC used to **send** transactions.
- `SECONDARY_RPC_URL` – Optional RPC used **only to poll** receipts.
- `TEMPLATES_PATH` – Path to `templates.json`.
- `POLL_INTERVAL_MS` / `POLL_JITTER_MS` – Tune if you see rate limits.
- `LAUNCH_MODE` – `parallel` or `sequential`.
- `CONCURRENCY` – Cap parallel jobs (only used when `parallel`).

---

## Troubleshooting

- **Rate-limit errors** from your RPC:
  - Increase `POLL_INTERVAL_MS` (e.g., 3000 → 5000).
  - Set a different `SECONDARY_RPC_URL` for polling.
  - Reduce `CONCURRENCY` or switch to `sequential`.

- **`ACCOUNT_ADDRESS mismatch`**
  - `wallet.accountAddress` must match the provided `privateKey`.

- **Insufficient funds**
  - Each wallet needs: `0.01 + presaleBNB + gas`. Check balances.

---

## Notes

- The script enforces the platform’s **0.01 BNB** creation fee and includes `presaleBNB` in `msg.value` by design.
- The default **approve spender** is the four.meme TokenManager2 contract (`0x5c95…762b`). You can set a different `approveSpender` per template.



