const erc20Abi = require('./abis/erc20');
const erc721Abi = require('./abis/erc721');
const erc1155Abi = require('./abis/erc1155');
const iwanSdk = require('iwan-sdk');

const iwanCfg = {
  apiKey: "fe087b6462f11bae832a9b397b7f65dddd123b4116932317c77a6a02fd622902",
  secretKey: "c314dc740b96eca90182ff0788a655a14e57deedfd41e4755169da1f605db2f2",
  options: {
    url: "api.wanchain.org",
    port: 8443,
    flag: "ws",
    version: "v3",
    timeout: 300000
  }
};

const iwan = new iwanSdk(iwanCfg.apiKey, iwanCfg.secretKey, iwanCfg.options);

function compAddress(a, b) {
  return a.toLowerCase().substr(-40) === b.toLowerCase().substr(-40);
}

function hexStrip0x(hex) {
  if (hex.indexOf('0x') === 0) {
    return hex.slice(2);
  }
  return hex;
}

function ascii2letter(asciiStr) {
  let len = asciiStr.length;
  if (len % 2 != 0) {
      return '';
  }
  let letterStr = [];
  for (var i = 0; i < len; i = i + 2) {
      let tmp = asciiStr.substr(i, 2);
      if (tmp != '00') {
        letterStr.push(String.fromCharCode(parseInt(tmp, 16)));
      } else { // invalid ascii
        return '';
      }
  }
  return letterStr.join('');
}

function xrpNormalizeCurrencyCode(currencyCode, maxLength = 20) {
  if (!currencyCode) {
    return "";
  }
  if (currencyCode.length === 3 && currencyCode.trim().toLowerCase() !== 'xrp') {
      // "Standard" currency code
      return currencyCode.trim();
  }
  if (currencyCode.match(/^[a-fA-F0-9]{40}$/) && !isNaN(parseInt(currencyCode, 16))) {
      // Hexadecimal currency code
      const hex = currencyCode.toString().replace(/(00)+$/g, '');
      if (hex.startsWith('01')) {
          // Old demurrage code. https://xrpl.org/demurrage.html
          return xrpConvertDemurrageToUTF8(currencyCode);
      }
      if (hex.startsWith('02')) {
          // XLS-16d NFT Metadata using XLS-15d Concise Transaction Identifier
          // https://github.com/XRPLF/XRPL-Standards/discussions/37
          const xlf15d = Buffer.from(hex, 'hex').slice(8).toString('utf-8').slice(0, maxLength).trim();
          if (xlf15d.match(/[a-zA-Z0-9]{3,}/) && xlf15d.toLowerCase() !== 'xrp') {
              return xlf15d;
          }
      }
      const decodedHex = Buffer.from(hex, 'hex').toString('utf-8').slice(0, maxLength).trim();
      if (decodedHex.match(/[a-zA-Z0-9]{3,}/) && decodedHex.toLowerCase() !== 'xrp') {
          // ASCII or UTF-8 encoded alphanumeric code, 3+ characters long
          return decodedHex;
      }
  }
  return "";
}

function xrpConvertDemurrageToUTF8(demurrageCode) {
  let bytes = Buffer.from(demurrageCode, "hex");
  let code = String.fromCharCode(bytes[1]) + String.fromCharCode(bytes[2]) + String.fromCharCode(bytes[3]);
  let interest_start = (bytes[4] << 24) + (bytes[5] << 16) + (bytes[6] <<  8) + (bytes[7]);
  let interest_period = bytes.readDoubleBE(8);
  const year_seconds = 31536000; // By convention, the XRP Ledger's interest/demurrage rules use a fixed number of seconds per year (31536000), which is not adjusted for leap days or leap seconds
  let interest_after_year = Math.pow(Math.E, (interest_start+year_seconds - interest_start) / interest_period)
  let interest = (interest_after_year * 100) - 100;
  return (`${code} (${interest}% pa)`);
}

function parseTokenPairAccount(chain, tokenAccount, normalizeCurrency = true) {
  if (chain === "XRP") {
    let tokenInfo = ascii2letter(hexStrip0x(tokenAccount));
    let [issuer, currency] = tokenInfo.split(":");
    if (normalizeCurrency) {
      currency = xrpNormalizeCurrencyCode(currency);
    }
    return [currency, issuer];
  } else {
    return [tokenAccount];
  }
}

async function validateToken(chainType, sc) {
  try { // validate Erc20 and Erc721
    let [name, symbol] = await Promise.all([
      iwan.callScFunc(chainType, sc, "name", [], erc20Abi),
      iwan.callScFunc(chainType, sc, "symbol", [], erc20Abi),
      iwan.callScFunc(chainType, sc, "balanceOf", [sc], erc20Abi)
    ]);
    // continue to check Erc20 and Erc721
    let [erc20Info, erc721Info] = await Promise.all([
      validateErc20(chainType, sc),
      validateErc721(chainType, sc)
    ]);
    if (erc20Info) {
      return {name, symbol, type: 'Erc20', decimals: erc20Info.decimals};
    } else if (erc721Info) {
      return {name, symbol, type: 'Erc721', decimals: 0};
    }
  } catch (err) {
    // do nothing
  }

  try { // validate Erc1155
    let [supportErc1155, ] = await Promise.all([
      iwan.callScFunc(chainType, sc, "supportsInterface", ["0xd9b67a26"], erc1155Abi),
      iwan.callScFunc(chainType, sc, "balanceOf", [sc, 0], erc1155Abi)
    ]);
    if (supportErc1155) {
      let name = "Erc1155 token", symbol = ""; // name and symbol is not standard interface for Erc1155
      try {
        name = await iwan.callScFunc(chainType, sc, "name", [], erc20Abi);
      } catch (e) {
        // do nothing, use default name
      }
      try {
        symbol = await iwan.callScFunc(chainType, sc, "symbol", [], erc20Abi);
      } catch (e) {
        // do nothing, use default symbol
      }
      return {name, symbol, type: 'Erc1155', decimals: 0};
    } else {
      return null;
    }
  } catch (err) {
    return null;
  }
}

async function validateErc20(chainType, sc) {
  try {
    let [decimals, , ] = await Promise.all([
      iwan.callScFunc(chainType, sc, "decimals", [], erc20Abi),
      iwan.callScFunc(chainType, sc, "totalSupply", [], erc20Abi),
      iwan.callScFunc(chainType, sc, "allowance", [sc, sc], erc20Abi)
    ]);
    return {decimals: parseInt(decimals)};
  } catch(e) {
    return null;
  }
}

async function validateErc721(chainType, sc) {
  try {
    await Promise.all([
      iwan.callScFunc(chainType, sc, "isApprovedForAll", [sc, sc], erc721Abi),
      iwan.callScFunc(chainType, sc, "supportsInterface", ["0x150b7a02"], erc721Abi)
    ]);
    return true;
  } catch(e) {
    return false;
  }
}

module.exports = {
  iwan,
  compAddress,
  parseTokenPairAccount,
  validateToken
}