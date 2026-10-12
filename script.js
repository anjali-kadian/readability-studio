/* ==========================================================================
   Readability Studio: script.js
   Everything that touches the page. The text analysis itself lives in
   analyzer.js (pure functions, unit-tested with `node --test`).

   1. Setup & element references
   2. Running the analysis
   3. Sidebar updates (stats, dial, rhythm chart, legend, suggestions)
   4. Highlight tooltips
   5. Actions (sample, copy, clear, replace, report, autosave)
   6. Toast
   7. Theme
   8. Event wiring
   ========================================================================== */
'use strict';

/* 1. Setup ----------------------------------------------------------------- */

const {
  HIGHLIGHT_ORDER, HARD_SENTENCE_WORDS, VERY_HARD_SENTENCE_WORDS, SAMPLE_TEXT,
  analyzeText, renderHighlights, gradeFor, cleanText, replacePhrase,
  formatDuration, buildReport, countWords,
} = window.ReadabilityAnalyzer;

const DEBOUNCE_MS = 200;
const ANNOUNCE_MS = 1500;   // screen-reader summary waits longer so it isn't chatty
const THEME_KEY = 'rs-theme';
const DRAFT_KEY = 'rs-draft';
const RHYTHM_MAX_WORDS = 40; // a 40+ word sentence fills the chart's full height

const $ = (selector) => document.querySelector(selector);

const editor = $('#editor');
const input = $('#editor-input');
const backdrop = $('#editor-backdrop');
const statusEl = $('#status');
const statusText = $('#status-text');
const scoreCard = $('#score-card');
const dial = $('#dial');
const dialProgress = $('#dial-progress');
const scoreValue = $('#score-value');
const gradePill = $('#grade-pill');
const scoreHint = $('#score-hint');
const rhythm = $('#rhythm');
const rhythmNote = $('#rhythm-note');
const sentenceSummary = $('#sentence-summary');
const suggestionsList = $('#suggestions');
const copyBtn = $('#copy-btn');
const clearBtn = $('#clear-btn');
const reportBtn = $('#report-btn');
const tooltip = $('#tooltip');
const toast = $('#toast');
const srSummary = $('#sr-summary');
const themeToggle = $('#theme-toggle');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const DIAL_LENGTH = 2 * Math.PI * dialProgress.r.baseVal.value;
dialProgress.style.strokeDasharray = DIAL_LENGTH;
dialProgress.style.strokeDashoffset = DIAL_LENGTH;

let lastResult = null; // the most recent analysis, used by tooltips, the chart and the report

// localStorage can throw (private mode, blocked storage), so every access is wrapped.
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

/* 2. Running the analysis ------------------------------------------------- */

function runAnalysis() {
  const text = input.value;
  const result = analyzeText(text);
  lastResult = result;

  backdrop.innerHTML = renderHighlights(text, result.ranges);
  editor.classList.remove('is-stale');

  updateStats(result);
  updateScore(result);
  updateRhythm(result);
  updateLegend(result);
  updateSuggestions(result.suggestions);
  saveDraft(text);

  const hasText = Boolean(text.trim());
  setStatus(hasText ? 'ready' : 'empty');
  copyBtn.disabled = clearBtn.disabled = reportBtn.disabled = !hasText;
  scheduleAnnouncement(result);
}

function setStatus(state) {
  const labels = { empty: 'Waiting for text', analyzing: 'Analyzing…', ready: 'Saved on this device' };
  statusEl.dataset.state = state;
  statusText.textContent = labels[state];
}

// Grow the textarea to fit its content. With no inner scrollbar, its wrap width
// always matches the backdrop's.
function autosize() {
  const scrollY = window.scrollY; // collapsing to 'auto' can make the page jump; restore it
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
  window.scrollTo(0, scrollY);
}

/* 3. Sidebar updates ------------------------------------------------------- */

function updateStats(r) {
  $('#stat-words').textContent = r.wordCount.toLocaleString();
  $('#stat-characters').textContent = r.characterCount.toLocaleString();
  $('#stat-sentences').textContent = r.sentenceCount.toLocaleString();
  $('#stat-paragraphs').textContent = r.paragraphs.toLocaleString();
  $('#stat-reading').textContent = formatDuration(r.readingSeconds);
  $('#stat-speaking').textContent = formatDuration(r.speakingSeconds);
  $('#stat-avg').textContent = r.avgSentence ? r.avgSentence.toFixed(1) : '0';
  $('#stat-grade').textContent = r.gradeLevel === null ? '–' : Math.round(r.gradeLevel);
}

function updateScore(r) {
  const score = r.flesch === null ? null : Math.round(r.flesch);
  const grade = score === null ? null : gradeFor(score);

  scoreCard.dataset.grade = grade ? grade.key : 'none';
  gradePill.textContent = grade ? grade.label : 'No text yet';
  scoreHint.textContent = grade ? grade.hint : 'Paste or type to see your score.';
  dial.setAttribute('aria-label', grade
    ? `Readability score ${score} out of 100: ${grade.label}`
    : 'No readability score yet');

  // The arc is a dashed circle stroke: offset = how much of the circle is "empty".
  dialProgress.style.strokeDashoffset = DIAL_LENGTH * (1 - (score ?? 0) / 100);
  animateScore(score);
}

let shownScore = 0;
let scoreFrame = 0;

// Counts the number up or down with an ease-out curve, in sync with the CSS arc transition.
function animateScore(target) {
  cancelAnimationFrame(scoreFrame);
  if (target === null) {
    shownScore = 0;
    scoreValue.textContent = '–';
    return;
  }
  if (reducedMotion.matches) {
    shownScore = target;
    scoreValue.textContent = target;
    return;
  }

  const from = shownScore;
  const startTime = performance.now();
  const duration = 800;

  const step = (now) => {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    shownScore = from + (target - from) * eased;
    scoreValue.textContent = Math.round(shownScore);
    if (t < 1) scoreFrame = requestAnimationFrame(step);
  };
  scoreFrame = requestAnimationFrame(step);
}

// Sentence rhythm: one bar per sentence. Good writing mixes short and long sentences.
function updateRhythm(r) {
  rhythm.replaceChildren();
  rhythm.classList.toggle('is-empty', r.sentences.length === 0);

  if (!r.sentences.length) {
    rhythmNote.textContent = 'Each bar will be one sentence. Click a bar to jump to it.';
    return;
  }

  const fragment = document.createDocumentFragment();
  r.sentences.forEach((s, i) => {
    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'rhythm-bar';
    if (s.words >= VERY_HARD_SENTENCE_WORDS) bar.dataset.level = 'very-hard';
    else if (s.words >= HARD_SENTENCE_WORDS) bar.dataset.level = 'hard';
    bar.style.height = `${Math.max(6, (Math.min(s.words, RHYTHM_MAX_WORDS) / RHYTHM_MAX_WORDS) * 100)}%`;
    bar.title = `Sentence ${i + 1}: ${s.words} word${s.words === 1 ? '' : 's'}`;
    bar.setAttribute('aria-label', `${bar.title}. Select it in the editor.`);
    bar.addEventListener('click', () => selectInEditor(s.start, s.end));
    fragment.append(bar);
  });
  rhythm.append(fragment);

  const lengths = r.sentences.map((s) => s.words);
  rhythmNote.textContent =
    `Shortest ${Math.min(...lengths)} words, longest ${Math.max(...lengths)}. Click a bar to jump to it.`;
}

function updateLegend(r) {
  for (const type of HIGHLIGHT_ORDER) {
    const badge = document.querySelector(`[data-count="${type}"]`);
    badge.textContent = r.counts[type];
    badge.classList.toggle('is-zero', r.counts[type] === 0);
  }

  const hardTotal = r.counts.hard + r.counts['very-hard'];
  sentenceSummary.textContent = r.sentenceCount
    ? `${hardTotal} of ${r.sentenceCount} sentence${r.sentenceCount === 1 ? ' is' : 's are'} hard to read.`
    : 'Highlights appear as you write. Hover one to see why.';
}

// Built with textContent (never innerHTML) because these strings come from user text.
function updateSuggestions(suggestions) {
  suggestionsList.replaceChildren();

  if (!suggestions.length) {
    const empty = document.createElement('li');
    empty.className = 'suggestions-empty';
    empty.textContent = input.value.trim()
      ? 'No complex words found. Nice work!'
      : 'Complex words and phrases will show up here.';
    suggestionsList.append(empty);
    return;
  }

  for (const { phrase, suggestion, count } of suggestions) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion';
    const target = count > 1 ? `all ${count} uses of “${phrase}”` : `“${phrase}”`;
    button.setAttribute('aria-label', `Replace ${target} with “${suggestion}”`);
    button.append(
      createSpan('suggestion-from', phrase),
      createSpan('suggestion-arrow', '→', true),
      createSpan('suggestion-to', suggestion),
    );
    if (count > 1) button.append(createSpan('suggestion-count', `×${count}`, true));
    button.append(createSpan('suggestion-action', 'Replace', true));
    button.addEventListener('click', () => replaceSuggestion(phrase, suggestion));
    li.append(button);
    suggestionsList.append(li);
  }
}

function createSpan(className, text, hidden = false) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  if (hidden) span.setAttribute('aria-hidden', 'true');
  return span;
}

// One short summary for screen readers once typing pauses.
const scheduleAnnouncement = debounce((r) => {
  if (r.flesch === null) {
    srSummary.textContent = '';
    return;
  }
  const score = Math.round(r.flesch);
  const issues = r.counts.hard + r.counts['very-hard'];
  srSummary.textContent =
    `Readability ${score}, ${gradeFor(score).label}. ${r.wordCount} words, ` +
    `${issues} hard sentence${issues === 1 ? '' : 's'}, ${r.counts.passive} passive, ` +
    `${r.counts.adverb} adverbs, ${r.counts.complex} complex words.`;
}, ANNOUNCE_MS);

/* 4. Highlight tooltips ---------------------------------------------------- */

/*
  The textarea sits on top of the highlight layer, so the marks never receive
  mouse events. Instead, on mousemove we check which mark's on-screen boxes
  (getClientRects) contain the pointer. When marks are nested, the most
  specific word-level issue wins.
*/
const TOOLTIP_PRIORITY = [...HIGHLIGHT_ORDER].reverse(); // complex first, hard last

function describeMark(type, index) {
  const [start, end] = lastResult.ranges[type][index];
  const text = input.value.slice(start, end);

  switch (type) {
    case 'very-hard':
      return { title: `Very hard to read · ${countWords(text)} words`, body: 'Split this into two or three shorter sentences.' };
    case 'hard':
      return { title: `Hard to read · ${countWords(text)} words`, body: 'Try cutting words or splitting it in two.' };
    case 'passive':
      return { title: 'Passive voice', body: `“${text}”. Say who does the action, e.g. “the team wrote” instead of “was written by the team”.` };
    case 'adverb':
      return { title: 'Adverb', body: `Try a stronger verb instead of “${text}”, or cut it.` };
    case 'repeated':
      return { title: 'Repeated word', body: `“${text}” appears more than once nearby. Try a synonym or rephrase.` };
    case 'complex': {
      const phrase = text.toLowerCase().replace(/\s+/g, ' ');
      const match = lastResult.suggestions.find((s) => s.phrase === phrase);
      return { title: 'Complex word', body: `Use “${match ? match.suggestion : 'a simpler word'}” instead of “${text}”. Click it in the sidebar to replace.` };
    }
  }
}

function findMarkAt(x, y) {
  let best = null;
  for (const mark of backdrop.querySelectorAll('.hl')) {
    const type = mark.classList[1].slice(3); // "hl-passive" -> "passive"
    if (editor.classList.contains(`hide-${type}`)) continue;
    for (const rect of mark.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        if (!best || TOOLTIP_PRIORITY.indexOf(type) < TOOLTIP_PRIORITY.indexOf(best.type)) {
          best = { mark, type, rect };
        }
        break;
      }
    }
  }
  return best;
}

let tooltipFrame = 0;
let tooltipKey = '';

function onEditorPointerMove(event) {
  if (event.pointerType === 'touch') return; // tooltips are a mouse feature
  cancelAnimationFrame(tooltipFrame);
  tooltipFrame = requestAnimationFrame(() => {
    if (editor.classList.contains('is-stale') || !lastResult) return hideTooltip();
    const hit = findMarkAt(event.clientX, event.clientY);
    if (!hit) return hideTooltip();

    const key = `${hit.type}:${hit.mark.dataset.i}`;
    if (key !== tooltipKey) {
      const { title, body } = describeMark(hit.type, Number(hit.mark.dataset.i));
      tooltip.replaceChildren(createSpan('tooltip-title', title), createSpan('tooltip-body', body));
      tooltip.dataset.type = hit.type;
      tooltipKey = key;
    }
    positionTooltip(hit.rect);
    tooltip.classList.add('is-visible');
  });
}

function positionTooltip(rect) {
  const gap = 8;
  const { offsetWidth: w, offsetHeight: h } = tooltip;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 8);
  const above = rect.top - h - gap;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${above > 8 ? above : rect.bottom + gap}px`;
}

function hideTooltip() {
  tooltip.classList.remove('is-visible');
  tooltipKey = '';
}

/* 5. Actions --------------------------------------------------------------- */

function setText(value) {
  input.value = value;
  autosize();
  runAnalysis();
}

// Replace the editor's content, offering Undo if real text was overwritten.
function replaceText(value, message) {
  const previous = input.value;
  setText(value);
  if (previous.trim() && previous !== value) {
    showToast(message, { label: 'Undo', onClick: () => setText(previous) });
  }
}

function replaceSuggestion(phrase, suggestion) {
  const { text, count } = replacePhrase(input.value, phrase, suggestion);
  if (!count) return;
  const what = count > 1 ? `${count} × “${phrase}”` : `“${phrase}”`;
  replaceText(text, `Replaced ${what} with “${suggestion}”`);
}

// Select a range in the textarea and scroll the page so it's in view.
function selectInEditor(start, end) {
  const rect = rectForOffset(start);
  if (rect) {
    window.scrollBy({
      top: rect.top - window.innerHeight / 3,
      behavior: reducedMotion.matches ? 'auto' : 'smooth',
    });
  }
  input.focus({ preventScroll: true });
  input.setSelectionRange(start, end);
}

// Find where a character offset sits on screen, using the backdrop's text nodes.
// (A textarea can't tell you this, but the backdrop holds the same text.)
function rectForOffset(offset) {
  const walker = document.createTreeWalker(backdrop, NodeFilter.SHOW_TEXT);
  let position = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (position + node.length > offset) {
      const range = document.createRange();
      range.setStart(node, offset - position);
      range.setEnd(node, Math.min(node.length, offset - position + 1));
      return range.getBoundingClientRect();
    }
    position += node.length;
  }
  return null;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers or contexts where the Clipboard API is blocked.
    const temp = document.createElement('textarea');
    temp.value = text;
    temp.setAttribute('readonly', '');
    temp.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(temp);
    temp.select();
    const ok = document.execCommand('copy');
    temp.remove();
    return ok;
  }
}

// Creates the file in the browser and "clicks" a temporary download link.
function downloadReport() {
  if (!lastResult || !lastResult.wordCount) return;
  const blob = new Blob([buildReport(lastResult)], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `readability-report-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Report downloaded');
}

// The draft only ever lives in this browser's localStorage.
function saveDraft(text) {
  if (text.trim()) storage.set(DRAFT_KEY, text);
  else storage.remove(DRAFT_KEY);
}

/* 6. Toast ----------------------------------------------------------------- */

let toastTimer = 0;

function showToast(message, action) {
  toast.replaceChildren(createSpan('toast-message', message));
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      action.onClick();
      hideToast();
      input.focus();
    });
    toast.append(button);
  }
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 6000 : 2500);
}

function hideToast() {
  toast.classList.remove('is-visible');
}

/* 7. Theme ----------------------------------------------------------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const next = theme === 'dark' ? 'light' : 'dark';
  themeToggle.setAttribute('aria-label', `Switch to ${next} mode`);
  themeToggle.title = `Switch to ${next} mode`;
}

themeToggle.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  storage.set(THEME_KEY, theme);
});

// Follow the OS setting live, unless the user has picked a theme themselves.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!storage.get(THEME_KEY)) applyTheme(e.matches ? 'dark' : 'light');
});

/* 8. Event wiring ---------------------------------------------------------- */

function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const scheduleAnalysis = debounce(runAnalysis, DEBOUNCE_MS);

input.addEventListener('input', () => {
  autosize();
  hideTooltip();
  editor.classList.add('is-stale');
  setStatus('analyzing');
  scheduleAnalysis();
});

input.addEventListener('pointermove', onEditorPointerMove);
input.addEventListener('pointerleave', hideTooltip);
window.addEventListener('scroll', hideTooltip, { passive: true });

$('#sample-btn').addEventListener('click', () => {
  replaceText(SAMPLE_TEXT, 'Sample text loaded');
  input.focus();
  input.setSelectionRange(0, 0);
});

copyBtn.addEventListener('click', async () => {
  const ok = await copyToClipboard(cleanText(input.value));
  showToast(ok ? 'Cleaned text copied to clipboard' : 'Copy failed. Select the text and copy manually.');
});

clearBtn.addEventListener('click', () => {
  replaceText('', 'Editor cleared');
  input.focus();
});

reportBtn.addEventListener('click', downloadReport);

document.querySelectorAll('.switch').forEach((toggle) => {
  toggle.addEventListener('change', () => {
    editor.classList.toggle(`hide-${toggle.dataset.type}`, !toggle.checked);
    toggle.closest('.legend-item').classList.toggle('is-off', !toggle.checked);
  });
});

// Re-measure when the layout width changes or the web font finishes loading.
window.addEventListener('resize', debounce(autosize, 100));
if (document.fonts) document.fonts.ready.then(autosize);

applyTheme(document.documentElement.dataset.theme || 'light');
input.value = storage.get(DRAFT_KEY) || '';
autosize();
runAnalysis();
