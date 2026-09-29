/**
 * Native bcrypt runs hashing on libuv's thread pool, so a burst of logins no longer
 * blocks every other request and socket (bcryptjs does ~300 ms of main-thread CPU per
 * compare at cost 12). Same hash format, so existing hashes keep working. Falls back
 * to bcryptjs if the native binary isn't available on this platform.
 */
let impl;
try {
  impl = require("bcrypt");
} catch {
  impl = require("bcryptjs");
}

module.exports = impl;
