# OP Terminal — OPNet Network Monitor

Real-time network monitoring dashboard for OPNet Bitcoin L1 smart contracts.

![OP Terminal](https://img.shields.io/badge/OPNet-Testnet-blue)
![Week 1](https://img.shields.io/badge/vibecode.finance-Week%201-green)

## What It Does

OP Terminal is a live dashboard that connects directly to OPNet Testnet and displays real-time blockchain data. No backend, no API keys, no dependencies.

### Overview Dashboard
- **Block Height** — Live counter updated every 10 seconds
- **Gas Utilization** — Animated ring chart showing gas used vs. gas limit
- **Gas Analytics** — Base gas, gas per sat, EMA, gas used, gas limit, target
- **Bitcoin Fees** — Low / Medium / High fee estimates with visual progress bars
- **Mempool** — Total txs, OPNet txs, size in KB, OPNet-to-total ratio

### Recent Blocks
- Last 15 blocks in a live-updating table
- Shows block number, hash, transaction count, gas used, and age
- Gas visualization bars scaled relative to the highest-gas block

### Explorer
- **Address Lookup** — Enter any Bitcoin address to see its BTC balance
- **Transaction Lookup** — Enter any 64-char hex hash to see full transaction details
- Distinguishes Generic vs. OPNet Interaction transactions
- Shows contract address, events, gas, burned BTC, inputs/outputs for smart contract txs

### Wallet
- **OP_WALLET integration** via `window.opnet` (the official OPNet wallet)
- Connect to view your address and live BTC balance
- Auto-refreshes balance on every poll cycle

## How to Run

Zero dependencies. No build step.

```bash
python3 -m http.server 8080 --directory .
# Open http://localhost:8080
```

## RPC Methods

| Method | Purpose |
|--------|---------|
| `btc_blockNumber` | Current block height |
| `btc_gas` | Gas parameters + Bitcoin fee estimates |
| `btc_getMempoolInfo` | Mempool statistics |
| `btc_getBlockByNumber` | Block details for the blocks table |
| `btc_getBalance` | Address balance lookup |
| `btc_getTransactionByHash` | Transaction details |

## Tech

- Pure HTML / CSS / JS — zero npm dependencies
- Direct OPNet JSON-RPC calls via `fetch()`
- OP_WALLET integration via `window.opnet`
- Inter + JetBrains Mono typography
- Responsive layout (desktop / tablet / mobile)
- SVG ring chart for gas utilization
- Animated fee bars and block table

## Built For

[vibecode.finance](https://vibecode.finance) Week 1: Bitcoin Activated

Built with [Bob](https://ai.opnet.org) on [OPNet](https://opnet.org) — Bitcoin Layer 1 smart contracts.
