/**
 * People who no longer exist (account deleted, e.g. straight from the database)
 * come back from populate() as null. Every API response that carries people goes
 * through these helpers, so the app never receives a null where it expects a
 * person (that crashed the Chat page: `m.user._id` on a removed member).
 *
 * One pass over the list each: O(n), no extra queries.
 */

/** Stand-in for the sender of messages written by an account that's gone. */
const DELETED_PERSON = Object.freeze({ _id: null, name: "Deleted user", avatarUrl: "" });

/** Conversation (document or plain object) without members or customers whose account is gone. */
const withoutMissingPeople = (conv) => {
  if (!conv) return conv;
  const o = typeof conv.toJSON === "function" ? conv.toJSON() : { ...conv };
  if (Array.isArray(o.members)) o.members = o.members.filter((m) => m && m.user);
  if (o.project && Array.isArray(o.project.customers)) o.project = { ...o.project, customers: o.project.customers.filter(Boolean) };
  return o;
};

/** Message whose sender's account is gone: shown as "Deleted user" instead of null. */
const withSender = (msg) => (msg && msg.sender === null ? { ...msg, sender: DELETED_PERSON } : msg);

module.exports = { withoutMissingPeople, withSender, DELETED_PERSON };
