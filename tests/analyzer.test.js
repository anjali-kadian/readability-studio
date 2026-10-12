// Unit tests for analyzer.js, using Node's built-in test runner (no install needed).
// Run from the project folder with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../analyzer.js');

// Helper: the actual text covered by each range of a given type.
const flagged = (text, type) =>
  A.analyzeText(text).ranges[type].map(([s, e]) => text.slice(s, e));

test('empty text has no score and no issues', () => {
  const r = A.analyzeText('');
  assert.equal(r.wordCount, 0);
  assert.equal(r.sentenceCount, 0);
  assert.equal(r.flesch, null);
  assert.equal(r.gradeLevel, null);
  assert.deepEqual(Object.values(r.counts), [0, 0, 0, 0, 0, 0]);
});

test('counts words, characters, sentences and paragraphs', () => {
  const r = A.analyzeText("Hello world. It's a well-known fact!\n\nNew paragraph here?");
  assert.equal(r.wordCount, 9); // "It's" and "well-known" count as one word each
  assert.equal(r.sentenceCount, 3);
  assert.equal(r.paragraphs, 2);
  assert.equal(A.analyzeText('héllo 👋').characterCount, 7); // emoji counts as one
});

test('sentence splitting ignores abbreviations, initials and decimals', () => {
  const texts = A.splitSentences('Dr. Smith paid $3.50 for it, e.g. lunch. J. K. Rowling agreed. Done!')
    .map((s) => s.text);
  assert.deepEqual(texts, [
    'Dr. Smith paid $3.50 for it, e.g. lunch.',
    'J. K. Rowling agreed.',
    'Done!',
  ]);
});

test('a line break always ends a sentence', () => {
  assert.equal(A.splitSentences('A heading\nThen some text.').length, 2);
});

test('syllable counter handles common words', () => {
  // It's a rule-of-thumb counter (like most Flesch tools): it gets common words right
  // but misses some, e.g. "beautiful" counts as 4.
  const cases = { cat: 1, make: 1, table: 2, computer: 3, readability: 5, yellow: 2, '2026': 1 };
  for (const [word, expected] of Object.entries(cases)) {
    assert.equal(A.countSyllables(word), expected, word);
  }
});

test('flags 20-29 word sentences as hard and 30+ as very hard', () => {
  const sentence = (n) => Array(n).fill('cat').join(' ') + '.';
  assert.equal(A.analyzeText(sentence(19)).counts.hard, 0);
  assert.equal(A.analyzeText(sentence(20)).counts.hard, 1);
  assert.equal(A.analyzeText(sentence(29)).counts['very-hard'], 0);
  assert.equal(A.analyzeText(sentence(30)).counts['very-hard'], 1);
  assert.equal(A.analyzeText(sentence(30)).counts.hard, 0); // not double-counted
});

test('detects passive voice, including irregular and continuous forms', () => {
  assert.deepEqual(flagged('The book was written by her.', 'passive'), ['was written']);
  assert.deepEqual(flagged('It is being done now.', 'passive'), ['is being done']);
  assert.deepEqual(flagged('Mistakes were not noticed.', 'passive'), ['were not noticed']);
  assert.deepEqual(flagged('The cake was quickly eaten.', 'passive'), ['was quickly eaten']);
  assert.deepEqual(flagged('She is happy. It is indeed true.', 'passive'), []);
});

test('detects adverbs but skips -ly words that are not adverbs', () => {
  assert.deepEqual(flagged('She really ran quickly.', 'adverb'), ['really', 'quickly']);
  assert.deepEqual(flagged('My only friendly family reply came early.', 'adverb'), []);
});

test('detects repeated words nearby, and doubled words like "the the"', () => {
  assert.deepEqual(flagged('The draft is good and the draft is long.', 'repeated'), ['draft', 'draft']);
  assert.deepEqual(flagged('I saw the the cat.', 'repeated'), ['the', 'the']);
  // Common words are ignored unless doubled.
  assert.deepEqual(flagged('This is that and this is that.', 'repeated'), []);
});

test('repeated words far apart are not flagged', () => {
  const filler = Array(12).fill('cat').join(' ');
  const text = `garden ${filler.replace(/cat/g, (m, i) => `w${i}`)} garden`;
  assert.deepEqual(flagged(text, 'repeated'), []);
});

test('finds complex words with grammatical suggestions', () => {
  const r = A.analyzeText('We utilized it in order to win. They utilize tools. A large number of people came.');
  const map = Object.fromEntries(r.suggestions.map((s) => [s.phrase, s.suggestion]));
  assert.equal(map.utilized, 'used');
  assert.equal(map.utilize, 'use');
  assert.equal(map['in order to'], 'to');
  assert.equal(map['a large number of'], 'many'); // longest phrase wins
  assert.equal(map['a number of'], undefined);
});

test('complex phrases match across line breaks', () => {
  assert.equal(A.analyzeText('We did it in order\nto win.').counts.complex, 1);
});

test('Flesch score is clamped to 0-100 and graded', () => {
  assert.equal(A.analyzeText('Hi. Go.').flesch, 100);
  const dense = 'Internationalization institutionalization characteristically overcomplicates organizational responsibilities.';
  assert.equal(A.analyzeText(dense).flesch, 0);
  assert.equal(A.gradeFor(75).label, 'Easy');
  assert.equal(A.gradeFor(65).label, 'Standard');
  assert.equal(A.gradeFor(40).label, 'Difficult');
});

test('the sample text triggers every highlight type', () => {
  const r = A.analyzeText(A.SAMPLE_TEXT);
  for (const type of A.HIGHLIGHT_ORDER) {
    assert.ok(r.counts[type] > 0, `expected at least one "${type}" highlight`);
  }
});

test('renderHighlights escapes HTML and nests marks by priority', () => {
  const html = A.renderHighlights('<b>x</b>', { complex: [], passive: [], adverb: [], repeated: [], hard: [], 'very-hard': [] });
  assert.equal(html, '&lt;b&gt;x&lt;/b&gt;');

  const nested = A.renderHighlights('abc', { hard: [[0, 3]], complex: [[1, 2]] });
  assert.equal(
    nested,
    '<mark class="hl hl-hard" data-i="0">a</mark>' +
    '<mark class="hl hl-hard" data-i="0"><mark class="hl hl-complex" data-i="0">b</mark></mark>' +
    '<mark class="hl hl-hard" data-i="0">c</mark>',
  );
});

test('rendered highlights keep the text identical to the input', () => {
  const r = A.analyzeText(A.SAMPLE_TEXT);
  const plain = A.renderHighlights(A.SAMPLE_TEXT, r.ranges).replace(/<[^>]+>/g, '');
  assert.equal(plain, A.escapeHTML(A.SAMPLE_TEXT));
});

test('mergeRanges merges overlapping ranges only', () => {
  assert.deepEqual(A.mergeRanges([[5, 8], [0, 3], [2, 4], [8, 9]]), [[0, 4], [5, 8], [8, 9]]);
});

test('cleanText tidies whitespace and punctuation spacing', () => {
  assert.equal(A.cleanText('  Hello   world ,  ok .  \r\n\r\n\r\n\nNext   line  '), 'Hello world, ok.\n\nNext line');
});

test('replacePhrase replaces every match and keeps capitalization', () => {
  const { text, count } = A.replacePhrase('Utilize it. We utilize. UTILIZE!', 'utilize', 'use');
  assert.equal(text, 'Use it. We use. USE!');
  assert.equal(count, 3);
  assert.equal(A.replacePhrase('In order\nto win', 'in order to', 'to').text, 'To win');
  assert.equal(A.replacePhrase('utilized', 'utilize', 'use').count, 0); // whole words only
});

test('formatDuration', () => {
  assert.equal(A.formatDuration(0), '0 min');
  assert.equal(A.formatDuration(0.2), '1 sec');
  assert.equal(A.formatDuration(33), '33 sec');
  assert.equal(A.formatDuration(150), '3 min');
});

test('buildReport includes score, stats, long sentences and suggestions', () => {
  const report = A.buildReport(A.analyzeText(A.SAMPLE_TEXT), new Date('2026-10-12T12:00:00Z'));
  assert.match(report, /^# Readability report/);
  assert.match(report, /2026-10-12/);
  assert.match(report, /\*\*Flesch Reading Ease:\*\* \d+ \/ 100/);
  assert.match(report, /## Sentences to shorten/);
  assert.match(report, /"utilize" → "use"/);
});
