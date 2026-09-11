const ipaddr = require("ipaddr.js");
const dns = require("dns").promises;

const isPrivateOrLoopback = (ip) => {
  try {
    const parsed = ipaddr.parse(ip);
    const range = parsed.range();
    return ["loopback", "private", "linkLocal", "uniqueLocal", "carrierGradeNat", "broadcast"].includes(range);
  } catch {
    return true; // Treat invalid IP parsing as potentially unsafe
  }
};

const validateSafeUrl = async (urlString) => {
  const url = new URL(urlString);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Invalid protocol. Only HTTP and HTTPS are permitted.");
  }
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses || addresses.length === 0) {
    throw new Error("Unable to resolve hostname.");
  }
  for (const { address } of addresses) {
    if (isPrivateOrLoopback(address)) {
      throw new Error("Access to private/internal network addresses is prohibited.");
    }
  }
  return true;
};

module.exports = { validateSafeUrl, isPrivateOrLoopback };
