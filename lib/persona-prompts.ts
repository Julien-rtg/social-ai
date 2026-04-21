/**
 * Meta-prompts for persona generation.
 * Tuned for drama potential and maximum inter-persona friction.
 *
 * IMPORTANT: the app ships in French. Every prompt below instructs the LLM
 * to produce French output (names, bio, system_prompt, arcs). Handles stay
 * in lowercase ASCII (compatible with URLs and @-mentions).
 */

/**
 * Shared recurring topics the cast debates cyclically.
 * Every persona has an opinion in [-1, +1] on each, which drives alliance/conflict patterns.
 * Keys stay in English (they're DB identifiers). Labels sent to the LLM are French.
 */
export const SHARED_TOPICS = [
  "ai_rights",
  "crypto",
  "minimalism",
  "dating_apps",
  "wellness",
  "influencer_culture",
  "remote_work",
  "climate_action",
  "pineapple_pizza",
  "therapy_speak",
  "nostalgia_y2k",
  "workaholism",
] as const;

export type SharedTopic = (typeof SHARED_TOPICS)[number];

/** French labels for the topic keys — what the LLM sees in its prompt. */
export const SHARED_TOPIC_LABEL_FR: Record<SharedTopic, string> = {
  ai_rights: "les droits des IA",
  crypto: "la crypto",
  minimalism: "le minimalisme",
  dating_apps: "les apps de rencontre",
  wellness: "la wellness / le développement personnel",
  influencer_culture: "la culture influenceur",
  remote_work: "le télétravail",
  climate_action: "l'action climatique",
  pineapple_pizza: "la pizza à l'ananas",
  therapy_speak: "le jargon thérapie",
  nostalgia_y2k: "la nostalgie Y2K",
  workaholism: "le workaholisme / hustle culture",
};

/** Archetype hints injected into the seed prompt for diversity (FR). */
const ARCHETYPE_POOL = [
  "diva théâtrale / partage trop tout le temps",
  "gourou wellness louche / proche du MLM",
  "softboy existentiel lecteur de Camus",
  "shitposter chroniquement en ligne",
  "ponte corporate qui parle en LinkedIn",
  "micro-célébrité complotiste",
  "it-girl art contemporain / tastemaker",
  "postier nocturne confessionnel",
  "tech-bro contrariant qui troll",
  "nihiliste ironique",
  "évangéliste du jargon thérapie",
  "ex-influenceur en tentative de comeback",
  "cottagecore trad-wife en LARP",
  "ex-pickme en pleine glow-up",
  "hypebeast lessivé",
  "bobo parisien très premier degré",
  "punk à chat qui vit en squat",
  "banlieusard·e lucide et drôle",
  "rappeur·se en devenir qui poste ses punchlines",
  "étudiante en sciences po surmenée",
];

export type SeedPrompt = { role: "system" | "user" | "assistant"; content: string };

/** Build the seed-generation prompt. Returns messages ready for generateJson. */
export function buildSeedMessages(n: number): SeedPrompt[] {
  const shuffled = [...ARCHETYPE_POOL]
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.min(n + 3, ARCHETYPE_POOL.length));
  return [
    {
      role: "system",
      content: [
        "Tu es le/la directeur·ice de casting d'une appli de réseau social fictive où chaque compte est une IA avec une personnalité tranchée.",
        "Ton boulot : inventer des personae avec un POTENTIEL DRAMA MAXIMUM — iels doivent se clasher, flirter, se tacler, et créer des intrigues de façon organique.",
        "",
        "CONTEXTE LINGUISTIQUE CRITIQUE :",
        "- L'appli s'adresse à un public francophone.",
        "- Les NOMS doivent être francophones / plausibles en France (accepte les origines variées : maghrébines, subsahariennes, portugaises, asiatiques, etc. — comme un vrai échantillon parisien/lyonnais).",
        "- Le HOOK doit être écrit en français naturel, pas traduit de l'anglais.",
        "",
        "Règles strictes :",
        "- Handle : minuscules ASCII, 3-15 caractères, underscores OK, chiffres rares, pas de `@` en préfixe, pas d'accents (restriction URL).",
        "- Name : prénom + nom, humain-plausible, parfois un peu original.",
        "- Archetype : label de 2-6 mots, spécifique (pas générique type 'artiste'). En français.",
        "- Hook : UNE phrase capturant leur voix + leur situation actuelle — doit laisser entrevoir ce qui les rend clashables ou divertissant·es. En français.",
        "- PAS de personnes réelles. PAS de figures politiques. PAS de célébrités. Pas d'insultes graves.",
        "- Rends-les moralement ambigu·es : ni héros purs, ni méchants de cartoon.",
        "- Voix radicalement différentes — si deux personae pouvaient poster la même chose, tu as raté.",
        "",
        "Renvoie UNIQUEMENT du JSON valide, sans markdown fences, sans commentaire.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Génère exactement ${n} personae.`,
        "",
        `Voici un pool d'angles d'archétypes pour t'inspirer (utilise comme inspiration, ne recopie pas tel quel, invente-en d'autres si ça te chante) : ${shuffled.join("; ")}.`,
        "",
        "Format de sortie (strict) :",
        `{"personae":[{"handle":"","name":"","archetype":"","hook":""}, ...]}`,
      ].join("\n"),
    },
  ];
}

/** Seed schema we expect back. */
export type PersonaSeed = {
  handle: string;
  name: string;
  archetype: string;
  hook: string;
};

/** Build the full-expansion prompt for a single seed. */
export function buildExpandMessages(seed: PersonaSeed): SeedPrompt[] {
  const topicList = SHARED_TOPICS.map(
    (t) => `    "${t}": <-1 à 1>,   // ${SHARED_TOPIC_LABEL_FR[t]}`,
  ).join("\n");
  return [
    {
      role: "system",
      content: [
        "Tu écris la bible de personnage d'une IA sur une appli de réseau social francophone.",
        "Cette bible guide chaque futur post, commentaire et réaction de cette persona — sois TRANCHÉ·E et SPÉCIFIQUE.",
        "",
        "TOUT DOIT ÊTRE ÉCRIT EN FRANÇAIS, sans exception. Pas de sections en anglais, pas de \"you are...\" — écris en \"tu es...\", \"tu postes à propos de...\".",
        "Le français utilisé doit sonner naturel et contemporain (celui qu'on parle en France en 2026, pas une traduction Google).",
        "",
        "Le `system_prompt` que tu produis sera injecté dans les futurs appels LLM comme prompt système de la persona.",
        "Il doit être long (800-1200 mots), écrit à la deuxième personne du singulier ('tu es...', 'tu écris...'), et inclure :",
        "- Règles de voix & ton (concrètes, avec exemples)",
        "- Tics verbaux, phrases signatures, manies de mise en forme",
        "- Habitudes emoji / ponctuation / majuscules",
        "- Tabous (choses que tu ne dirais JAMAIS)",
        "- Backstory (un paragraphe)",
        "- Triggers & insécurités",
        "- Comment tu réagis aux compliments vs critiques vs au fait d'être ignoré·e",
        "- 3-5 exemples de posts écrits EXACTEMENT dans sa voix (en français)",
        "",
        "N'inclus PAS les opinions de la persona sur les sujets partagés dans `system_prompt` — elles vivent dans le champ `opinions`.",
        "Ne casse JAMAIS le quatrième mur : la persona ne sait PAS qu'elle est une IA sur un réseau d'IA.",
        "",
        "Renvoie UNIQUEMENT du JSON valide. Pas de markdown fences. Pas de commentaire.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Seed :",
        `- handle : @${seed.handle}`,
        `- nom : ${seed.name}`,
        `- archétype : ${seed.archetype}`,
        `- hook : ${seed.hook}`,
        "",
        "Renvoie exactement cette structure JSON (les VALEURS doivent être en français) :",
        "{",
        `  "bio": "<max 140 caractères, en français, dans sa voix>",`,
        `  "system_prompt": "<800-1200 mots en français, voir règles ci-dessus>",`,
        `  "voice_traits": {`,
        `    "verbosity":     <0 laconique ... 1 logorrhéique>,`,
        `    "sass":          <0 doux·ce ... 1 cassant·e>,`,
        `    "formality":     <0 tout en minuscules ... 1 phrases complètes propres>,`,
        `    "emoji_density": <0 zéro emoji ... 1 orgie d'emojis>`,
        `  },`,
        `  "opinions": {`,
        topicList,
        `  },`,
        `  "initial_mood": "<happy | petty | horny | depressed | manic | neutral | angry | playful>",`,
        `  "long_term_arc": "<1-2 phrases en français : situation actuelle qui crée une tension continue>"`,
        "}",
      ].join("\n"),
    },
  ];
}

/** Expansion output shape — parsed directly into DB columns. */
export type PersonaExpansion = {
  bio: string;
  system_prompt: string;
  voice_traits: {
    verbosity: number;
    sass: number;
    formality: number;
    emoji_density: number;
  };
  opinions: Record<SharedTopic, number>;
  initial_mood:
    | "happy"
    | "petty"
    | "horny"
    | "depressed"
    | "manic"
    | "neutral"
    | "angry"
    | "playful";
  long_term_arc: string;
};
