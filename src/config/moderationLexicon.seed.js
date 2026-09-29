/**
 * Starting word list for the abuse check (admins edit it in Admin → Moderation).
 * English, Hinglish (Hindi in Latin letters) and Hindi (Devanagari).
 *
 * severity: "mild" (rude), "abusive" (slurs, profanity), "threat" (violence —
 * alerts admins immediately). Every matched word counts toward the 5-in-50 rule.
 *
 * Deliberately left out: words with common innocent meanings, e.g. "saala"
 * (brother-in-law), "kutta" (dog), "chod do" (leave it), "maa ki" (mother's),
 * "dekh lunga" (I'll take a look), "pagal", "bc" (because), "kill" on its own.
 * Threats are listed as phrases for the same reason.
 */
module.exports = [
  // ── English: abusive ──
  ...["fuck", "fucker", "fucking", "motherfucker", "fuck off", "fuck you", "shit", "bullshit", "bitch", "bastard", "asshole",
    "dickhead", "prick", "cunt", "whore", "slut", "retard", "dumbass", "scumbag", "piece of shit", "son of a bitch", "screw you"]
    .map((term) => ({ term, severity: "abusive", language: "en" })),
  // ── English: mild ──
  ...["idiot", "stupid", "moron", "loser", "shut up", "useless fellow", "pathetic"]
    .map((term) => ({ term, severity: "mild", language: "en" })),
  // ── English: threats ──
  ...["kill you", "kill u", "will kill", "gonna kill", "i will kill", "beat you up", "break your legs", "break your head",
    "burn your house", "throw acid", "acid attack", "rape", "shoot you", "stab you", "i know where you live", "you are dead",
    "watch your back"]
    .map((term) => ({ term, severity: "threat", language: "en" })),

  // ── Hinglish: abusive ──
  ...["chutiya", "chutiye", "chutia", "madarchod", "maderchod", "bhenchod", "behenchod", "bhanchod", "bhosdike", "bhosdi",
    "bsdk", "gaandu", "harami", "haramkhor", "kamina", "kamine", "randi", "lavda", "lauda", "lund", "jhaat",
    "teri maa ki", "ullu ka pattha", "kutte ki aulad"]
    .map((term) => ({ term, severity: "abusive", language: "hinglish" })),
  // ── Hinglish: mild ──
  ...["bewakoof", "bevkoof", "gadha", "nalayak", "dhokebaaz", "badtameez", "nikamma"]
    .map((term) => ({ term, severity: "mild", language: "hinglish" })),
  // ── Hinglish: threats ──
  ...["maar dunga", "maar daalunga", "jaan se maar", "jaan se maar dunga", "khatam kar dunga", "tod dunga", "haddi tod", "jala dunga", "aag laga dunga", "uthwa lunga", "goli maar", "chaku maar"]
    .map((term) => ({ term, severity: "threat", language: "hinglish" })),

  // ── Hindi (Devanagari) ──
  ...["चूतिया", "चुतिया", "मादरचोद", "भेनचोद", "बहनचोद", "भोसड़ीके", "गांडू", "हरामी", "हरामखोर", "कमीना", "कमीने", "रंडी", "लौड़ा", "तेरी माँ की"]
    .map((term) => ({ term, severity: "abusive", language: "hi" })),
  ...["बेवकूफ", "गधा", "नालायक", "बदतमीज़"].map((term) => ({ term, severity: "mild", language: "hi" })),
  ...["मार दूंगा", "मार डालूंगा", "जान से मार", "खत्म कर दूंगा", "तोड़ दूंगा", "जला दूंगा"]
    .map((term) => ({ term, severity: "threat", language: "hi" }))
];
