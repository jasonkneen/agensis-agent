'use strict';

// The publication guard for the agent repository (opensourceplan.md §4).
//
// This is the gate that stands between the working tree and a public snapshot.
// It reads every file this repository would actually publish — tracked files
// plus non-ignored untracked files, exactly `git ls-files --cached --others
// --exclude-standard` — and fails with `path:line`, a category, and an excerpt
// for anything that must not ship.
//
// WHY THIS REPOSITORY NEEDS ITS OWN COPY
//
// This is the published daemon: `@agensis/agensis-agent` is already on npm, so
// anything that reaches `packages/agensis-agent/bin/agensis.mjs` is public the
// moment a tag is pushed and cannot be recalled afterwards. The build minifies
// with `legalComments: 'none'`, which strips comments but PRESERVES every string
// literal, so a contaminated string in the readable source ships verbatim while
// a contaminated comment does not. The gate therefore scans the generated bundle
// as a first-class file rather than trusting that the source scan covered it,
// and an anti-vacuity test below asserts the bundle really was read.
//
// WHY IT IS BUILT THE WAY IT IS
//
// A hygiene gate has two failure modes and only one of them is visible. The
// obvious one is missing a violation. The quiet one is crying wolf: a rule that
// flags `git clone` in the README, the MIT licence's own "copy of this
// software", or the daemon's own "must never reimplement the rule" comments
// produces so much noise that the next person deletes the test rather than
// reads it. A gate nobody runs guards nothing. So the fuzzy categories here are
// deliberately TWO-SIGNAL: a transfer verb on its own is never a violation,
// because this codebase describes its own internals with transfer verbs and
// means itself every time. A transfer verb only fails when its OBJECT is
// external.
//
// SELF-CONTAMINATION
//
// This file is scanned by its own scan; it is not on any exclusion list, and
// `exclusion list is empty` is an assertion below. That is only possible
// because no contaminated literal is ever written out here:
//   - prohibited names are stored as regex sources with one letter bracketed
//     (`hilo[s]`), which matches the real word but is not the real word;
//   - positive fixtures are assembled from fragments at runtime.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

// This file's own repo-relative path. Used by the anti-vacuity checks to prove
// the scan reached it — NOT to skip it.
const SELF = 'tests/public-source-hygiene.test.cjs';

// The generated, published artifact. Everything readable in here has already
// shipped to npm, so it is the single most important file in the scan.
const BUNDLE = 'packages/agensis-agent/bin/agensis.mjs';

// Paths the scan is allowed to skip. It is EMPTY, and a test asserts it stays
// empty. Every exclusion is a place a violation can hide, so adding one needs a
// written reason and a reviewer, not a quiet append.
const EXCLUDED_PATHS = new Set();

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const CATEGORY = {
  PERSONAL: 'personal-source-path-or-identity',
  EXTRACTION: 'extraction/provenance marker',
  TRANSFER: 'copying/porting/imitation construction',
  IDENTITY: 'prohibited competitor/source identity',
  CLOSED: 'private/closed-source claim',
  ASSET: 'undocumented binary asset',
};

// ---------------------------------------------------------------------------
// Prohibited identities (opensourceplan.md §1 and §2)
// ---------------------------------------------------------------------------
//
// Each `word` is a REGEX SOURCE with one letter in a character class, so the
// plain name never appears in this file. `identityWord()` recovers the plain
// spelling by stripping the brackets (and any escaping backslash), and a test
// asserts every pattern still matches its own recovered spelling — a typo here
// would otherwise produce a rule that silently matches nothing.
//
// What is NOT here matters as much as what is. This daemon exists to drive
// other people's tools, so operational integrations, runtimes, dependencies and
// public protocols stay, and there are a lot of them: Claude, Codex, Amp,
// Cursor, Qwen, Anthropic, OpenAI, GitHub, npm, Netlify, e2b, ws, Baileys,
// signal-cli, WhatsApp, Signal — plus two first-party Agensis names that read
// like source products and are not:
//   `CursorBuddy` — an Agensis feature with its own connection-key format
//     (`cbk_…`), backend routes and local bridge (`cursorbuddyConnect.mjs`,
//     `cursorbuddyLocalBridge.mjs`). It is this product's own vocabulary and it
//     is on the wire, so renaming it would be a protocol break, not a cleanup.
//   `OpenClaw` — a third-party local gateway the daemon connects to as an
//     operator CLIENT over ws://127.0.0.1:18789 (`startOpenClaw` in
//     bridges.mjs). A declared integration, like Slack or Discord would be.
const PROHIBITED_IDENTITIES = [
  { word: 'hilo[s]', why: 'superseded branding; must not resurface in public source' },
  { word: 'openpat[h]', why: 'source product credited in a visual-editor comment' },
  { word: 'buz[z]', why: 'source product named in opensourceplan.md §2' },
  { word: 'vibecla[w]', why: 'source product named in opensourceplan.md §2' },
  { word: 'almostnod[e]', why: 'source product named in opensourceplan.md §2' },
  { word: 'clus[o]', why: 'source product named in opensourceplan.md §2' },
  { word: 'blosso[m]', why: 'source product named in opensourceplan.md §2' },
  { word: 'tinyworl[d]', why: 'source-associated theme identifier; §2 requires a rename' },
  { word: 'openagent[s]', why: 'competitor named in comparison material (§1)' },
  { word: 'agentforc[e]', why: 'competitor named in comparison material (§1)' },
  { word: 'bolt\\.ne[w]', why: 'competitor named in comparison material (§1)' },
];

/** The plain spelling a bracketed pattern stands for, brackets and escapes removed. */
function identityWord(source) {
  return source.replace(/[[\]\\]/g, '');
}

/**
 * The plain word a BRACKETED source stands for, asserting it is really on the
 * prohibited list. Callers pass the bracketed form (`openpat[h]`) so that
 * looking an identity up never spells it out — a lookup keyed on the plain word
 * would reintroduce the literal this whole file is arranged to avoid, and this
 * file's own scan would then flag it.
 */
function identityFor(bracketedSource) {
  const entry = PROHIBITED_IDENTITIES.find((e) => e.word === bracketedSource);
  if (!entry) throw new Error(`"${bracketedSource}" is not on the prohibited list`);
  return identityWord(entry.word);
}

const IDENTITY_ALTERNATION = PROHIBITED_IDENTITIES.map((e) => e.word).join('|');

// ---------------------------------------------------------------------------
// Transfer language
// ---------------------------------------------------------------------------

// Verbs that DESCRIBE a transfer. On their own these are ordinary engineering
// English in this repo, so none of them fails by itself.
const TRANSFER_VERB = [
  'borrow(?:ed|ing)?',
  'copied',
  'cop(?:y|ies|ying)',
  'port(?:ed|ing)?',
  're-?implement(?:ed|ing|ation|s)?',
  're-?creat(?:e|ed|ing|ion)',
  'reverse[-\\s]?engineer(?:ed|ing)?',
  'clon(?:e|ed|ing)',
  'mirror(?:s|ed|ing)?',
  // `modelled`/`modeling` only. Bare "model" is a domain noun here (model id,
  // model selector, shared model, `--model`) and matches hundreds of lines.
  'modell?(?:ed|ing)',
  'imitat(?:e|ed|es|ing|ion)',
  'inspired',
  'lift(?:ed)?',
  'replicat(?:e|ed|es|ing|ion)',
  'verbatim',
  'transferred',
  'adapted',
  'derived',
].join('|');

// The transfer verb, in the shapes that take an object.
const TRANSFER_VERB_PHRASE =
  '(?:' +
  [
    'borrow(?:ed|ing)?\\s+from',
    'copied\\s+from',
    'cop(?:y|ies|ying)\\s+(?:of|from)',
    'port(?:ed|ing)?\\s+(?:it\\s+|this\\s+|that\\s+)?from',
    'reverse[-\\s]?engineer(?:ed|ing)?\\s+(?:from|the)?',
    're-?implement(?:ed|ing)?\\s+',
    're-?creat(?:e|ed|ing)\\s+',
    'clon(?:e|ed|ing)\\s+(?:of|from)',
    'lifted\\s+from',
    'verbatim\\s+from',
    'adapted\\s+from',
    'derived\\s+from',
    'based\\s+on',
    'inspired\\s+by',
    'modell?ed\\s+(?:on|after)',
    'imitat(?:e|ed|es|ing|ion\\s+of)\\s*',
    'replicat(?:e|ed|es|ing)\\s+',
    'transferred\\s+from',
  ].join('|') +
  ')';

// The second signal: an object that can only be something OUTSIDE this project.
//
// The determiner is the whole trick. "copied from the host", "the same shape as
// memory.mjs" and "must never reimplement the rule" all point at this daemon's
// own nouns and all pass. "copied from A PRIOR hand-rolled
// implementation" and "borrowed from <name>'S inspector" name a foreign thing
// and both fail. (Those two examples are deliberately wrapped mid-phrase: the
// scan is line-based, and an unwrapped example would be a real finding in this
// very file.)
//
// `client`, `app` and bare `source` are deliberately NOT in the noun list: this
// tree says "an operator CLIENT on the user's gateway", "the coding CLI's own
// terminal" and "the readable source" in prose that has nothing to do with
// provenance.
const EXTERNAL_OBJECT =
  '(?:' +
  [
    // "another implementation", "a prior hand-rolled implementation", ...
    '(?:another|a\\s+prior|a\\s+previous|an?\\s+existing|the\\s+original|the\\s+other|' +
      'the\\s+source|their|upstream|a\\s+competing|a\\s+rival|a\\s+third[-\\s]party)' +
      '\\s+(?:\\w+[-\\s]){0,3}' +
      '(?:implementations?|codebases?|code\\s?bases?|products?|applications?|projects?|' +
      'repo(?:sitor(?:y|ies)|s)?|inspectors?|renderers?|editors?|extensions?|daemons?|' +
      'librar(?:y|ies)|designs?|layouts?|panels?|versions?|approach(?:es)?)',
    // "<name>'s inspector" — a foreign product in the possessive.
    "[A-Za-z][\\w-]{2,}(?:'s|’s)\\s+" +
      '(?:implementation|inspector|renderer|editor|layout|design|version|approach|panel|codebase)',
    // The identity list itself is always an external object.
    '(?:' + IDENTITY_ALTERNATION + ')',
  ].join('|') +
  ')';

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
//
// `allow` patterns suppress a match on the same line. The mechanism is applied
// in `scanText` and proven by a test below, so it is never dead config. No rule
// currently declares one — this repository has no shape that needs an exception
// — but the hook exists because §2's "retain backward-compatible reads for
// existing persisted settings" is exactly the kind of requirement that forces a
// prohibited literal to stay in one narrow place. If one is ever added it must
// be anchored to a whole line, never a substring: a broad `allow` is how a gate
// quietly stops working.

const RULES = [
  {
    id: 'personal-home-path',
    category: CATEGORY.PERSONAL,
    // A developer's home directory. Placeholder and CI-runner names are fine —
    // `/Users/runner` is the GitHub Actions macOS runner and `/home/node` is the
    // node Docker image, both of which appear in real config, and this repo's
    // tests all use `/Users/example/...`.
    //
    // The lookbehind matters: without it a path segment like `src/home/state.ts`
    // reads as a home directory called "state.ts". Only an ABSOLUTE `/home/…`
    // counts, so the segment must not be preceded by path or word characters.
    pattern: /(?<![A-Za-z0-9_./\\-])(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/g,
    reject: (m) => {
      const name = m[1].toLowerCase();
      // A one-character home ("/home/j/…") identifies nobody.
      if (name.length <= 1) return false;
      return !PLACEHOLDER_HOME_NAMES.has(name);
    },
  },
  {
    id: 'machine-hostname',
    category: CATEGORY.PERSONAL,
    // A developer's machine name as macOS Bonjour spells it: a capitalised,
    // usually hyphenated label followed by the `.local` suffix. (Not written out
    // here — this file is scanned by its own scan, so the example lives in the
    // positive fixtures, assembled from fragments.) Such a name identifies a
    // physical device and its owner and has no business in published source.
    //
    // Two constraints keep this off ordinary filenames, and both are needed.
    // `(?!\.)` rules out `settings.local.json` and every other
    // `*.local.<ext>` — this repo talks about `~/.claude/settings.local.json` in
    // five places, and an earlier draft of this rule flagged all of them.
    // Requiring an uppercase letter or a hyphen in the label rules out the rest:
    // a lowercase single word before `.local` is a property access (`state.local`)
    // or a fixture domain (`someone@test.local`), never a Bonjour machine name,
    // which is capitalised, hyphenated, or both.
    pattern: /(?<![A-Za-z0-9_.\-/])[A-Za-z0-9]*[A-Z-][A-Za-z0-9-]*\.local\b(?!\.)/g,
    reject: (m) => !/^(?:test|example|sample|demo|dev|invalid|host|machine|agent|daemon)[.-]/i.test(m[0]),
  },
  {
    id: 'personal-email',
    category: CATEGORY.PERSONAL,
    // A real person's mailbox at a consumer mail provider. Fixture addresses at
    // example.com / test / localhost and the product's own agensis.io are fine.
    pattern: new RegExp(
      '[A-Za-z0-9._%+-]+@(?:gmail|googlemail|hotmail|outlook|live|yahoo|ymail|icloud|' +
        'me|mac|aol|proton|protonmail|gmx|yandex|qq|fastmail|zoho)\\.[A-Za-z.]{2,8}',
      'gi',
    ),
  },
  {
    id: 'extraction-marker',
    category: CATEGORY.EXTRACTION,
    // Markers left behind by a feature-extraction workflow, including the two
    // tool names that workflow used (see the alternation below; they are not
    // repeated in prose here because this file is scanned by its own scan).
    // Every phrase here is unconditional, so each one had to survive a sweep of
    // the whole tree with zero hits before it went in. The trailing word
    // boundary is what keeps the first alternative off the words "source
    // package".
    pattern: new RegExp(
      '\\b(?:source[-_\\s]?pack|feature[-_\\s]?pack|repo[-_\\s]?grab|extract[-_\\s]?pack|' +
        'extraction\\s+(?:marker|manifest|pack|bundle)|' +
        'extracted\\s+wholesale|taken\\s+verbatim|' +
        'feature[-\\s]transfer|directly\\s+portable|straight\\s+port\\s+of|1:1\\s+port|' +
        'pixel[-\\s]for[-\\s]pixel\\s+(?:copy|clone))\\b',
      'gi',
    ),
  },
  {
    id: 'transfer-with-external-object',
    category: CATEGORY.TRANSFER,
    // Two-signal: a transfer verb whose object is external. A verb pointing at
    // one of this daemon's own nouns passes; a verb pointing at a foreign
    // product, or at a foreign product's named part, does not.
    pattern: new RegExp(TRANSFER_VERB_PHRASE + '[^.\\n]{0,40}?' + EXTERNAL_OBJECT, 'gi'),
  },
  {
    id: 'transfer-near-prohibited-identity',
    category: CATEGORY.TRANSFER,
    // Two-signal: any transfer verb within 80 characters of a prohibited name,
    // in either order. Reported separately from the bare identity hit because
    // the remedy is different — this one needs the sentence rewritten so it
    // explains the daemon's own behaviour, not just the name swapped out.
    //
    // Both boundaries on the verb are load-bearing. Without the LEADING one,
    // `export const PORT = …` matches on the "port" inside "export".
    pattern: new RegExp(
      '(?:\\b(?:' + TRANSFER_VERB + ')\\b[^\\n]{0,80}?\\b(?:' + IDENTITY_ALTERNATION + ')\\b' +
        '|\\b(?:' + IDENTITY_ALTERNATION + ')\\b[^\\n]{0,80}?\\b(?:' + TRANSFER_VERB + ')\\b)',
      'gi',
    ),
  },
  {
    id: 'prohibited-identity',
    category: CATEGORY.IDENTITY,
    pattern: new RegExp('\\b(?:' + IDENTITY_ALTERNATION + ')\\b', 'gi'),
  },
  {
    id: 'closed-source-claim',
    category: CATEGORY.CLOSED,
    // Anchored on a repo-shaped noun so the ordinary uses of "private" survive:
    // `"private": true` in both package manifests, private class fields, a
    // private key.
    pattern: new RegExp(
      '(?:' +
        [
          '\\b(?:this|the)\\s+(?:repo(?:sitory)?|project|codebase|app|application|backend|' +
            'daemon|desktop\\s+app|frontend|website)\\b[^.\\n]{0,40}?\\b(?:is|remains|stays|will\\s+remain)\\b' +
            '[^.\\n]{0,25}?\\b(?:private|closed[-\\s]source|proprietary|unpublished|' +
            'not\\s+(?:yet\\s+)?open[-\\s]source)\\b',
          '\\b(?:private|closed[-\\s]source|proprietary|internal[-\\s]only)\\s+' +
            '(?:repo(?:sitory)?|codebase|source\\s+code|monorepo)\\b',
          '\\b(?:source|code|repo(?:sitory)?|codebase)\\s+is\\s+not\\s+public\\b',
          '\\bwill\\s+never\\s+be\\s+(?:open[-\\s]sourced?|published|public)\\b',
          '\\bdo(?:es)?\\s+not\\s+open[-\\s]source\\b',
        ].join('|') +
        ')',
      'gi',
    ),
  },
  {
    id: 'credential-location-pointer',
    category: CATEGORY.PERSONAL,
    // Documentation that tells a reader where a live secret is kept. Naming an
    // environment VARIABLE is fine and necessary (`AGENSIS_TOKEN`,
    // `ANTHROPIC_API_KEY`, and the scrub list that deletes them are all real
    // security documentation); saying which FILE on which machine holds the
    // value is a map to a credential and must not ship.
    pattern: new RegExp(
      '\\b(?:token|secret|api[-_\\s]?key|credential|password)s?\\b[^.\\n]{0,40}?' +
        '\\b(?:lives?|stored?|kept|sits?|is|are)\\b[^.\\n]{0,20}?' +
        '\\b(?:in|at|inside)\\b\\s+(?:the\\s+)?[^.\\n]{0,30}?' +
        '(?:\\.env\\b|\\.npmrc\\b|~\\/|\\brepo\\s+root\\b|\\bkeychain\\b|1[Pp]assword)',
      'gi',
    ),
  },
  {
    id: 'literal-credential',
    category: CATEGORY.PERSONAL,
    // A key-shaped literal. Assembled from fragments so this file does not
    // itself contain a scannable key prefix — the same reason the identity
    // patterns are bracketed.
    pattern: new RegExp(
      '\\b(?:' +
        [
          's' + 'k-ant-[A-Za-z0-9_-]{20,}',
          's' + 'k-live-[A-Za-z0-9]{16,}',
          'x' + 'oxb-[0-9]{8,}-[A-Za-z0-9-]{10,}',
          'A' + 'KIA[0-9A-Z]{16}',
          'g' + 'hp_[A-Za-z0-9]{30,}',
          'n' + 'pm_[A-Za-z0-9]{30,}',
          'a' + 'ga_[A-Za-z0-9]{24,}',
          'c' + 'bk_[a-z0-9_]+_[A-Z2-9]{18}',
        ].join('|') +
        ')\\b',
      'g',
    ),
  },
];

// Home-directory names that are placeholders, CI runners or container users
// rather than a person.
const PLACEHOLDER_HOME_NAMES = new Set([
  // Written into docs and test fixtures: "/Users/example/projects/…".
  'name', 'user', 'users', 'username', 'owner', 'you', 'me', 'someone',
  'example', 'placeholder', 'demo', 'sample', 'alice', 'bob',
  // CI runners and container users that appear in real workflow/Docker config.
  'runner', 'node', 'root', 'ubuntu', 'vscode', 'circleci', 'travis', 'jenkins',
  'linuxbrew', 'shared', 'app', 'appuser', 'nonroot', 'dev', 'developer',
  'test', 'ci',
]);

// ---------------------------------------------------------------------------
// Binary assets
// ---------------------------------------------------------------------------

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.icns', '.bmp',
  '.tif', '.tiff', '.psd', '.ai', '.sketch', '.fig',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.mov', '.webm', '.avi',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.tar', '.7z', '.rar',
  '.wasm', '.node', '.dylib', '.so', '.dll', '.exe', '.bin', '.dmg',
  '.sqlite', '.sqlite3', '.db', '.pack', '.idx', '.jar', '.class',
]);

// Extensions that are text BY DEFINITION, whatever bytes they happen to hold.
// This short-circuit runs BEFORE the NUL sniff and that ordering is the whole
// point: source legitimately embeds control characters — a hash-field delimiter,
// or a fixture that plants NUL and ESC precisely to prove a sanitiser strips
// them. Sniffing first classifies such a file as an undocumented binary asset,
// which is a false positive severe enough that the next person switches the
// whole asset rule off. Extension wins; the sniff is only a backstop for files
// that have no extension at all.
const TEXT_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.json', '.md', '.markdown',
  '.css', '.scss', '.html', '.htm', '.svg', '.sql', '.yml', '.yaml', '.toml',
  '.sh', '.bash', '.zsh', '.txt', '.env', '.example', '.lock', '.cf', '.plist',
]);

// Where an asset inventory may live. opensourceplan.md §3 asks for `ASSETS.md`
// or an equivalent third-party notice.
const ASSET_MANIFESTS = ['ASSETS.md', 'NOTICE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md', 'docs/ASSETS.md'];

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Every file a public snapshot of this tree would contain.
 *
 * This is the plan's exact command. `--cached` covers tracked files, `--others
 * --exclude-standard` covers untracked files that .gitignore does NOT exclude —
 * the ones that would be swept into a fresh commit and are otherwise invisible
 * to a tracked-only scan. `bun.lock` is currently exactly such a file.
 */
function listRepoFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\0').filter(Boolean).filter((p) => !EXCLUDED_PATHS.has(p));
}

function isBinaryPath(relPath, buffer) {
  const ext = path.extname(relPath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  if (TEXT_EXTENSIONS.has(ext)) return false;
  // Backstop for extensionless files only: a NUL byte in the first 8 KiB.
  return buffer.subarray(0, 8192).includes(0);
}

/**
 * Run every rule over one file's text.
 *
 * Exported shape (`{ file, line, category, ruleId, excerpt }`) is what the
 * failure message prints, so a finding is always actionable without re-running
 * anything. `rules` is injectable so the `allow` mechanism can be proven
 * through this exact code path rather than a parallel one.
 */
function scanText(relPath, text, rules = RULES) {
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      let m;
      while ((m = rule.pattern.exec(line)) !== null) {
        if (m[0] === '') { rule.pattern.lastIndex += 1; continue; }
        if (rule.reject && !rule.reject(m)) continue;
        // An `allow` pattern suppresses a match on the same line.
        if (rule.allow && rule.allow.some((re) => re.test(line))) continue;
        findings.push({
          file: relPath,
          line: i + 1,
          category: rule.category,
          ruleId: rule.id,
          excerpt: excerpt(line, m.index),
        });
        break; // one finding per rule per line is enough to act on
      }
    }
  }
  return findings;
}

function excerpt(line, at) {
  const start = Math.max(0, at - 30);
  const slice = line.slice(start, start + 140).trim();
  return (start > 0 ? '…' : '') + slice + (start + 140 < line.length ? '…' : '');
}

/** Parsed asset manifest text, or null when the repo has no manifest at all. */
function readAssetManifest() {
  const found = [];
  for (const rel of ASSET_MANIFESTS) {
    try {
      found.push(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
    } catch { /* not present */ }
  }
  return found.length ? found.join('\n') : null;
}

/**
 * A binary is documented when the manifest names its path, or names a directory
 * prefix that contains it (`images/` documents `images/download-01.jpg`).
 */
function isDocumentedAsset(relPath, manifest) {
  if (!manifest) return false;
  if (manifest.includes(relPath)) return true;
  const parts = relPath.split('/');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    if (manifest.includes(parts.slice(0, i).join('/') + '/')) return true;
  }
  return false;
}

/** The whole-repository scan. Memoised: it reads ~1 MB across ~70 files. */
let cached = null;
function scanRepository() {
  if (cached) return cached;
  const files = listRepoFiles();
  const manifest = readAssetManifest();
  const findings = [];
  const textFiles = [];
  const binaryFiles = [];
  const bytesByFile = new Map();
  let bytesScanned = 0;
  let linesScanned = 0;

  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue; // raced deletion; nothing to publish
    }
    if (!stat.isFile()) continue; // symlinks are not content
    const buf = fs.readFileSync(abs);
    if (isBinaryPath(rel, buf)) {
      binaryFiles.push(rel);
      if (!isDocumentedAsset(rel, manifest)) {
        findings.push({
          file: rel,
          line: 0,
          category: CATEGORY.ASSET,
          ruleId: 'undocumented-binary-asset',
          excerpt: `${(stat.size / 1024).toFixed(0)} KiB binary with no entry in ${ASSET_MANIFESTS[0]}`,
        });
      }
      continue;
    }
    const text = buf.toString('utf8');
    textFiles.push(rel);
    bytesByFile.set(rel, buf.length);
    bytesScanned += buf.length;
    linesScanned += text.split('\n').length;
    findings.push(...scanText(rel, text));
  }

  cached = {
    files, textFiles, binaryFiles, bytesByFile, findings,
    bytesScanned, linesScanned, hasManifest: manifest !== null,
  };
  return cached;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const MAX_REPORTED_PER_CATEGORY = 25;

function report(findings, heading) {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  const lines = [
    '',
    `${heading}: ${findings.length} finding(s) in ${byFile.size} file(s).`,
    '',
  ];
  let shown = 0;
  let filesShown = 0;
  for (const [, group] of byFile) {
    if (shown >= MAX_REPORTED_PER_CATEGORY) break;
    filesShown += 1;
    for (const f of group.slice(0, 3)) {
      lines.push(`  ${f.file}:${f.line}  [${f.category} / ${f.ruleId}]`);
      lines.push(`      ${f.excerpt}`);
      shown += 1;
      if (shown >= MAX_REPORTED_PER_CATEGORY) break;
    }
    if (group.length > 3) lines.push(`      (+${group.length - 3} more in this file)`);
  }
  if (filesShown < byFile.size) {
    lines.push(`  … plus findings in ${byFile.size - filesShown} further file(s).`);
  }
  lines.push('');
  lines.push('  Fix the source, do not add an exclusion. See opensourceplan.md section 4.');
  lines.push('  If the readable source changed, rebuild the bundle: npm run build.');
  return lines.join('\n');
}

function findingsFor(category) {
  return scanRepository().findings.filter((f) => f.category === category);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
//
// Positive fixtures are ASSEMBLED, never written out, so this file stays clean
// under its own scan. `j()` exists purely to keep the fragments apart in the
// source text.
const j = (...parts) => parts.join('');

function positiveFixtures() {
  // Recovered at runtime, never spelled out — see the header note.
  const foreignProduct = identityFor('openpat[h]');
  const oldBranding = identityFor('hilo[s]');
  const competitor = identityFor('openagent[s]');
  return [
    {
      why: 'a developer home directory',
      category: CATEGORY.PERSONAL,
      text: j('const root = "', '/Users', '/', 'somedeveloper', '/Documents/GitHub/thing";'),
    },
    {
      why: 'a windows developer home directory',
      category: CATEGORY.PERSONAL,
      text: j('C:', '\\', 'Users', '\\', 'somedeveloper', '\\src\\app'),
    },
    {
      why: 'a developer machine hostname',
      category: CATEGORY.PERSONAL,
      text: j('host: "', 'SomeBook', '-', 'M3', '-5', '.local', '",'),
    },
    {
      why: 'a real mailbox at a consumer provider',
      category: CATEGORY.PERSONAL,
      text: j('owner: "', 'someperson', '@', 'gmail.com', '",'),
    },
    {
      why: 'a pointer to where a live credential is kept',
      category: CATEGORY.PERSONAL,
      text: j('The npm ', 'token', ' ', 'lives', ' ', 'in', ' the ', 'repo root', ' ', '.env', ' at line 3.'),
    },
    {
      why: 'a key-shaped literal',
      category: CATEGORY.PERSONAL,
      text: j('const key = "', 's', 'k-ant-', 'api03', '-', 'AAAABBBBCCCCDDDDEEEEFFFF', '";'),
    },
    {
      why: 'an extraction-workflow marker',
      category: CATEGORY.EXTRACTION,
      text: j('// ', 'source', '-', 'pack', ' entry 14 — permission broker'),
    },
    {
      why: 'an extraction tool name',
      category: CATEGORY.EXTRACTION,
      text: j('# run ', 'repo', '-', 'grab', ' then diff the manifest'),
    },
    {
      why: 'a portability claim',
      category: CATEGORY.EXTRACTION,
      text: j('// this module is ', 'directly', ' ', 'portable', ' and needs no changes'),
    },
    {
      why: 'a transfer verb with an external object',
      category: CATEGORY.TRANSFER,
      text: j('// Session pool (', 'copied', ' ', 'from', ' a prior hand-rolled implementation)'),
    },
    {
      why: 'a transfer verb with a foreign possessive object',
      category: CATEGORY.TRANSFER,
      text: j('/** Stop-reason ladder (', 'borrowed', ' ', 'from', ' ', foreignProduct, "'s inspector) */"),
    },
    {
      why: 'a transfer verb beside a prohibited identity',
      category: CATEGORY.TRANSFER,
      text: j('// ', 'Mirrors', ' the ', oldBranding, ' /api/mcp model.'),
    },
    {
      why: 'a bare prohibited identity',
      category: CATEGORY.IDENTITY,
      text: j('<td>vs ', competitor, ', alternatives</td>'),
    },
    {
      why: 'a closed-source claim about the repository',
      category: CATEGORY.CLOSED,
      text: j('The backend lives in a separate ', 'private', ' ', 'repository', '.'),
    },
    {
      why: 'a closed-source claim in clause form',
      category: CATEGORY.CLOSED,
      text: j('This ', 'repository', ' ', 'remains', ' ', 'private', ' until launch.'),
    },
    {
      why: 'a never-publish claim',
      category: CATEGORY.CLOSED,
      text: j('The desktop shell ', 'will', ' ', 'never', ' ', 'be', ' ', 'published', '.'),
    },
  ];
}

// Negative fixtures are written out literally on purpose: if any of them were
// actually a violation this file's own scan would say so, which is a second,
// free check that they really are benign. Every line here is either a real line
// from this tree or the documented shape of one.
const NEGATIVE_FIXTURES = [
  // Cloning a git repo, and ports.
  'git clone https://github.com/jasonkneen/agensis-agent.git',
  'const port = Number(process.env.AGENSIS_CURSORBUDDY_PORT || 8787);',
  "export const PORT_RE = /:(\\d+)$/; // dev-port rewrite",
  'openclaw  binds to 127.0.0.1:18789 by default — the gateway is on the',
  // Internal parity / internal duplication language — the biggest false-positive
  // family in this repo. All of these are real or documented-shape lines.
  '// Deliberately the same shape as memory.mjs (enumerate -> fingerprint -> snapshot),',
  '// Rule identity is deliberately NOT a glob matcher we wrote. The SDK hands us',
  '// So the daemon owns no glob engine of its own that could fall out of step',
  '// Parked permission requests deliberately SURVIVE this, the same way',
  '// Deliberately a client, not a node. In OpenClaw\'s model a node is a DEVICE that',
  '// connection that sends requests and subscribes to events. Mirroring chats into',
  '// A malformed upstream event is ignored; later valid chunks still flow.',
  '// runaway agent can\'t bloat the heartbeat we ship upstream.',
  '// the wire for the server to drop on arrival.',
  '// same shape as WhatsApp.',
  // Licence text.
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  // Operational providers, runtimes and integrations — this daemon's whole job.
  "external: ['ws', 'e2b', '@anthropic-ai/claude-agent-sdk'],",
  "if (s && !['claude', 'codex', 'amp'].includes(s)) throw new Error(...);",
  'const STARTERS = { whatsapp: startWhatsApp, signal: startSignal, openclaw: startOpenClaw };',
  'CursorBuddy local bridge already running on http://127.0.0.1:8787',
  '// skills-compatible client (Claude Code, Codex, Cursor, Gemini CLI, ...)',
  // Naming an env var that holds a secret is security documentation, not a map
  // to a credential. The scrub list has to spell these out to delete them.
  'deletes `AGENSIS_TOKEN`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN`',
  'Keep `aga_...` connection tokens out of logs and rotate any token that is exposed.',
  'GitHub OIDC authenticates the tag build without a long-lived npm token.',
  'npm Trusted Publishing is bound to this repository and workflow filename.',
  // "private" in its ordinary senses. Both package manifests carry this line.
  '"private": true,',
  'const CURSORBUDDY_KEY_RE = /^cbk_[a-z0-9_]+_[A-Z2-9]{18}$/;',
  // CI and container home directories, and this repo's fixture paths.
  'working-directory: /Users/runner/work/agensis-agent/agensis-agent',
  'WORKDIR /home/node/app',
  'const home = process.env.HOME ?? "/home/user";',
  "cwd: '/Users/example/projects/sample-app',",
  '// e.g. /Users/example/projects/agensis -> -Users-example-projects-agensis',
  // localhost is not a machine hostname, and neither is a `*.local.<ext>`
  // filename. All five of these tripped an earlier draft of the hostname rule.
  'const url = String(config?.gatewayUrl || "ws://127.0.0.1:18789");',
  'if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;',
  'writing grants into ~/.claude/settings.local.json — is inert here: lean mode',
  '// settings.local.json at all — grants written there are silently ignored, and',
  'passes settingSources: [], so settings.local.json is never read',
  'const mode = editor.state.local ?? defaults.local;',
  // Key-shaped values that tests need. Assembled at their use sites for exactly
  // this reason, so what appears in source is a fragment list, not a key.
  "const CONNECTION_KEY = ['cbk', 'website', 'avatar', 'EXAMPLEEXAMPLEEXAM'].join('_');",
  "const BRIDGE_TEST_SECRET = 'cbs_test_secret_for_unit_tests_only_xx';",
  // Upstream package metadata npm writes into the lockfile. The maintainer
  // contact in a `deprecated` string is public registry data about a dependency,
  // not this project's data, and it is regenerated by `npm install`.
  '"deprecated": "Old versions are not supported ... by contacting i@izs.me",',
  // Fixture email addresses.
  "email: 'owner@example.com',",
  'const to = "someone@test.local";',
];

// ---------------------------------------------------------------------------
// Anti-vacuity: prove the scan ran, covered the repo, and can actually fail
// ---------------------------------------------------------------------------

test('anti-vacuity: the scan reads a real, repo-sized file list', () => {
  const scan = scanRepository();
  assert.ok(scan.files.length > 50, `expected the publish set to be repo-sized, got ${scan.files.length} files`);
  assert.ok(scan.textFiles.length > 50, `expected the whole publish set to be text, got ${scan.textFiles.length}`);
  assert.ok(scan.bytesScanned > 500_000, `expected >500 KB of text scanned, got ${scan.bytesScanned} bytes`);
  assert.ok(scan.linesScanned > 10_000, `expected >10k lines scanned, got ${scan.linesScanned}`);
});

test('anti-vacuity: the scan covers this file and every major tree', () => {
  const scan = scanRepository();
  const set = new Set(scan.textFiles);
  // If this file were skipped, its own fixtures could hide anything.
  assert.ok(set.has(SELF), `${SELF} was not scanned — the guard must scan itself`);
  for (const sentinel of [
    'package.json', 'AGENTS.md', 'README.md', 'LICENSE',
    'packages/agensis-cli/src/agensis.mjs',
    'packages/agensis-cli/src/permissions.mjs',
    'packages/agensis-cli/src/bridges.mjs',
    'packages/agensis-agent/build.mjs',
    'scripts/smoke-packed-artifact.mjs',
    'tests/daemon-wire-contract.test.cjs',
    'tests/unit/agentState.test.ts',
    '.github/workflows/publish-agent.yml',
    '.claude/skills/fast-connection-executors/SKILL.md',
  ]) {
    assert.ok(set.has(sentinel), `${sentinel} was not scanned — a whole tree is missing from the file list`);
  }
  // Every top-level directory that holds text must be represented, so a scan
  // that silently drops a subtree fails here rather than passing green.
  const topLevel = new Set(scan.textFiles.filter((p) => p.includes('/')).map((p) => p.split('/')[0]));
  for (const dir of ['packages', 'tests', 'scripts', '.github', '.claude']) {
    assert.ok(topLevel.has(dir), `no file under ${dir}/ was scanned`);
  }
});

test('anti-vacuity: the generated npm bundle is scanned as a real artifact', () => {
  // opensourceplan.md §4 asks for proof that the GENERATED artifact was scanned,
  // not just the readable source. This is the file `npm publish` ships, and
  // esbuild's minifier drops comments while keeping every string literal — so
  // source and bundle are genuinely different scan targets and only one of them
  // is public forever.
  const scan = scanRepository();
  assert.ok(scan.textFiles.includes(BUNDLE), `${BUNDLE} was not scanned — the published artifact is unguarded`);
  const size = scan.bytesByFile.get(BUNDLE) ?? 0;
  assert.ok(size > 50_000, `${BUNDLE} is only ${size} bytes — that is a stub, not the built bundle; run npm run build`);
  // The bundle must be the current build of the readable source. A stale bundle
  // is how a string removed from source stays public for another release.
  const bundle = fs.readFileSync(path.join(REPO_ROOT, BUNDLE), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/agensis-agent/package.json'), 'utf8'));
  assert.ok(
    bundle.includes(`"${pkg.version}"`),
    `${BUNDLE} does not carry version ${pkg.version} — rebuild it with npm run build`,
  );
});

test('anti-vacuity: nothing is excluded from the scan', () => {
  assert.equal(
    EXCLUDED_PATHS.size, 0,
    `EXCLUDED_PATHS must stay empty; every exclusion is a place a violation can hide. Found: ${[...EXCLUDED_PATHS].join(', ')}`,
  );
});

test('anti-vacuity: every rule fires on a planted violation', () => {
  const missed = [];
  for (const fixture of positiveFixtures()) {
    const hits = scanText('fixture.ts', fixture.text);
    if (!hits.some((h) => h.category === fixture.category)) {
      missed.push(`${fixture.why} → expected category "${fixture.category}", got [${hits.map((h) => h.ruleId).join(', ') || 'nothing'}]`);
    }
  }
  assert.deepEqual(missed, [], `the detector is blind to:\n  ${missed.join('\n  ')}`);
});

test('anti-vacuity: every rule id is reachable from a fixture', () => {
  // A rule nobody plants a violation for is a rule nobody has ever seen fire.
  const fired = new Set();
  for (const fixture of positiveFixtures()) {
    for (const hit of scanText('fixture.ts', fixture.text)) fired.add(hit.ruleId);
  }
  const never = RULES.map((r) => r.id).filter((id) => !fired.has(id));
  assert.deepEqual(never, [], `no positive fixture exercises: ${never.join(', ')}`);
});

test('anti-vacuity: every prohibited identity pattern matches the word it stands for', () => {
  // A bracketed source with a typo — `openpaht[h]` — would compile fine and
  // match nothing forever. This is the check that makes that impossible.
  for (const entry of PROHIBITED_IDENTITIES) {
    const word = identityWord(entry.word);
    const hits = scanText('fixture.md', `the ${word} project`);
    assert.ok(
      hits.some((h) => h.category === CATEGORY.IDENTITY),
      `identity pattern "${entry.word}" does not match "${word}" (${entry.why})`,
    );
  }
});

test('the allow mechanism is wired up and suppresses a match', () => {
  // The `allow` hook is documented in the rules header, so it must actually be
  // applied. This drives it through the real `scanText` path with a synthetic
  // rule: the header would otherwise describe a mechanism that silently does
  // nothing, and a future exception would be added in good faith and ignored.
  const withoutAllow = [{
    id: 'synthetic', category: CATEGORY.IDENTITY, pattern: /forbidden-token/g,
  }];
  const withAllow = [{
    id: 'synthetic', category: CATEGORY.IDENTITY, pattern: /forbidden-token/g,
    allow: [/^\s*legacy: 'forbidden-token',\s*$/],
  }];
  const line = "  legacy: 'forbidden-token',";
  assert.equal(scanText('f.ts', line, withoutAllow).length, 1, 'the synthetic rule must match without an allow');
  assert.equal(scanText('f.ts', line, withAllow).length, 0, 'the allow pattern did not suppress the match — it is dead config');
  // An allow is line-anchored, so it must not suppress the same token elsewhere.
  assert.equal(
    scanText('f.ts', "const x = 'forbidden-token';", withAllow).length, 1,
    'the allow pattern leaked past its own line shape',
  );
});

test('every declared allow is a non-empty list of anchored patterns', () => {
  for (const rule of RULES) {
    if (!('allow' in rule)) continue;
    assert.ok(Array.isArray(rule.allow) && rule.allow.length > 0, `rule ${rule.id} declares an empty allow`);
    for (const re of rule.allow) {
      assert.ok(re instanceof RegExp, `rule ${rule.id} has a non-regexp allow entry`);
      assert.ok(
        re.source.startsWith('^') && re.source.endsWith('$'),
        `rule ${rule.id} has an unanchored allow (${re.source}); a substring allow silently widens over time`,
      );
    }
  }
});

test('the binary classifier trusts a known text extension over a NUL sniff', () => {
  // The ordering bug this guards against: sniffing for NUL first means any
  // source file that legitimately embeds a control character — a hash-field
  // delimiter, a sanitiser test fixture — is reported as an undocumented binary
  // asset. That false positive is what gets the whole asset rule switched off.
  //
  // This repo currently ships zero binaries, so the classifier cannot be
  // exercised by the tree itself. It is exercised directly instead.
  const withNul = Buffer.from('const SEP = " "; // hash field delimiter\n', 'utf8');
  assert.ok(withNul.includes(0), 'the fixture must actually contain a NUL byte');
  for (const textPath of ['shared/hash.cjs', 'src/a.ts', 'tests/x.test.mjs', 'notes.md', 'bun.lock']) {
    assert.equal(isBinaryPath(textPath, withNul), false, `${textPath} must classify as text despite the NUL`);
  }
  for (const binPath of ['public/logo.png', 'fonts/x.woff2', 'vendor/mod.node']) {
    assert.equal(isBinaryPath(binPath, Buffer.from('not really binary')), true, `${binPath} must classify as binary`);
  }
  // Extensionless files still fall back to the sniff, in both directions.
  assert.equal(isBinaryPath('LICENSE', Buffer.from('MIT License\n')), false);
  assert.equal(isBinaryPath('someblob', withNul), true);
});

test('anti-vacuity: the end-to-end scan really reads files off disk', async (t) => {
  // The checks above prove the rules work on strings and that the file LIST is
  // real. This one closes the gap between them: it plants a contaminated
  // untracked file in the working tree, runs the same `git ls-files` + read +
  // scan path the gate uses, and requires the finding to come back.
  //
  // If the scan ever stops reading file contents — a swallowed readFileSync, an
  // over-eager binary sniff, a `continue` in the wrong branch — this is the test
  // that goes red.
  const canaryRel = 'tests/.public-source-hygiene-canary.tmp';
  const canaryAbs = path.join(REPO_ROOT, canaryRel);
  const planted = positiveFixtures().map((f) => f.text).join('\n');
  t.after(() => { try { fs.unlinkSync(canaryAbs); } catch { /* already gone */ } });

  fs.writeFileSync(canaryAbs, planted, 'utf8');
  try {
    // A fresh, un-memoised scan of the live tree.
    const files = listRepoFiles();
    assert.ok(files.includes(canaryRel), 'git ls-files did not report the planted file — the scan cannot see new files');
    const buf = fs.readFileSync(canaryAbs);
    assert.equal(isBinaryPath(canaryRel, buf), false, 'the planted file was classified as binary and never scanned');
    const hits = scanText(canaryRel, buf.toString('utf8'));
    const categories = new Set(hits.map((h) => h.category));
    for (const expected of [CATEGORY.PERSONAL, CATEGORY.EXTRACTION, CATEGORY.TRANSFER, CATEGORY.IDENTITY, CATEGORY.CLOSED]) {
      assert.ok(categories.has(expected), `planted file was not flagged for ${expected}`);
    }
    assert.ok(hits.every((h) => h.file === canaryRel && h.line > 0), 'findings must carry path:line');
  } finally {
    fs.unlinkSync(canaryAbs);
  }
});

test('ordinary code and documentation is not flagged', () => {
  // The gate is only useful if people leave it switched on. Every line here is
  // legitimate; a single hit means the rules have started crying wolf.
  const noise = [];
  for (const line of NEGATIVE_FIXTURES) {
    for (const hit of scanText('fixture', line)) {
      noise.push(`  [${hit.ruleId}] ${line}\n      matched: ${hit.excerpt}`);
    }
  }
  assert.deepEqual(noise, [], `these legitimate lines were flagged:\n${noise.join('\n')}`);
});

// ---------------------------------------------------------------------------
// The policy itself
// ---------------------------------------------------------------------------

test('no personal source paths, hostnames, mailboxes or credential pointers', () => {
  const hits = findingsFor(CATEGORY.PERSONAL);
  assert.equal(hits.length, 0, report(hits, 'Personal paths/identities in the publish set'));
});

test('no extraction or provenance markers', () => {
  const hits = findingsFor(CATEGORY.EXTRACTION);
  assert.equal(hits.length, 0, report(hits, 'Extraction/provenance markers in the publish set'));
});

test('no copying, porting, reverse-engineering or imitation constructions', () => {
  const hits = findingsFor(CATEGORY.TRANSFER);
  assert.equal(hits.length, 0, report(hits, 'Provenance-transfer language in the publish set'));
});

test('no prohibited competitor or source identities', () => {
  const hits = findingsFor(CATEGORY.IDENTITY);
  assert.equal(hits.length, 0, report(hits, 'Prohibited identities in the publish set'));
});

test('no private or closed-source claims', () => {
  const hits = findingsFor(CATEGORY.CLOSED);
  assert.equal(hits.length, 0, report(hits, 'Closed-source claims in the publish set'));
});

test('every shipped binary asset is documented', () => {
  const scan = scanRepository();
  const hits = findingsFor(CATEGORY.ASSET);
  // Unlike the app repository, this one currently ships no binaries at all —
  // asserting `binaryFiles.length > 0` here would be a permanently red test for
  // a healthy tree. The classifier is proven by its own unit test above instead;
  // this asserts the policy, and starts biting the day a binary is added.
  assert.equal(
    hits.length, 0,
    report(hits, scan.hasManifest
      ? 'Binary assets with no manifest entry'
      : `No asset manifest exists (looked for ${ASSET_MANIFESTS.join(', ')}), so every binary is undocumented`),
  );
});

module.exports = {
  scanText, scanRepository, listRepoFiles, isBinaryPath,
  RULES, CATEGORY, PROHIBITED_IDENTITIES,
};
