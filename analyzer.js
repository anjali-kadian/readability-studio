/* ==========================================================================
   Readability Studio: analyzer.js
   Pure text analysis with no DOM access: text in, numbers and ranges out.
   Works in the browser (as window.ReadabilityAnalyzer) and in Node (for tests).

   1. Configuration & word lists
   2. Counting helpers (words, syllables, sentences)
   3. Issue detectors (passive, adverbs, repeated, complex)
   4. analyzeText(): the main entry point
   5. Rendering ranges as highlight HTML
   6. Text utilities (clean, replace, report)
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // Node
  else root.ReadabilityAnalyzer = api;                                     // browser
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 1. Configuration & word lists ----------------------------------------- */

  const WORDS_PER_MINUTE = 238;   // average adult silent reading speed
  const SPEAKING_WPM = 130;       // comfortable presentation pace
  const HARD_SENTENCE_WORDS = 20;
  const VERY_HARD_SENTENCE_WORDS = 30;
  const REPEAT_WINDOW = 10;       // flag a word if it appears again within this many words

  // Outer -> inner. When highlights overlap, inner types are drawn on top.
  // So a complex word inside a long sentence shows purple, not yellow.
  const HIGHLIGHT_ORDER = ['very-hard', 'hard', 'repeated', 'adverb', 'passive', 'complex'];

  // Words like "Dr." and "e.g." end in a period but don't end a sentence.
  const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'e.g', 'i.e',
    'inc', 'ltd', 'fig', 'approx', 'dept', 'est', 'u.s', 'a.m', 'p.m',
  ]);

  // Words ending in -ly that are not adverbs (nouns, verbs, adjectives, names).
  const ADVERB_EXCEPTIONS = new Set([
    'only', 'family', 'reply', 'apply', 'supply', 'imply', 'comply', 'rely', 'ally', 'rally',
    'tally', 'bully', 'belly', 'jelly', 'holly', 'jolly', 'folly', 'lily', 'ugly', 'holy',
    'july', 'italy', 'emily', 'kelly', 'sally', 'molly', 'polly', 'dolly', 'assembly',
    'anomaly', 'monopoly', 'butterfly', 'dragonfly', 'firefly', 'multiply', 'friendly',
    'unfriendly', 'lovely', 'lonely', 'lively', 'costly', 'elderly', 'likely', 'unlikely',
    'early', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'hourly', 'nightly',
    'deadly', 'silly', 'chilly', 'hilly', 'curly', 'burly', 'surly', 'oily', 'homily',
    'melancholy', 'smelly', 'wobbly', 'bubbly', 'cuddly', 'prickly', 'ghostly', 'orderly',
    'scholarly', 'worldly', 'heavenly', 'cowardly', 'timely', 'untimely', 'comely', 'unruly',
  ]);

  // Passive voice = a form of "to be" + a past participle ("was written").
  const PASSIVE_RE = /\b(?:am|is|are|was|were|be|been|being)(?:\s+(?:not|never))?(?:\s+being)?(?:\s+[a-z]+ly)?\s+([a-z]+)\b/gi;

  const IRREGULAR_PARTICIPLES = new Set([
    'awoken', 'beaten', 'become', 'begun', 'bent', 'bitten', 'blown', 'born', 'borne',
    'bound', 'broken', 'brought', 'built', 'burnt', 'bought', 'caught', 'chosen', 'come',
    'cut', 'dealt', 'done', 'drawn', 'driven', 'drunk', 'eaten', 'fallen', 'fed', 'felt',
    'fought', 'found', 'forbidden', 'forgiven', 'forgotten', 'frozen', 'given', 'gone',
    'grown', 'held', 'hidden', 'hit', 'hung', 'hurt', 'kept', 'known', 'laid', 'led',
    'left', 'lent', 'let', 'lit', 'lost', 'made', 'meant', 'met', 'mistaken', 'overtaken',
    'paid', 'proven', 'put', 'quit', 'read', 'ridden', 'risen', 'run', 'said', 'seen',
    'sent', 'set', 'shaken', 'shot', 'shown', 'shut', 'sold', 'sought', 'spent', 'spoken',
    'spread', 'stolen', 'struck', 'stuck', 'sung', 'sworn', 'swept', 'taken', 'taught',
    'thought', 'thrown', 'told', 'torn', 'understood', 'undone', 'upset', 'withdrawn',
    'woken', 'won', 'worn', 'written',
  ]);

  // Words ending in -ed that are not past participles.
  const ED_EXCEPTIONS = new Set([
    'need', 'seed', 'feed', 'weed', 'deed', 'reed', 'heed', 'shed', 'sled', 'indeed',
    'speed', 'breed', 'bleed', 'proceed', 'exceed', 'succeed', 'greed', 'embed', 'hundred',
    'sacred', 'kindred', 'naked', 'wicked', 'ragged', 'rugged', 'crooked', 'beloved',
    'wretched', 'jagged',
  ]);

  // Ignored by the repeated-word check (too common to be worth flagging).
  const STOPWORDS = new Set([
    'that', 'this', 'with', 'from', 'have', 'they', 'their', 'there', 'which', 'what',
    'were', 'will', 'would', 'been', 'your', 'about', 'into', 'than', 'then', 'them',
    'these', 'those', 'some', 'more', 'most', 'very', 'also', 'just', 'when', 'where',
    'each', 'other', 'such', 'only', 'over', 'does', 'being', 'could', 'should',
    'because', 'while', 'after', 'before', 'through', 'here', 'like', 'well',
  ]);

  // Complex word -> simpler replacement, for every form of the word, so one-click
  // fixes stay grammatical ("utilized" -> "used", not "use").
  const verb = (forms, replacements) =>
    forms.map((form, i) => [form, replacements[i]]);

  const COMPLEX_WORDS = new Map([
    ...verb(['utilize', 'utilizes', 'utilized', 'utilizing'], ['use', 'uses', 'used', 'using']),
    ...verb(['utilise', 'utilises', 'utilised', 'utilising'], ['use', 'uses', 'used', 'using']),
    ...verb(['facilitate', 'facilitates', 'facilitated', 'facilitating'], ['help', 'helps', 'helped', 'helping']),
    ...verb(['commence', 'commences', 'commenced', 'commencing'], ['start', 'starts', 'started', 'starting']),
    ...verb(['terminate', 'terminates', 'terminated', 'terminating'], ['end', 'ends', 'ended', 'ending']),
    ...verb(['demonstrate', 'demonstrates', 'demonstrated', 'demonstrating'], ['show', 'shows', 'showed', 'showing']),
    ...verb(['purchase', 'purchases', 'purchased', 'purchasing'], ['buy', 'buys', 'bought', 'buying']),
    ...verb(['endeavor', 'endeavors', 'endeavored', 'endeavoring'], ['try', 'tries', 'tried', 'trying']),
    ...verb(['endeavour', 'endeavours', 'endeavoured', 'endeavouring'], ['try', 'tries', 'tried', 'trying']),
    ...verb(['obtain', 'obtains', 'obtained', 'obtaining'], ['get', 'gets', 'got', 'getting']),
    ...verb(['ascertain', 'ascertains', 'ascertained', 'ascertaining'], ['find out', 'finds out', 'found out', 'finding out']),
    ...verb(['initiate', 'initiates', 'initiated', 'initiating'], ['start', 'starts', 'started', 'starting']),
    ...verb(['implement', 'implements', 'implemented', 'implementing'], ['carry out', 'carries out', 'carried out', 'carrying out']),
    ...verb(['possess', 'possesses', 'possessed', 'possessing'], ['have', 'has', 'had', 'having']),
    ...verb(['inquire', 'inquires', 'inquired', 'inquiring'], ['ask', 'asks', 'asked', 'asking']),
    ...verb(['accomplish', 'accomplishes', 'accomplished', 'accomplishing'], ['finish', 'finishes', 'finished', 'finishing']),
    ...verb(['leverage', 'leverages', 'leveraged', 'leveraging'], ['use', 'uses', 'used', 'using']),
    ...verb(['transmit', 'transmits', 'transmitted', 'transmitting'], ['send', 'sends', 'sent', 'sending']),
    ...verb(['eliminate', 'eliminates', 'eliminated', 'eliminating'], ['remove', 'removes', 'removed', 'removing']),
    ['utilization', 'use'],
    ['approximately', 'about'],
    ['additional', 'extra'],
    ['assistance', 'help'],
    ['sufficient', 'enough'],
    ['numerous', 'many'],
    ['individuals', 'people'],
    ['subsequently', 'later'],
    ['regarding', 'about'],
    ['modification', 'change'],
    ['modifications', 'changes'],
    ['consequently', 'so'],
    ['nevertheless', 'still'],
    ['optimal', 'best'],
    ['methodology', 'method'],
    ['functionality', 'features'],
    ['beverage', 'drink'],
    ['beverages', 'drinks'],
    ['residence', 'home'],
    ['in order to', 'to'],
    ['prior to', 'before'],
    ['due to the fact that', 'because'],
    ['in the event that', 'if'],
    ['at this point in time', 'now'],
    ['the majority of', 'most'],
    ['a large number of', 'many'],
    ['a number of', 'some'],
    ['with regard to', 'about'],
    ['with regards to', 'about'],
    ['in spite of the fact that', 'although'],
    ['on a daily basis', 'daily'],
    ['in close proximity to', 'near'],
  ]);

  // One regex for the whole list. Longest phrases first, so "a large number of"
  // wins over "a number of". Spaces become \s+ so phrases match across line breaks.
  const COMPLEX_RE = new RegExp(
    `\\b(?:${[...COMPLEX_WORDS.keys()]
      .sort((a, b) => b.length - a.length)
      .map(phraseToPattern)
      .join('|')})\\b`,
    'gi',
  );

  // A word = letters/digits, optionally joined by apostrophes or hyphens ("don't", "well-known").
  const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

  const SAMPLE_TEXT = `Readability Studio shows you where your writing gets hard to read. Paste your draft here and watch it light up.

The quarterly report was written by the team in order to facilitate a better understanding of the numerous changes that were implemented during the last approximately six months of the project.

We really need to utilize simpler words, because readers quickly lose interest when every sentence feels extremely heavy and slow to get through.

Short sentences work. They give the reader room to breathe.

The review is being done right now. Each draft is checked, and every draft gets a draft score before the editor sees it.

Try it yourself: delete this sample, paste your own writing, and use the switches on the right to focus on one issue at a time.`;

  /* 2. Counting helpers --------------------------------------------------- */

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function phraseToPattern(phrase) {
    return escapeRegExp(phrase).replace(/ /g, '\\s+');
  }

  function normalizePhrase(str) {
    return str.toLowerCase().replace(/\s+/g, ' ');
  }

  function getWords(text) {
    return Array.from(text.matchAll(WORD_RE), (m) => ({
      word: m[0],
      lower: m[0].toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
    }));
  }

  function countWords(text) {
    return (text.match(WORD_RE) || []).length;
  }

  // Heuristic syllable counter. Not perfect, but this is what most Flesch tools do.
  function countSyllables(word) {
    let w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return 1;              // numbers and non-Latin words count as one
    if (w.length <= 3) return 1;
    w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '') // silent endings: "makes", "liked", "make"
         .replace(/^y/, '');                              // leading y is a consonant: "yellow"
    const vowelGroups = w.match(/[aeiouy]{1,2}/g);
    return vowelGroups ? vowelGroups.length : 1;
  }

  function isAbbreviation(textBeforePeriod) {
    const match = textBeforePeriod.match(/([A-Za-z.]+)$/);
    if (!match) return false;
    const token = match[1];
    // Single capital letters are initials: "J. K. Rowling"
    return ABBREVIATIONS.has(token.toLowerCase()) || /^[A-Z]$/.test(token);
  }

  // Returns [{ start, end, text, words }] with character offsets into the original
  // text, so we can highlight the exact sentence later. A line break always ends a sentence.
  function splitSentences(text) {
    const sentences = [];
    const lineRe = /[^\n]+/g;
    let line;

    while ((line = lineRe.exec(text))) {
      const lineText = line[0];
      const offset = line.index;
      // ., ! or ? (plus closing quotes/brackets) followed by whitespace or end of line.
      // Requiring whitespace after keeps "3.14" and "example.com" in one piece.
      const endRe = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
      let start = 0;
      let m;

      while ((m = endRe.exec(lineText))) {
        if (m[0][0] === '.' && isAbbreviation(lineText.slice(start, m.index))) continue;
        pushSentence(sentences, text, offset + start, offset + m.index + m[0].length);
        start = m.index + m[0].length;
      }
      pushSentence(sentences, text, offset + start, offset + lineText.length);
    }
    return sentences;
  }

  function pushSentence(list, text, start, end) {
    // Trim whitespace so the highlight hugs the words.
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    const slice = text.slice(start, end);
    if (slice && /[\p{L}\p{N}]/u.test(slice)) {
      list.push({ start, end, text: slice, words: countWords(slice) });
    }
  }

  /* 3. Issue detectors ---------------------------------------------------- */

  function isPastParticiple(word) {
    return IRREGULAR_PARTICIPLES.has(word) ||
      (word.length >= 4 && word.endsWith('ed') && !ED_EXCEPTIONS.has(word));
  }

  function findPassive(text) {
    const ranges = [];
    for (const m of text.matchAll(PASSIVE_RE)) {
      if (isPastParticiple(m[1].toLowerCase())) ranges.push([m.index, m.index + m[0].length]);
    }
    return ranges;
  }

  function findAdverbs(words) {
    return words
      .filter((w) => /^[a-z]{2,}ly$/.test(w.lower) && !ADVERB_EXCEPTIONS.has(w.lower))
      .map((w) => [w.start, w.end]);
  }

  function findRepeated(words) {
    const lastSeen = new Map(); // word -> index of its last occurrence
    const flagged = new Set();

    words.forEach((w, i) => {
      if (/^\d+$/.test(w.lower)) return;
      const prev = lastSeen.get(w.lower);
      if (prev !== undefined) {
        const gap = i - prev;
        const isDoubled = gap === 1; // "the the" is always worth flagging
        const isNearby = gap <= REPEAT_WINDOW && w.lower.length > 3 && !STOPWORDS.has(w.lower);
        if (isDoubled || isNearby) {
          flagged.add(prev);
          flagged.add(i);
        }
      }
      lastSeen.set(w.lower, i);
    });

    return [...flagged].sort((a, b) => a - b).map((i) => [words[i].start, words[i].end]);
  }

  function findComplex(text) {
    const ranges = [];
    const found = new Map(); // phrase -> { phrase, suggestion, count }

    for (const m of text.matchAll(COMPLEX_RE)) {
      ranges.push([m.index, m.index + m[0].length]);
      const phrase = normalizePhrase(m[0]);
      const entry = found.get(phrase) || { phrase, suggestion: COMPLEX_WORDS.get(phrase), count: 0 };
      entry.count++;
      found.set(phrase, entry);
    }

    const suggestions = [...found.values()].sort((a, b) => b.count - a.count);
    return { ranges, suggestions };
  }

  /* 4. analyzeText -------------------------------------------------------- */

  // Flesch Reading Ease: higher = easier. 60-70 is "plain English".
  // 206.835 - 1.015 x (words / sentences) - 84.6 x (syllables / words)
  function analyzeText(text) {
    const words = getWords(text);
    const sentences = splitSentences(text);
    const paragraphs = text.split(/\n+/).filter((p) => p.trim()).length;
    const syllables = words.reduce((sum, w) => sum + countSyllables(w.word), 0);

    const raw = { 'very-hard': [], hard: [] };
    for (const s of sentences) {
      if (s.words >= VERY_HARD_SENTENCE_WORDS) raw['very-hard'].push([s.start, s.end]);
      else if (s.words >= HARD_SENTENCE_WORDS) raw.hard.push([s.start, s.end]);
    }

    const complex = findComplex(text);
    raw.passive = findPassive(text);
    raw.adverb = findAdverbs(words);
    raw.repeated = findRepeated(words);
    raw.complex = complex.ranges;

    const counts = {};
    const ranges = {};
    for (const type of HIGHLIGHT_ORDER) {
      counts[type] = raw[type].length;
      ranges[type] = mergeRanges(raw[type]);
    }

    const wordCount = words.length;
    const sentenceCount = sentences.length;
    let flesch = null;
    let gradeLevel = null;
    let avgSentence = 0;

    if (wordCount > 0 && sentenceCount > 0) {
      const wordsPerSentence = wordCount / sentenceCount;
      const syllablesPerWord = syllables / wordCount;
      flesch = clamp(206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord, 0, 100);
      gradeLevel = Math.max(0, 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59); // Flesch–Kincaid
      avgSentence = wordsPerSentence;
    }

    return {
      wordCount,
      characterCount: [...text].length, // counts emoji as one character, not two
      sentenceCount,
      paragraphs,
      syllables,
      readingSeconds: (wordCount / WORDS_PER_MINUTE) * 60,
      speakingSeconds: (wordCount / SPEAKING_WPM) * 60,
      avgSentence,
      flesch,
      gradeLevel,
      sentences,
      ranges,
      counts,
      suggestions: complex.suggestions,
    };
  }

  function gradeFor(score) {
    if (score >= 70) return { key: 'easy', label: 'Easy', hint: 'Clear and easy to follow for most readers.' };
    if (score >= 60) return { key: 'standard', label: 'Standard', hint: 'Plain English. Shorter sentences would make it even easier.' };
    return { key: 'difficult', label: 'Difficult', hint: 'Dense going. Try shorter sentences and simpler words.' };
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  /* 5. Rendering ---------------------------------------------------------- */

  function escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Sort ranges and merge any that overlap, so each type is a clean, ordered list.
  function mergeRanges(ranges) {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of sorted) {
      const last = merged[merged.length - 1];
      if (last && start < last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    return merged;
  }

  /*
    Turns text + ranges into HTML with nested <mark> tags.
    1. Collect every start/end point of every range. These cut the text into segments
       where the set of active highlights doesn't change.
    2. For each segment, find which types cover it (one moving pointer per type, so it's fast).
    3. Wrap the segment in a <mark> per type, innermost type first.
    Each mark gets data-i = the index of its range, so tooltips can look up details later.
  */
  function renderHighlights(text, ranges) {
    const lists = {};
    const points = new Set([0, text.length]);

    for (const type of HIGHLIGHT_ORDER) {
      lists[type] = mergeRanges(ranges[type] || []);
      for (const [start, end] of lists[type]) {
        points.add(start);
        points.add(end);
      }
    }

    const bounds = [...points].sort((a, b) => a - b);
    const cursor = Object.fromEntries(HIGHLIGHT_ORDER.map((type) => [type, 0]));
    let html = '';

    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i];
      const b = bounds[i + 1];
      let chunk = escapeHTML(text.slice(a, b));

      for (let j = HIGHLIGHT_ORDER.length - 1; j >= 0; j--) {
        const type = HIGHLIGHT_ORDER[j];
        const list = lists[type];
        while (cursor[type] < list.length && list[cursor[type]][1] <= a) cursor[type]++;
        const range = list[cursor[type]];
        if (range && range[0] <= a && range[1] >= b) {
          chunk = `<mark class="hl hl-${type}" data-i="${cursor[type]}">${chunk}</mark>`;
        }
      }
      html += chunk;
    }
    return html;
  }

  /* 6. Text utilities ----------------------------------------------------- */

  function cleanText(text) {
    return text
      .replace(/\r\n?/g, '\n')         // normalize Windows line endings
      .replace(/[ \t]+$/gm, '')        // trailing spaces on each line
      .replace(/[ \t]{2,}/g, ' ')      // runs of spaces -> one space
      .replace(/ +([,.;:!?])/g, '$1')  // "word ," -> "word,"
      .replace(/\n{3,}/g, '\n\n')      // at most one blank line between paragraphs
      .trim();
  }

  // Keep the original's capitalization: "Utilize" -> "Use", "UTILIZE" -> "USE".
  function matchCase(original, replacement) {
    if (original.length > 1 && original === original.toUpperCase() && original !== original.toLowerCase()) {
      return replacement.toUpperCase();
    }
    if (original[0] !== original[0].toLowerCase()) {
      return replacement[0].toUpperCase() + replacement.slice(1);
    }
    return replacement;
  }

  // Replace every occurrence of a phrase. Returns { text, count }.
  function replacePhrase(text, phrase, replacement) {
    const re = new RegExp(`\\b${phraseToPattern(phrase)}\\b`, 'gi');
    let count = 0;
    const result = text.replace(re, (match) => {
      count++;
      return matchCase(match, replacement);
    });
    return { text: result, count };
  }

  function formatDuration(seconds) {
    if (seconds === 0) return '0 min';
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec`;
    return `${Math.round(seconds / 60)} min`;
  }

  // A Markdown summary of the analysis, for the "Download report" button.
  function buildReport(result, date = new Date()) {
    const score = result.flesch === null ? null : Math.round(result.flesch);
    const lines = [
      '# Readability report',
      '',
      `_Generated by Readability Studio on ${date.toISOString().slice(0, 10)}._`,
      '',
      '## Score',
      '',
      score === null
        ? '- No text to score.'
        : `- **Flesch Reading Ease:** ${score} / 100 (${gradeFor(score).label})`,
      `- **Grade level:** ${result.gradeLevel === null ? 'n/a' : Math.round(result.gradeLevel)}`,
      '',
      '## Statistics',
      '',
      '| Metric | Value |',
      '| --- | --- |',
      `| Words | ${result.wordCount} |`,
      `| Characters | ${result.characterCount} |`,
      `| Sentences | ${result.sentenceCount} |`,
      `| Paragraphs | ${result.paragraphs} |`,
      `| Average sentence | ${result.avgSentence.toFixed(1)} words |`,
      `| Reading time | ${formatDuration(result.readingSeconds)} |`,
      `| Speaking time | ${formatDuration(result.speakingSeconds)} |`,
      '',
      '## Issues found',
      '',
      `- Very hard sentences (30+ words): ${result.counts['very-hard']}`,
      `- Hard sentences (20–29 words): ${result.counts.hard}`,
      `- Passive voice: ${result.counts.passive}`,
      `- Adverbs: ${result.counts.adverb}`,
      `- Repeated words: ${result.counts.repeated}`,
      `- Complex words: ${result.counts.complex}`,
    ];

    const longSentences = result.sentences.filter((s) => s.words >= HARD_SENTENCE_WORDS);
    if (longSentences.length) {
      lines.push('', '## Sentences to shorten', '');
      longSentences.forEach((s, i) => {
        lines.push(`${i + 1}. **${s.words} words:** ${s.text.replace(/\s+/g, ' ')}`);
      });
    }

    if (result.suggestions.length) {
      lines.push('', '## Simpler alternatives', '');
      for (const { phrase, suggestion, count } of result.suggestions) {
        lines.push(`- "${phrase}" → "${suggestion}"${count > 1 ? ` (×${count})` : ''}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  return {
    HIGHLIGHT_ORDER,
    HARD_SENTENCE_WORDS,
    VERY_HARD_SENTENCE_WORDS,
    SAMPLE_TEXT,
    analyzeText,
    splitSentences,
    countSyllables,
    countWords,
    findPassive,
    gradeFor,
    renderHighlights,
    mergeRanges,
    escapeHTML,
    cleanText,
    replacePhrase,
    matchCase,
    formatDuration,
    buildReport,
  };
});
