# OPNet Vanilla JS dApp — Hard-Won Rules

These rules were learned the hard way building OP Terminal, a zero-dependency vanilla JS OPNet network monitor. Every rule here comes from a real bug that cost hours to diagnose. Follow them exactly.

---

## ABSOLUTE RULES

### 1. OPNet RPC Method Names Use `btc_` Prefix
Every JSON-RPC method uses the `btc_` prefix. Not `eth_`, not bare names.
```
btc_blockNumber          btc_gas                 btc_getMempoolInfo
btc_getBalance           btc_getBlockByNumber    btc_getTransactionByHash
btc_getTransactionReceipt  btc_getCode           btc_getUTXOs
btc_call                 btc_getEpochTemplate    btc_getLatestPendingTransactions
btc_getStorageAt
```
**Violation cost:** Silent failures, empty data, wasted hours.

### 2. OPNet RPC Uses Positional Params (Arrays), NOT Named Objects
```javascript
// CORRECT
rpc('btc_call', [contractHexAddr, calldataHex])
rpc('btc_getBalance', [address, true])
rpc('btc_getBlockByNumber', [blockNum, prefetchTxs])
rpc('btc_getUTXOs', [address, optimize, mergePending, filterSpent])

// WRONG — will silently fail or return garbage
rpc('btc_call', { to: addr, calldata: data })
rpc('btc_getBalance', { address: addr, filterOrdinals: true })
```

### 3. `btc_getUTXOs` Takes Exactly 4 Params
```javascript
// CORRECT — 4 params
rpc('btc_getUTXOs', [address, false, true, true])

// WRONG — 5th param breaks it
rpc('btc_getUTXOs', [address, false, true, true, false])
```
**Violation cost:** UTXOs silently fail to load, wallet portfolio shows empty.

### 4. `btc_getBalance` Returns a Hex String
The response is `"0x0"` or `"0x186a0"` — a hex-encoded satoshi amount as a string.
```javascript
// CORRECT
function parseBalance(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'bigint') return Number(val);
  if (typeof val === 'string') return val.startsWith('0x') ? parseInt(val, 16) : parseInt(val, 10);
  if (val && typeof val === 'object') {
    if (val.confirmed !== undefined) return parseBalance(val.confirmed) + parseBalance(val.unconfirmed || '0');
    if (val.balance !== undefined) return parseBalance(val.balance);
    if (val.total !== undefined) return parseBalance(val.total);
  }
  return 0;
}

// WRONG — assuming it's a number
state.wallet.balance = await fetchBalance(addr); // might be "0x186a0" string
```
**Violation cost:** Balance shows as NaN or 0 when user has funds.

### 5. `btc_call` Returns a Nested Object, NOT a Raw String
```json
{
  "result": {
    "result": "base64EncodedData",
    "events": {},
    "estimatedGas": "0x721c1bf"
  }
}
```
After `rpc()` extracts `json.result`, you get `{ result: "b64...", events: {...} }`.
You MUST extract the inner `.result`:
```javascript
function extractCallResult(res) {
  if (typeof res === 'string') return res;
  if (res && typeof res === 'object') {
    if (typeof res.result === 'string') return res.result;
    if (typeof res.data === 'string') return res.data;
  }
  return null;
}
```
**Violation cost:** Trying to base64-decode an object → silent crash, no token data.

### 6. OPNet ABI Uses SHA256 Selectors (NOT Keccak256)
Function selectors are the first 4 bytes of SHA256(signature), NOT Keccak256.
```
name()         → 0x1581f81c
symbol()       → 0x25967ca5
decimals()     → 0xbb844440
totalSupply()  → 0xa368022e
balanceOf()    → 0x5b46f8f6
```
These are pre-computed and verified. Do NOT recalculate with keccak.

### 7. OPNet ABI Encoding: Big-Endian, No Padding
- **Address**: 32 bytes native (NOT 20 bytes like Ethereum, NOT padded to 32)
- **String**: 4-byte uint32 big-endian length prefix + UTF-8 bytes (no padding)
- **uint8**: 1 byte (NOT padded to 32 bytes)
- **uint256**: 32 bytes big-endian
- **Selector**: 4 bytes

`balanceOf(address)` calldata = `0x` + 4-byte selector + 32-byte address = 36 bytes total.
```javascript
var cd = '0x' + '5b46f8f6' + addrHex; // 72 hex chars = 36 bytes
```
**Violation cost:** Contract calls revert or return garbage.

### 8. OPNet Addresses: `opt1p` Uses Bech32m, NOT Standard Bitcoin Bech32
OPNet testnet addresses start with `opt1p` (HRP = `opt`, witness version 1). They use bech32m encoding with the standard charset:
```
qpzry9x8gf2tvdw0s3jn54khce6mua7l
```
**CRITICAL**: The character `1` (digit one) is NOT in the bech32 charset. What looks like `1` in addresses is actually `l` (lowercase L). If your bech32 decoder encounters `1` in the data portion and returns null, the address display is using a confusing font — the actual string has `l`.
```javascript
// Find separator — safe because '1' never appears in valid bech32 data
var sep = addr.lastIndexOf('1');
```
The decoded witness program is 32 bytes — the tweaked public key (same as taproot P2TR).

### 9. OP_WALLET API
```javascript
// Connect
var accounts = await window.opnet.requestAccounts(); // Returns string[] of addresses

// Get public key (may be Schnorr compressed OR MLDSA — check length!)
var pubkey = await window.opnet.getPublicKey(); // hex string

// Public key lengths:
// 66 hex chars = 33 bytes = compressed Schnorr (strip first byte for x-only)
// 64 hex chars = 32 bytes = x-only Schnorr
// 5184+ hex chars = MLDSA key (2592+ bytes) — DO NOT use raw as 32-byte address
```
**CRITICAL**: `getPublicKey()` may return an MLDSA key (thousands of bytes). Code that assumes 33-byte Schnorr will silently fail. Always check `pk.length`.

### 10. Token Detection Cannot Rely on Block Scanning Alone
Tokens (MOTO, PILL, basedMOTO) may not appear in the last N blocks. You MUST maintain a `KNOWN_TOKENS` array with pre-verified contract addresses, names, symbols, and decimals. Inject these into state before any scanning begins.
```javascript
var KNOWN_TOKENS = [
  { hexAddr: '0xfd44...', name: 'Motoswap', symbol: 'MOTO', decimals: 18 },
  { hexAddr: '0xb09f...', name: 'Orange Pill', symbol: 'PILL', decimals: 18 },
  { hexAddr: '0x3519...', name: 'BASED MOTO', symbol: 'basedMOTO', decimals: 8 },
];
```
Call `ensureKnownTokens()` at: init, wallet connect, every poll, and after loading blocks.

### 11. balanceOf Address Resolution — Try Multiple Candidates
The 32-byte address used by OPNet contracts may differ from what you expect. The contract's `Blockchain.tx.sender` determines the key. For `opt1p` addresses, try these candidates in order:
1. **Bech32 decode** → witness program (32-byte tweaked public key)
2. **Wallet public key** → strip to x-only if 33-byte Schnorr
3. **Public key prefix** → first 32 bytes of MLDSA key (last resort)

If candidate #1 returns 0 balance for ALL tokens, try candidate #2. Log which worked.
```javascript
for (var ci = 0; ci < candidates.length && !foundNonZero; ci++) {
  // Try balanceOf with this candidate...
  // If any token has balance > 0, stop and use this candidate
}
```

### 12. Always Show Known Tokens in Profile (Even with 0 Balance)
Never hide tokens just because balance is 0. Show all known tokens:
- Tokens with balance > 0: highlighted (green icon, full balance)
- Tokens with balance = 0: dimmed (gray, shows "0")
- Tokens still loading: shows "—"

Users need to SEE that the app is checking their tokens. "No token holdings" with no context is confusing.

---

## PERSISTENCE & PERFORMANCE

### 13. IndexedDB Block Cache is Mandatory for Production
Without caching, 2000+ blocks re-fetch on every page refresh. Users will hate this.
```javascript
// Schema
db.createObjectStore('blocks', { keyPath: '_height' });

// Save blocks as they're fetched
function cacheBlocks(blocks) { /* write to IDB */ }

// Restore on startup — race against 3s timeout
function loadCachedBlocks() {
  return Promise.race([
    actualIDBLoad(),
    new Promise(resolve => setTimeout(() => resolve([]), 3000))
  ]);
}
```
- Always add a timeout on IDB reads (prevents frozen UI if IDB is locked)
- Bump `DB_VER` when data format changes (triggers `onupgradeneeded`)
- Deduplicate on restore (filter by `_height`, skip duplicates)
- Validate cached blocks (`_height > 0`, not null/undefined)

### 14. Wallet Auto-Reconnect Needs Retry Logic
OP_WALLET extension may load AFTER your DOMContentLoaded fires.
```javascript
if (localStorage.getItem('op_wallet_connected')) {
  if (hasOPWallet()) {
    setTimeout(connectWallet, 500);       // Fast attempt
  } else {
    setTimeout(tryConnect, 1500);          // Retry if extension slow
    setTimeout(tryConnect, 3000);          // Final retry
  }
}
```

---

## COMMON TRAPS

### 15. Never Trust a Single Balance Format
`btc_getBalance` returns hex string. But during development, you might see numbers, bigints, or objects from other endpoints. Always use a robust parser that handles ALL formats.

### 16. Contract Addresses Include `0x` Prefix
All OPNet contract hex addresses are 66 chars: `0x` + 64 hex chars (32 bytes).
```
0xfd4473840751d58d9f8b73bdd57d6c5260453d5518bd7cd02d0a4cf3df9bf4dd
```
The `btc_call` first param expects this format.

### 17. OP20 String Decoding: 4-Byte Length Prefix
```javascript
function decodeOP20String(b64) {
  var raw = atob(b64);
  var len = (raw.charCodeAt(0) << 24) | (raw.charCodeAt(1) << 16) |
            (raw.charCodeAt(2) << 8) | raw.charCodeAt(3);
  return raw.slice(4, 4 + len);
}
```
NOT a null-terminated string. NOT ABI-encoded with 32-byte offset.

### 18. OP20 uint256 Decoding: Raw Big-Endian Bytes
```javascript
function decodeOP20Uint256(b64) {
  var raw = atob(b64);
  var result = 0n;
  for (var i = 0; i < raw.length; i++) result = (result << 8n) | BigInt(raw.charCodeAt(i));
  return result;
}
```
Returns a BigInt. Use `formatTokenAmount(balance, decimals)` for display.

### 19. Use `bigint` for All Token Amounts
JavaScript `Number` loses precision above 2^53. Token balances with 18 decimals WILL overflow.
```javascript
// CORRECT
var bal = 1000000000000000000000n; // 1000 tokens * 10^18

// WRONG
var bal = 1000000000000000000000; // Precision loss!
```

### 20. OPNet Testnet Network Configuration
```
RPC URL:    https://testnet.opnet.org/api/v1/json-rpc
Network:    networks.opnetTestnet (Signet fork)
HRP:        opt (for opt1p... addresses)
```
**NEVER** use `networks.testnet` — that's Testnet4, which OPNet does NOT support.

---

## VERIFIED CONTRACT ADDRESSES (OPNet Testnet)

| Token | Hex Address | Symbol | Decimals |
|-------|-------------|--------|----------|
| Motoswap | `0xfd4473840751d58d9f8b73bdd57d6c5260453d5518bd7cd02d0a4cf3df9bf4dd` | MOTO | 18 |
| Orange Pill | `0xb09fc29c112af8293539477e23d8df1d3126639642767d707277131352040cbb` | PILL | 18 |
| BASED MOTO | `0x351912cae92e8e7ccabca1a8acd98f148d764466bc3e511a9412618523e93180` | basedMOTO | 8 |

---

## DEBUGGING CHECKLIST

When something doesn't work:
1. **Check browser console** — all failures log with `console.warn`
2. **Test RPC with curl** — verify the method/params work outside the app
3. **Check address format** — is it `opt1p`, `tb1p`, `tb1z`, or something else?
4. **Check response format** — is it string, object, nested object?
5. **Check bech32 decode** — does it return null? Log the decoded bytes.
6. **Check public key length** — is it 64, 66, or 5000+ hex chars?
7. **Test balanceOf with decoded bytes via curl** — does the contract return non-zero?

---

## PROJECT STRUCTURE

```
bitpulse/
  index.html          — 5 tabs: Overview, Blocks, Transactions, Explorer, Profile
  css/styles.css      — Dark theme, glass-morphism, responsive (1360px/900px/700px/500px)
  js/app.js           — Single file, zero dependencies, ~1900 lines
```

Zero npm. Zero build step. Pure HTML/CSS/JS connecting to OPNet testnet JSON-RPC.
