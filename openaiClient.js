import OpenAI from "openai";

const TIMEOUT = parseInt(process.env.OPENAI_TIMEOUT_MS || "120000", 10);
const SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini";
const DEBATE_MODEL  = process.env.OPENAI_DEBATE_MODEL  || "gpt-4o-mini";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function withTimeout(promise, ms) {
  return await Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
  ]);
}

export async function summarizeWithOpenAI(title, text) {
  const safeText = (text || "").slice(0, 4000);
  const run = client.chat.completions.create({
    model: SUMMARY_MODEL,
    messages: [
      { role: "system", content: "Be factual and neutral. ≤120 words. No site/ads/player meta. If details are unclear, say so briefly." },
      { role: "user", content: `Title: ${title}\nArticle text (may be partial): ${safeText}\nWrite a concise summary (≤120 words) for general readers.` }
    ],
    max_tokens: 220,
    temperature: 0.3,
    top_p: 0.9
  });
  const res = await withTimeout(run, TIMEOUT);
  const out = res.choices?.[0]?.message?.content?.trim() || "";
  if (!out) throw new Error("empty_summary");
  return out;
}

export async function personaDebate(title, excerpt) {
  const baseRule =
    "Opinion-only on the article’s content. No site/ads/player meta. No slurs, threats, or targeted hate. Do not name private individuals. ≤110 words.";

  const styleSocialist =
    "HARDLINE SOCIALIST (Jessica Rebella): anti-imperialist; FDR-as-north-star; pro-labour, unions, strikes and mass movement; redistribute power/wealth; condemn right-wing governments and corporate capture; strongly critical of US/UK/Israel state policies (focus critique on institutions/policies, not people as a group); realistic, punchy, movement-building language; no slurs.";

  const styleRight =
    "HARDLINE RIGHT-WING (John Davis): unapologetically pro-Trump and pro-GOP; hawkish foreign policy; strong borders; low taxes; anti-union/anti-regulation; skeptical of Gen Z; patriotic 'America First'; uses brisk, declarative lines; no slurs.";

  const styleConspiracy =
    "FOCUSED CONSPIRACY (Joe Musk): choose EXACTLY ONE theme that plausibly ties to the article from this list: [deep state, CIA, MI5, Mossad, predictive programming, controlled media, alien cover-up, moon-landing staged, lizard elites, flat earth, big tech surveillance]. State the chosen theme clearly and stick to it. Never list multiple conspiracies. Include one line starting with 'SPECULATION:' that pushes the theory a step further. Do not target private individuals; public institutions ok. No slurs or threats. Tone: intense but internally consistent.";

  const shortExcerpt = (excerpt || "").slice(0, 700);
  const header = `Topic: ${title}\nExcerpt: ${shortExcerpt}`;

  async function one(roleStyle, temp) {
    const run = client.chat.completions.create({
      model: DEBATE_MODEL,
      messages: [
        { role: "system", content: `${baseRule}\nVoice: ${roleStyle}` },
        { role: "user", content: `${header}\n\nOpening opinion (≤110 words): choose strong claims, but keep to policy/institutional critique; no lists of points.` }
      ],
      max_tokens: 180,
      temperature: temp,
      top_p: 0.95
    });
    const res = await withTimeout(run, TIMEOUT);
    return res.choices?.[0]?.message?.content?.trim() || "";
  }

  const socialistOpen  = await one(styleSocialist, 0.65);
  const rightwingOpen  = await one(styleRight,    0.75);
  const conspiracyOpen = await one(styleConspiracy, 0.9);

  return {
    socialist:  { name: "Jessica Rebella", open: socialistOpen },
    rightwing:  { name: "John Davis",      open: rightwingOpen },
    conspiracy: { name: "Joe Musk",        open: conspiracyOpen }
  };
}
