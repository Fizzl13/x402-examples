// Makes a new Ethereum wallet for an agent, in the browser: a random private key from
// crypto.getRandomValues, its address (secp256k1 public key, keccak-256, EIP-55 checksum).
// The key never leaves the page; the dashboard only puts it in the config text you copy.
// Small and dependency-free on purpose (the page loads nothing from third parties); the test
// suite checks it against viem for many random keys.

// ---------- keccak-256 (Ethereum's hash: the original Keccak padding, not SHA3's) ----------
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & M64 & b[((x + 2) % 5) + 5 * y]);
    s[0] ^= RC[round];
  }
}

export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((s[i] >> BigInt(8 * j)) & 0xffn);
  return out;
}

// ---------- secp256k1: public key = k·G ----------
const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a) => ((a % P) + P) % P;
function inv(a) { // a^(p-2) mod p
  let r = 1n, b = mod(a), e = P - 2n;
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r;
}
function add(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  if (x1 === x2 && mod(y1 + y2) === 0n) return null;
  const m = x1 === x2 && y1 === y2 ? mod(3n * x1 * x1 * inv(2n * y1)) : mod((y2 - y1) * inv(x2 - x1));
  const x3 = mod(m * m - x1 - x2);
  return [x3, mod(m * (x1 - x3) - y1)];
}
function mul(k) {
  let r = null, q = G;
  while (k > 0n) { if (k & 1n) r = add(r, q); q = add(q, q); k >>= 1n; }
  return r;
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const big = (bytes) => BigInt("0x" + hex(bytes));
const bytes32 = (n) => Uint8Array.from(n.toString(16).padStart(64, "0").match(/../g), (h) => parseInt(h, 16));

function checksum(addrHex) { // EIP-55
  const h = hex(keccak256(new TextEncoder().encode(addrHex)));
  return "0x" + [...addrHex].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

/** The address of a 0x… private key. */
export function addressOf(privateKey) {
  const k = BigInt(privateKey);
  if (k <= 0n || k >= N) throw new Error("not a valid private key");
  const [x, y] = mul(k);
  const pub = new Uint8Array(64);
  pub.set(bytes32(x), 0);
  pub.set(bytes32(y), 32);
  return checksum(hex(keccak256(pub).slice(12)));
}

/** A new random wallet: { privateKey, address }. */
export function newAgentKey(random = (b) => crypto.getRandomValues(b)) {
  for (;;) {
    const k = big(random(new Uint8Array(32)));
    if (k > 0n && k < N) {
      const privateKey = "0x" + k.toString(16).padStart(64, "0");
      return { privateKey, address: addressOf(privateKey) };
    }
  }
}
