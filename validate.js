const util = require("util");
const tool = require("./tool.js");
const chains = require("./chains");
const Web3 = require("web3");
const ownerAbi = require('./abis/owner');

const web3 = new Web3();

const inputFile = process.argv[2];
const txs = require(inputFile);

let TrxRefBlockCache = null;
const TokenPairMap = new Map();
const TokenInfoCache = new Map();
const AddressNonceCache = new Map();
let TxReportCache = false;

const ChainTypeMapping = new Map([
  ["BSC", "BNB"]
])

console.log("total %d txs from file %s", txs.length, inputFile);

validate();

async function validate() {
  for (let i = 0; i < txs.length; i++) {
    let tx = txs[i];
    console.log("(%d) %s tx: %s", i, tx.chain, tx.topic);
    TxReportCache = false;
    try {
      // check chain
      let chainInfo = chains[tx.chain];
      if (!chainInfo) {
        report("error", "invalid chain: %s", tx.chain);
      }
      // check chainId (walletId)
      if ((chainInfo.walletId !== "no") && (tx.chainId != chainInfo.walletId)) {
        report("error", "invalid chainId: %s, expected %s", tx.chainId, chainInfo.walletId);
      }
      // check from
      if (!tool.compAddress(tx.from, chainInfo.admin)) {
        report("error", "invalid from: %s, expected %s", tx.from, chainInfo.admin);
      }
      // check nonce
      await validateNonce(tx.chain, tx.from, tx.nonce);
      // check gas
      if (chainInfo.gasPrice) {
        if (Number(tx.gasPrice) < chainInfo.gasPrice) {
          report("error", "invalid gasPrice: %s, at least %s", tx.gasPrice, chainInfo.gasPrice);
        }
        if (Number(tx.gasLimit) < chainInfo.gasLimit) {
          report("error", "invalid gasLimit: %s, at least %s", tx.gasLimit, chainInfo.gasLimit);
        }
      } else if (tx.chain === "TRX") {
        if (Number(tx.feeLimit) < chainInfo.feeLimit) {
          report("error", "invalid feeLimit: %s, at least %s", tx.feeLimit, chainInfo.feeLimit);
        }
        checkTrxRefBlock(tx.refBlock);
      }
      // check abi
      if (["addTokenPair", "updateTokenPair"].includes(tx.abi.name)) {
        // check to
        if (!tool.compAddress(tx.to, chainInfo.tokenManagerProxy)) {
          report("error", "invalid to: %s, expected %s", tx.to, chainInfo.tokenManagerProxy);
        }
        await validateAddTokenPair(tx);
      } else {
        report("warn", "need manually validate %s tx", tx.abi.name);
      }
      if (!TxReportCache) {
        console.log("\x1B[42m%s\x1B[0m", "Pass");
      }
    } catch (err) {
      // do nothing
    }
  }
  tool.iwan.close();
}

async function validateNonce(chainType, address, nonce) {
  let chainInfo = chains[chainType];
  if ((chainInfo.admin === "no") || (chainInfo.nonce === "no")) {
    return;
  }
  let key = chainType + address.toLowerCase();
  let expected = 0, exist = AddressNonceCache.get(key);
  if (exist !== undefined) {
    expected = exist;
  } else {
    let iWanChainType = ChainTypeMapping.get(chainType) || chainType;
    let chainNonce = await tool.iwan.getNonce(iWanChainType, address);
    // console.log("chain %s address %s chain nonce: %s", iWanChainType, address, chainNonce)
    expected = Number(chainNonce);
  }
  if (Number(nonce) !== expected) { // maybe need reserve nonce, do not report error
    report("detail", "invalid chain %s %s nonce: %s, expected %s", chainType, address, nonce, expected);
  }
  AddressNonceCache.set(key, Number(nonce) + 1);
}

function checkTrxRefBlock(rb) {
  if (TrxRefBlockCache) {
    if ((TrxRefBlockCache.number === rb.number) && (TrxRefBlockCache.hash === rb.hash) && (TrxRefBlockCache.timestamp === rb.timestamp)) {
      report("error", "refBlock not match");
    }
  } else {
    TrxRefBlockCache = rb;
  }
  let now = new Date().getTime();
  if ((now < rb.timestamp) || (now - rb.timestamp > 28800)) {
    report("warn", "need update refBlock");
  }
}

async function validateAddTokenPair(tx) {
  let sc = new web3.eth.Contract([tx.abi]);
  try {
    sc.methods[tx.abi.name](...tx.params).encodeABI();
  } catch (err) {
    report("error", "invalid params, encodeABI error");
  }
  let id = tx.params[0];
  let exist = TokenPairMap.get(id);
  if (exist) {
    if (tx.params.toString() !== exist.toString()) {
      report("detail", "-%s", exist.toString());
      report("detail", "+%s", tx.params.toString());
      report("error", "tokenPair %s info not match", id);
    }
  } else {
    let [id, ancestor, fromChainId, fromAccount, toChainId, toAccount] = tx.params;
    let selfChainId = chains[tx.chain].bip44Id.toString();
    if ((fromChainId === toChainId) || ((![fromChainId, toChainId].includes(selfChainId)) && (tx.chain !== "WAN"))) {
      report("error", "invalid fromChainId(%s) or toChainId(%s)", fromChainId, toChainId);
    }
    TokenPairMap.set(id, tx.params);
    let [aAccount, aSymbol, aName, aDecimals, aBip44Id] = ancestor;
    // serial to prevent duplication
    let tis = [], type = "", decimals = undefined;
    tis[0] = await validateToken("ancestor", aBip44Id, aBip44Id, aAccount, aSymbol, aDecimals);
    tis[1] = await validateToken("fromAccount", aBip44Id, fromChainId, fromAccount, aSymbol, aDecimals);
    tis[2] = await validateToken("toAccount", aBip44Id, toChainId, toAccount, aSymbol, aDecimals);
    tis.forEach(ti => {
      if (ti) {
        if (type === "") {
          type = ti.type;
        } else if (type !== ti.type) {
          report("detail", "tokenPair %s token type not match: %s, expected %s", id, ti.type, type);
        }
        if (decimals === undefined) {
          decimals = ti.decimals;
        } else if (decimals !== ti.decimals) { // maybe normal, only warn
          report("warn", "tokenPair %s token decimals not match: %s, expected %s", id, ti.decimals, decimals);
        }
      }
    })
  }
}

async function validateToken(name, ancestorChainId, chainId, tokenAddress, symbol, decimals) {
  let key = chainId + tokenAddress;
  let exist = TokenInfoCache.get(key);
  if (exist !== undefined) {
    return exist;
  }
  let chainType = null, chainInfo = null;
  for (let chain in chains) {
    let ci = chains[chain];
    if (ci.bip44Id == chainId) {
      chainType = chain;
      chainInfo = ci;
      break;
    }
  }
  if (!chainType) {
    report("detail", "%s validateToken invalid chainId: %s", name, chainId);
    TokenInfoCache.set(key, null);
    return null;
  }
  if (tokenAddress == 0) {
    if (name === "toAccount") {
      report("detail", "invalid chain %s %s toAccount: %s", chainType, symbol, tokenAddress);
    }
    TokenInfoCache.set(key, null);
    return null; // coin
  }
  if (chainInfo.tokenManagerProxy === "no") {
    let token = tool.parseTokenPairAccount(chainType, tokenAddress);
    let tokenAccount = token.join(".");
    if (chainType === "XRP") {
      report("warn", "need manually validate %s token: %s => %s", chainType, tokenAccount, "https://livenet.xrpl.org/token/" + tokenAccount);
    } else {
      report("warn", "need manually validate %s token: %s", chainType, chainType);
    }
    TokenInfoCache.set(key, null);
    return null; // not evm
  }
  let iWanChainType = ChainTypeMapping.get(chainType) || chainType;
  let ti = await tool.validateToken(iWanChainType, tokenAddress);
  if (!ti) {
    report("detail", "invalid chain %s %s token: %s", chainType, symbol, tokenAddress);
    TokenInfoCache.set(key, null);
    return null;
  }
  TokenInfoCache.set(key, ti);
  // check symbol
  if (ti.symbol) {
    if (!ti.symbol.includes(symbol)) {
      report("warn", "chain %s %s token %s symbol not match: %s, ancestor %s", chainType, symbol, tokenAddress, ti.symbol, symbol);
    }
  }
  // check wrapped token owner
  let isWrappedToken = true;
  if (chainId == ancestorChainId) {
    isWrappedToken = false;
  } else {
    let origTokens = await tool.iwan.getRegisteredMultiChainOrigToken({chainType: iWanChainType});
    // console.log("chain %s orig tokens: %O", iWanChainType, origTokens);
    if (origTokens.find(v => tool.compAddress(v.tokenScAddr, tokenAddress))) {
      isWrappedToken = false;
    }
  }
  if (isWrappedToken) {
    let expected = chainInfo.tokenManagerProxyEvm || chainInfo.tokenManagerProxy;
    if (ti.type === "Erc20") {
      try {
        let owner = await tool.iwan.callScFunc(iWanChainType, tokenAddress, "owner", [], ownerAbi);
        if (!tool.compAddress(owner, expected)) { // maybe config origToken later
          report("detail", "chain %s wrapped %s token %s owner not match: %s, expected %s", chainType, symbol, tokenAddress, owner, expected);
        }
      } catch (err) { // maybe node is temporarily unavailable
        report("detail", "chain %s wrapped %s token %s owner unknown, expected %s", chainType, symbol, tokenAddress, expected);
      }
    } else { // nft
      try {
        let adminRole = "0x0000000000000000000000000000000000000000000000000000000000000000";
        let isAdmin = await tool.iwan.callScFunc(iWanChainType, tokenAddress, "hasRole", [adminRole, expected], ownerAbi);
        if (!isAdmin) {
          report("detail", "chain %s wrapped %s token %s admin not match, expected %s", chainType, symbol, tokenAddress, expected);
        }
      } catch (err) { // maybe node is temporarily unavailable
        report("detail", "chain %s wrapped %s token %s admin unknown, expected %s", chainType, symbol, tokenAddress, expected);
      }
    }
  }
}

function report(type, ...msg) {
  let text = util.format(...msg);
  if (type === "error") {
    console.log("\x1B[101m%s\x1B[0m", text);
    throw new Error(text);
  } else if (type === "detail") {
    console.log("\x1B[101m%s\x1B[0m", text);
  } else if (type === "warn") {
    console.log("\x1B[43m%s\x1B[0m", text);
  }
  TxReportCache = true;
}