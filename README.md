# Readability Studio

> Paste your writing and instantly see how readable it is, with live, color-coded highlights for the sentences and words that slow readers down.

**[Live demo →](https://readability-studio.vercel.app)**

![Readability Studio screenshot](screenshot.png)
<!-- Add a screenshot: load the sample text, take a screenshot, save it as screenshot.png in the repo root. -->

Readability Studio is a writing assistant inspired by the Hemingway Editor. It analyzes your text as you type and gives you a Flesch Reading Ease score. It also highlights long sentences, passive voice, adverbs, repeated words and complex phrases that have simpler alternatives.

It's built with **plain HTML, CSS and JavaScript**, with no frameworks, no build step and no backend. **Your text never leaves your browser.**

---

## Features

- **Live analysis** that updates as you type (debounced, so it stays smooth on long documents)
- **Six highlight types**, each with its own color and an on/off switch:
  - 🟨 Hard-to-read sentences (20–29 words)
  - 🟥 Very hard sentences (30+ words)
  - 🟩 Passive voice (*"was written"*, *"is being done"*)
  - 🟦 Adverbs (words ending in *-ly*, with a list of exceptions like *only*, *family*, *friendly*)
  - 🟧 Repeated words close together (including typos like *"the the"*)
  - 🟪 Complex words and phrases with simpler alternatives (*utilize → use*, *in order to → to*)
- **Hover tooltips** on every highlight that explain the problem and how to fix it
- **One-click fixes:** click a suggestion like *utilized → used* to replace every use of it. The right word form and capitalization are kept, and you can Undo.
- **Animated score dial** for the Flesch Reading Ease score, with a grade label: Easy, Standard or Difficult
- **Statistics:** words, characters, sentences, paragraphs, reading time, speaking time, average sentence length and Flesch–Kincaid grade level
- **Sentence rhythm chart:** one bar per sentence, with long ones in yellow and red. Click a bar to jump to that sentence.
- **Download report:** saves a Markdown summary of the score, stats, long sentences and suggestions
- **Autosave:** your draft is kept in your browser's local storage, so a refresh never loses it
- **Load sample text** so you can try it instantly
- **Copy cleaned text**, which removes stray spaces, extra blank lines and spaces before punctuation
- **Clear** with an Undo option
- **Light and dark mode** that follows your system setting by default and remembers your choice
- **Responsive**: the editor and sidebar sit side by side on desktop and stack on mobile
- **Accessible**: keyboard friendly, native switches, ARIA labels, a skip link, a screen-reader summary of the results and support for reduced motion
- **Private**: no tracking, no server, no AI, no data sent anywhere. Every check is a plain, readable rule in `analyzer.js`.

## How it works

### Highlighting inside a textarea

A `<textarea>` can't contain colored text, so the editor is built from **two stacked layers**:

1. A **backdrop `<div>`** behind the textarea. It holds the same text with `<mark>` tags around each issue. Its text is transparent, so you only see the colored backgrounds.
2. A **transparent `<textarea>`** on top, which is what you actually type into.

Both layers share one CSS class for font, size, line height, padding and wrapping, so every character lands in the same place. The textarea auto-grows to fit its content, so it never shows a scrollbar, which would change its wrap width and push the highlights out of line.

I chose this over a `contenteditable` editor because a real textarea keeps native undo/redo, plain-text paste, spellcheck, mobile keyboards and screen-reader support. A contenteditable editor has to rebuild its HTML on every analysis, which moves the cursor and breaks undo history.

### Overlapping highlights

A complex word can sit inside a passive phrase inside a long sentence. The renderer collects every range's start and end point, which cuts the text into segments where the active highlights don't change. Each segment is then wrapped in nested `<mark>` tags in a fixed priority order. Word-level highlights draw on top of sentence-level ones. Turning a type off just adds a CSS class (for example `.hide-adverb`), so toggles are instant and don't need to re-analyze the text.

### The readability score

```
Flesch Reading Ease = 206.835 − 1.015 × (words ÷ sentences) − 84.6 × (syllables ÷ words)
```

Syllables are counted with a common heuristic: count vowel groups and drop silent endings like *-e* and *-es*. Scores of **70+** are *Easy*, **60–69** are *Standard* (plain English) and **below 60** are *Difficult*, following Flesch's original scale.

## Run locally

No install needed.

```bash
git clone https://github.com/anjali-kadian/readability-studio.git
cd readability-studio
```

Then open `index.html` in your browser. To serve it locally instead (closer to how GitHub Pages serves it):

```bash
python -m http.server 8000
```

and visit <http://localhost:8000>.

## Run the tests

The analysis engine has 21 unit tests that use Node's built-in test runner, so there's nothing to install. You just need [Node.js](https://nodejs.org) 18 or newer.

```bash
node --test
```

The tests cover sentence splitting (abbreviations, decimals, initials), syllable counting, each highlight type, the Flesch score, HTML escaping, find-and-replace and the report.

## Tech used

- **HTML5**: semantic landmarks, ARIA labels, native form controls
- **CSS3**: custom properties for theming, CSS Grid and Flexbox, sticky positioning, transitions, `prefers-reduced-motion`
- **Vanilla JavaScript (ES2020+)**: regular expressions with Unicode property escapes, `matchAll`, `requestAnimationFrame`, the Clipboard API and `localStorage`
- **SVG** for the animated score dial (`stroke-dasharray` / `stroke-dashoffset`)
- **Google Fonts**: [Inter](https://fonts.google.com/specimen/Inter) for the interface and [Source Serif 4](https://fonts.google.com/specimen/Source+Serif+4) for the editor
- **Vercel** for free hosting (also mirrored on GitHub Pages)

## Project structure

```
readability-studio/
├── index.html              # Page structure and accessible markup
├── style.css               # Design tokens, light/dark themes, layout, highlight colors
├── analyzer.js             # Pure text analysis: no DOM, works in the browser and Node
├── script.js               # Everything that touches the page: UI, tooltips, chart, actions
├── tests/
│   └── analyzer.test.js    # Unit tests (node --test)
└── README.md
```

`analyzer.js` holds the **pure analysis functions** (text in, numbers and ranges out). `script.js` holds the **UI code** that updates the page. Because the analyzer never touches the page, the same file runs in the browser and in Node, which is what makes it unit-testable without a build step.

## What I learned

- **Mirroring a textarea with a highlight layer**, and why exact typography matching matters: one pixel of different padding throws every highlight off.
- **Writing a small text-analysis engine** with regular expressions: splitting sentences without breaking on "Dr." or "3.14", detecting passive voice, and keeping character offsets so the results can be drawn back onto the text.
- **Rendering overlapping ranges** by splitting text at every range boundary and nesting `<mark>` tags by priority.
- **Debouncing input** so the UI stays responsive, and showing a subtle "analyzing" state while it waits.
- **Theming with CSS custom properties**, respecting `prefers-color-scheme`, saving the user's choice, and avoiding a flash of the wrong theme with a tiny inline script.
- **Accessibility in practice**: native controls over custom divs, ARIA labels, live regions that don't spam screen readers, visible focus styles and reduced motion support.
- **Security basics**: escaping user text before inserting HTML, and using `textContent` instead of `innerHTML` for anything user-generated.
- **Tooltips over a layer that can't receive the mouse**: the textarea covers the highlights, so I find which highlight is under the pointer with `getClientRects()`.
- **Testing without tools**: keeping the logic in a DOM-free module so Node's built-in test runner can check it.

## Future improvements

- Keyboard shortcuts (for example, step through issues one by one)
- Let users add their own words to the complex-word list
- Export the report as PDF as well as Markdown
- A "focus mode" that hides the sidebar while writing

## License

MIT. Feel free to use and adapt.
