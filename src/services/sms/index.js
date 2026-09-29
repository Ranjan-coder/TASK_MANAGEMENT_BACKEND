const config = require("../../config/env");
const logger = require("../../utils/logger");
const { maskPhone } = require("../../utils/phone");

/**
 * SMS provider switch. Each provider exposes sendOtp(phoneE164, code).
 *
 * - console: development only — writes the OTP to the server log. Refused in
 *   production (see config/env.js), so real codes never land in production logs.
 * - msg91:   MSG91 OTP via a DLT-approved Flow template. The template must contain
 *   a variable named "otp" (e.g. "##otp## is your Bonito verification code...").
 */
const providers = {
  console: {
    async sendOtp(phone, code) {
      if (config.env === "production") {
        throw new Error("Console SMS provider is disabled in production");
      }
      logger.warn(`[DEV SMS] OTP for ${maskPhone(phone)} (${phone}): ${code}`);
    }
  },

  msg91: {
    async sendOtp(phone, code) {
      const response = await fetch("https://control.msg91.com/api/v5/flow/", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authkey: config.sms.msg91AuthKey
        },
        body: JSON.stringify({
          template_id: config.sms.msg91OtpTemplateId,
          short_url: "0",
          recipients: [{ mobiles: phone.replace(/^\+/, ""), otp: code }]
        }),
        signal: AbortSignal.timeout(10000)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.type === "error") {
        // Never include the code in errors or logs
        throw new Error(`MSG91 send failed (${response.status}): ${body.message || "unknown error"}`);
      }
    }
  }
};

// ── "Your designer replied" alerts (customers who opted in) ─────────────────
// Only generic text: the project name and a link. Never message content.
const alertText = ({ designer, project, url }) => `Bonito: ${designer} replied in your project chat "${project}". Open the app to read it: ${url}`;

const msg91Post = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authkey: config.sms.msg91AuthKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.type === "error" || data.status === "fail") {
    throw new Error(`MSG91 alert failed (${response.status}): ${data.message || data.errors || "unknown error"}`);
  }
  return data;
};

const alertProviders = {
  none: { async send() { return null; } },
  console: {
    async send({ phone, channel, vars }) {
      if (config.env === "production") throw new Error("Console alert provider is disabled in production");
      logger.warn(`[DEV ${channel.toUpperCase()}] to ${maskPhone(phone)}: ${alertText(vars)}`);
      return channel;
    }
  },
  msg91: {
    // WhatsApp needs an approved template with body variables {{1}} designer, {{2}} project, {{3}} link.
    // SMS needs a DLT-approved Flow template with variables "designer", "project", "url".
    async send({ phone, channel, vars }) {
      const mobile = phone.replace(/^\+/, "");
      if (channel === "whatsapp") {
        await msg91Post("https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/", {
          integrated_number: config.alerts.msg91WhatsappNumber,
          content_type: "template",
          payload: {
            messaging_product: "whatsapp",
            type: "template",
            template: {
              name: config.alerts.msg91WhatsappTemplate,
              language: { code: "en", policy: "deterministic" },
              to_and_components: [
                {
                  to: [mobile],
                  components: {
                    body_1: { type: "text", value: vars.designer },
                    body_2: { type: "text", value: vars.project },
                    body_3: { type: "text", value: vars.url }
                  }
                }
              ]
            }
          }
        });
        return "whatsapp";
      }
      await msg91Post("https://control.msg91.com/api/v5/flow/", {
        template_id: config.alerts.msg91SmsTemplateId,
        short_url: "1",
        recipients: [{ mobiles: mobile, designer: vars.designer, project: vars.project, url: vars.url }]
      });
      return "sms";
    }
  }
};

/** Channels this provider can actually use. */
const alertChannels = () => {
  if (config.alerts.provider === "console") return ["whatsapp", "sms"];
  if (config.alerts.provider !== "msg91") return [];
  return [
    ...(config.alerts.msg91WhatsappTemplate && config.alerts.msg91WhatsappNumber ? ["whatsapp"] : []),
    ...(config.alerts.msg91SmsTemplateId ? ["sms"] : [])
  ];
};

const sendAlert = async ({ phone, channel, vars }) => {
  const provider = alertProviders[config.alerts.provider];
  if (!provider) throw new Error(`Unknown ALERT_PROVIDER "${config.alerts.provider}"`);
  return provider.send({ phone, channel, vars });
};

const getSmsProvider = () => {
  const provider = providers[config.sms.provider];
  if (!provider) throw new Error(`Unknown SMS_PROVIDER "${config.sms.provider}"`);
  return provider;
};

module.exports = { getSmsProvider, sendAlert, alertChannels, alertText };
