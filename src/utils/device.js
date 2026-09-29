/**
 * Human-readable device label from a user agent, e.g. "Chrome on Windows".
 * Only used for display in the devices list and sign-in alerts.
 */
const describeDevice = (userAgent = "") => {
  const ua = String(userAgent);
  const browser =
    (/Edg\//.test(ua) && "Edge") ||
    (/OPR\/|Opera/.test(ua) && "Opera") ||
    (/SamsungBrowser/.test(ua) && "Samsung Internet") ||
    (/Chrome\//.test(ua) && "Chrome") ||
    (/Firefox\//.test(ua) && "Firefox") ||
    (/Safari\//.test(ua) && "Safari") ||
    (/node|curl|axios|undici/i.test(ua) && "Script") ||
    "Browser";
  const os =
    (/Android/.test(ua) && "Android") ||
    (/iPhone|iPad|iPod/.test(ua) && "iOS") ||
    (/Windows/.test(ua) && "Windows") ||
    (/Mac OS X|Macintosh/.test(ua) && "macOS") ||
    (/Linux/.test(ua) && "Linux") ||
    "unknown OS";
  return `${browser} on ${os}`;
};

module.exports = { describeDevice };
