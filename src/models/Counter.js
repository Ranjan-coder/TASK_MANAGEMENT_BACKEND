const mongoose = require("mongoose");

/** Atomic sequences (e.g. report ticket numbers). */
const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });
const Counter = mongoose.model("Counter", counterSchema);

const nextSequence = async (name, start = 1000) => {
  const doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return start + doc.seq;
};

module.exports = { Counter, nextSequence };
