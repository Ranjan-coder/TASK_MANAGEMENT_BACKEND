const crypto = require("crypto");
const { stampFranking, verifyReveal, isCommitment } = require("../src/utils/franking");

const conversation = "64b7f0c2a1b2c3d4e5f60718";
const sender = "64b7f0c2a1b2c3d4e5f60719";
const commit = (fk, text) => crypto.createHmac("sha256", Buffer.from(fk, "base64")).update(text, "utf8").digest("base64");

const send = (text) => {
  const frankingKey = crypto.randomBytes(32).toString("base64");
  const franking = stampFranking({ commitment: commit(frankingKey, text), conversationId: conversation, senderId: sender });
  return { frankingKey, message: { conversation, sender, franking } };
};

describe("message franking", () => {
  test("a genuine reveal verifies (including emoji and Hindi)", () => {
    const text = "Namaste 🙏 — कल मिलते हैं";
    const { frankingKey, message } = send(text);
    expect(verifyReveal(message, { text, frankingKey })).toBe(true);
  });

  test("altered text, a different key or another sender fail", () => {
    const { frankingKey, message } = send("You will get the quote tomorrow");
    expect(verifyReveal(message, { text: "You will never get the quote", frankingKey })).toBe(false);
    expect(verifyReveal(message, { text: "You will get the quote tomorrow", frankingKey: crypto.randomBytes(32).toString("base64") })).toBe(false);
    expect(verifyReveal({ ...message, sender: "64b7f0c2a1b2c3d4e5f60720" }, { text: "You will get the quote tomorrow", frankingKey })).toBe(false);
    expect(verifyReveal({ ...message, conversation: "64b7f0c2a1b2c3d4e5f60721" }, { text: "You will get the quote tomorrow", frankingKey })).toBe(false);
  });

  test("a commitment edited in the database fails the server tag", () => {
    const { message } = send("original");
    const fk = crypto.randomBytes(32).toString("base64");
    const forged = { ...message, franking: { ...message.franking, commitment: commit(fk, "forged") } };
    expect(verifyReveal(forged, { text: "forged", frankingKey: fk })).toBe(false);
  });

  test("messages without franking and malformed input are rejected", () => {
    expect(verifyReveal({ conversation, sender }, { text: "x", frankingKey: crypto.randomBytes(32).toString("base64") })).toBe(false);
    const { message } = send("hi");
    expect(verifyReveal(message, { text: "hi", frankingKey: "short" })).toBe(false);
    expect(stampFranking({ commitment: "not-base64", conversationId: conversation, senderId: sender })).toBeUndefined();
    expect(isCommitment(crypto.randomBytes(32).toString("base64"))).toBe(true);
    expect(isCommitment(crypto.randomBytes(16).toString("base64"))).toBe(false);
  });
});
