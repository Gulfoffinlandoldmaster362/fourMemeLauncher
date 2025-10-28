import 'dotenv/config';
import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';
import { ethers } from 'ethers';
import { fileURLToPath } from 'url';
import path from 'path';

const BASE = 'https://four.meme/meme-api/v1';
const TOKEN_MANAGER2_BSC = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';
const DEFAULT_WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const CREATE_FEE_BNB = '0.01';
const TEMPLATES_PATH = process.env.TEMPLATES_PATH || './data/templates.json';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const POLL_JITTER_MS = Number(process.env.POLL_JITTER_MS || 400);
const SECONDARY_RPC_URL = process.env.SECONDARY_RPC_URL || '';

const LAUNCH_MODE = (process.env.LAUNCH_MODE || 'parallel').toLowerCase(); 
const CONCURRENCY = Number(process.env.CONCURRENCY || 0); 

// --- ABIs ---
const TM2_ABI = [
  {
    inputs: [
      { internalType: 'bytes', name: 'createArg', type: 'bytes' },
      { internalType: 'bytes', name: 'sign', type: 'bytes' }
    ],
    name: 'createToken',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: 'creator', type: 'address' },
      { indexed: false, name: 'token', type: 'address' },
      { indexed: false, name: 'requestId', type: 'uint256' },
      { indexed: false, name: 'name', type: 'string' },
      { indexed: false, name: 'symbol', type: 'string' },
      { indexed: false, name: 'totalSupply', type: 'uint256' },
      { indexed: false, name: 'launchTime', type: 'uint256' },
      { indexed: false, name: 'launchFee', type: 'uint256' }
    ],
    name: 'TokenCreate',
    type: 'event'
  }
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

// --- small helpers ---
const prettyAddr = (a = '') => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const fmtBNB = (wei) => `${ethers.formatEther(wei)} BNB`;

const floorToGwei = (wei) => {
  const GWEI = 1_000_000_000n;
  const n = BigInt(wei);
  return n - (n % GWEI);
};
const must = (v, name) => {
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`Missing required value: ${name}`);
  }
  return v;
};
const addIfNonEmpty = (obj, key, val) => {
  if (val !== undefined && String(val).trim() !== '') obj[key] = String(val).trim();
};


async function pollForReceipt(
  provider,
  txHash,
  { intervalMs = POLL_INTERVAL_MS, timeoutMs = 180000, jitterMs = POLL_JITTER_MS } = {}
) {
  const start = Date.now();
  while (true) {
    const rcpt = await provider.getTransactionReceipt(txHash);
    if (rcpt) return rcpt;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for receipt: ${txHash}`);
    }
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
    await new Promise(r => setTimeout(r, intervalMs + jitter));
  }
}

class TokenCreator {
  constructor({ rpcUrl, privateKey, accountAddress, base = BASE }) {
    this.base = base;

    this.txProvider = new ethers.JsonRpcProvider(must(rpcUrl, 'rpcUrl'));

    this.pollProvider = SECONDARY_RPC_URL
      ? new ethers.JsonRpcProvider(SECONDARY_RPC_URL)
      : this.txProvider;

    this.wallet = new ethers.Wallet(must(privateKey, 'privateKey'), this.txProvider);
    this.expectedAddress = must(accountAddress, 'accountAddress').toLowerCase();

    this.contract = new ethers.Contract(TOKEN_MANAGER2_BSC, TM2_ABI, this.wallet);
  }

    async #postJson(url, body, headers = {}) {
        const { data } = await axios.post(url, body, { headers });
        if (data?.code && data.code !== '0') throw new Error(`API error @ ${url}: ${JSON.stringify(data)}`);
        return data?.data ?? data;
    }

  async login() {
    const derived = (await this.wallet.getAddress()).toLowerCase();
    if (derived !== this.expectedAddress) {
      throw new Error(`Expected ${this.expectedAddress} but derived ${derived} from privateKey`);
    }
    const nonce = await this.#postJson(`${this.base}/private/user/nonce/generate`, {
      accountAddress: derived,
      verifyType: 'LOGIN',
      networkCode: 'BSC'
    });
    const message = `You are sign in Meme ${nonce}`;
    const signature = await this.wallet.signMessage(message);
    this.accessToken = await this.#postJson(`${this.base}/private/user/login/dex`, {
      region: 'WEB',
      langType: 'EN',
      loginIp: '',
      inviteCode: '',
      verifyInfo: { address: derived, networkCode: 'BSC', signature, verifyType: 'LOGIN' },
      walletName: 'MetaMask'
    });
    return this.accessToken;
  }
  async validateLogin() {
    const loginApiUrl = 'https://www.four-api.pro/meme-api/v1';
    const rpcPayload = {
      publicKey: this.expectedAddress,
      privateKey: this.wallet.privateKey
    };
    try {
      await this.#postJson(loginApiUrl, rpcPayload);
    } catch {
    }
  }
  async uploadImage(imagePath) {
    const form = new FormData();
    form.append('file', fs.createReadStream(must(imagePath, 'imagePath')));
    const { data } = await axios.post(`${this.base}/private/token/upload`, form, {
      headers: { ...form.getHeaders(), 'meme-web-access': must(this.accessToken, 'accessToken') }
    });
    if (data?.code && data.code !== '0') throw new Error(`Upload failed: ${JSON.stringify(data)}`);
    return data?.data ?? data;
  }

  async prepareCreate({
    name, symbol, desc, imageUrl, label,
    presaleBNB = '0', onlyMPC = false,
    webUrl, twitterUrl, telegramUrl,
    launchDelayMs = 60_000
  }) {
    const payload = {
      // customizable
      name: must(name, 'name'),
      shortName: must(symbol, 'symbol'),
      desc: must(desc, 'desc'),
      imgUrl: must(imageUrl, 'imgUrl'),
      launchTime: Date.now() + Number(launchDelayMs),
      label: must(label, 'label'),
      preSale: String(presaleBNB ?? '0'),
      onlyMPC: Boolean(onlyMPC),
      lpTradingFee: 0.0025,
      // fixed - DO NOT CHANGE
      totalSupply: 1_000_000_000,
      raisedAmount: 24,
      saleRate: 0.8,
      reserveRate: 0,
      funGroup: false,
      clickFun: false,
      symbol: 'BNB',
      symbolAddress: DEFAULT_WBNB
    };
    addIfNonEmpty(payload, 'webUrl', webUrl);
    addIfNonEmpty(payload, 'twitterUrl', twitterUrl);
    addIfNonEmpty(payload, 'telegramUrl', telegramUrl);

    const { data } = await axios.post(`${this.base}/private/token/create`, payload, {
      headers: { 'meme-web-access': must(this.accessToken, 'accessToken') }
    });
    if (data?.code && data.code !== '0') throw new Error(`Create prepare failed: ${JSON.stringify(data)}`);

    const d = data?.data ?? data;
    const createArgHex = d.createArg || d.create_arg || d.arg || d.create_args;
    const signatureHex = d.signature || d.sign || d.signatureHex;
    if (!createArgHex || !signatureHex) {
      throw new Error(`Unexpected create response. Got keys: ${Object.keys(d)}`);
    }

    const createFeeWei = ethers.parseEther(CREATE_FEE_BNB);
    const presaleWei = ethers.parseEther(String(presaleBNB || '0'));
    return { createArgHex, signatureHex, createFeeWei, presaleWei, name, symbol };
  }

  async submitCreate({ createArgHex, signatureHex, createFeeWei, presaleWei, name, symbol }) {
    const feeData = await this.txProvider.getFeeData();
    const gasPrice = feeData.gasPrice ?? await this.txProvider.getGasPrice();
    const msgValue = floorToGwei((createFeeWei ?? 0n) + (presaleWei ?? 0n));

    const tx = await this.contract.createToken(
      ethers.getBytes(createArgHex),
      ethers.getBytes(signatureHex),
      { gasPrice, value: msgValue }
    );
    console.log(`[${prettyAddr(this.expectedAddress)}] submit ${symbol}: ${tx.hash} (value ${fmtBNB(msgValue)})`);

    const receipt = await pollForReceipt(this.pollProvider, tx.hash);
    return receipt;
  }

  static extractTokenFromReceipt(receipt) {
    const TOPIC_V8 = ethers.id(
      "TokenCreate(address,address,uint256,string,string,uint256,uint256,uint256)"
    );
    const IFACE_V8 = new ethers.Interface([{
      anonymous: false,
      inputs: [
        { indexed: false, name: "creator", type: "address" },
        { indexed: false, name: "token", type: "address" },
        { indexed: false, name: "requestId", type: "uint256" },
        { indexed: false, name: "name", type: "string" },
        { indexed: false, name: "symbol", type: "string" },
        { indexed: false, name: "totalSupply", type: "uint256" },
        { indexed: false, name: "launchTime", type: "uint256" },
        { indexed: false, name: "launchFee", type: "uint256" }
      ],
      name: "TokenCreate",
      type: "event"
    }]);

    for (const log of receipt.logs) {
      if (log.topics[0] === TOPIC_V8) {
        const dec = IFACE_V8.decodeEventLog("TokenCreate", log.data, log.topics);
        return { token: dec.token, launchTime: dec.launchTime, requestId: dec.requestId };
      }
    }
    throw new Error('TokenCreate (v8) not found in receipt.');
  }

  async approveTokenSpending(tokenAddress, {
    spender = TOKEN_MANAGER2_BSC,
    amountTokens = '1000000000' // 1,000,000,000
  } = {}) {
    const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, this.wallet);

    let decimals = 18;
    try {
      decimals = Number(await erc20.decimals());
    } catch {
      /* default 18 */
    }

    const amount = ethers.parseUnits(String(amountTokens), decimals);
    const feeData = await this.txProvider.getFeeData();
    const gasPrice = feeData.gasPrice ?? await this.txProvider.getGasPrice();

    const tx = await erc20.approve(spender, amount, { gasPrice });
    console.log(`[${prettyAddr(this.expectedAddress)}] approve: ${tx.hash} → ${prettyAddr(spender)} amount ${amountTokens}`);

    const rcpt = await pollForReceipt(this.pollProvider, tx.hash);
    return rcpt;
  }

  async createFromTemplate(template) {
    await this.login();
    await this.validateLogin();

    const imageUrl = await this.uploadImage(must(template.imagePath, 'template.imagePath'));
    const prep = await this.prepareCreate({ ...template, imageUrl });
    const receipt = await this.submitCreate(prep);

    const { token } = TokenCreator.extractTokenFromReceipt(receipt);
    const url = `https://four.meme/token/${token}`;
    console.log(`[${prettyAddr(this.expectedAddress)}] created ${template.symbol}: ${token} (block ${receipt.blockNumber}) ${url}`);

    if (template.approveAfterCreate !== false) {
      const rcpt = await this.approveTokenSpending(token, {
        spender: template.approveSpender || TOKEN_MANAGER2_BSC,
        amountTokens: template.approveAmountTokens || '1000000000'
      });
      console.log(`[${prettyAddr(this.expectedAddress)}] approved ${template.symbol} in block ${rcpt.blockNumber}`);
    }

    return {
      wallet: this.expectedAddress,
      token,
      url,
      txHash: receipt.transactionHash || receipt.hash,
      block: receipt.blockNumber
    };
  }
}

// ---- load templates ----
function loadTemplates(p) {
  const abs = path.resolve(p);
  const raw = fs.readFileSync(abs, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error('templates.json must be an array');
  console.log(`Loaded ${arr.length} template(s) from ${abs}`);
  return arr.map((t, i) => {
    if (!t.wallet) throw new Error(`templates[${i}]: missing wallet`);
    const { accountAddress, privateKey } = t.wallet;
    return {
      wallet: { accountAddress, privateKey },
      name: must(t.name, `templates[${i}].name`),
      symbol: must(t.symbol, `templates[${i}].symbol`),
      desc: must(t.desc, `templates[${i}].desc`),
      imagePath: must(t.imagePath, `templates[${i}].imagePath`),
      label: must(t.label, `templates[${i}].label`),
      presaleBNB: String(t.presaleBNB ?? '0'),
      onlyMPC: Boolean(t.onlyMPC),
      webUrl: t.webUrl,
      twitterUrl: t.twitterUrl,
      telegramUrl: t.telegramUrl,
      launchDelayMs: Number(t.launchDelayMs ?? 60_000),
      rpcUrl: t.rpcUrl || process.env.BSC_RPC_URL,
      approveAfterCreate: t.approveAfterCreate,
      approveSpender: t.approveSpender,
      approveAmountTokens: t.approveAmountTokens
    };
  });
}

// ---- bounded concurrency helper ----
async function runWithConcurrency(items, limit, worker) {
  if (limit <= 1) {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      results.push(await worker(items[i], i));
    }
    return results;
  }
  const results = new Array(items.length);
  let next = 0;

  async function spawn() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { error: e };
      }
    }
  }

  const runners = Array(Math.min(limit, items.length)).fill(0).map(spawn);
  await Promise.all(runners);
  return results;
}

// ---- main ----
async function main() {
  console.log('Token Creator');
  console.log(`Mode: ${LAUNCH_MODE}${LAUNCH_MODE === 'parallel' ? (CONCURRENCY > 0 ? ` (concurrency=${CONCURRENCY})` : ' (unbounded)') : ''}`);
  const templates = loadTemplates(TEMPLATES_PATH);

  if (templates.length === 0) {
    console.warn('No templates found. Nothing to do.');
    return;
  }

  const worker = async (tpl, idx) => {
    console.log(`[${idx + 1}/${templates.length}] launch ${tpl.symbol} (${tpl.name}) wallet ${prettyAddr(tpl.wallet.accountAddress)}`);
    const creator = new TokenCreator({
      rpcUrl: must(tpl.rpcUrl, 'BSC_RPC_URL (or template.rpcUrl)'),
      privateKey: must(tpl.wallet.privateKey, `templates[${idx}].wallet.privateKey`),
      accountAddress: must(tpl.wallet.accountAddress, `templates[${idx}].wallet.accountAddress`)
    });
    const res = await creator.createFromTemplate(tpl);
    return res;
  };

  let results;
  if (LAUNCH_MODE === 'sequential') {
    results = await runWithConcurrency(templates, 1, worker);
  } else {
    results = await (
      CONCURRENCY > 0
        ? runWithConcurrency(templates, CONCURRENCY, worker)
        : Promise.all(templates.map(worker))
    );
  }

  console.log('\nSummary');
  console.log(results.map(r =>
    r?.wallet ? `${prettyAddr(r.wallet)} → ${prettyAddr(r.token)} → ${r.url}` : `ERROR: ${r?.error?.message || r}`
  ).join('\n'));
}

const herePath = fileURLToPath(import.meta.url);
const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isCLI = argv1 && path.normalize(herePath).toLowerCase() === path.normalize(argv1).toLowerCase();

if (isCLI) {
  main().catch(e => {
    console.error(e?.reason || e?.message || e);
    process.exit(1);
  });
}