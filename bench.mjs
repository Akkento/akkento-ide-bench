#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  akkento-ide-bench — startup, memory and workload benchmark for desktop code editors
 *  Copyright (c) 2026 Akkento Pty Ltd.
 *
 *  SPDX-License-Identifier: GPL-2.0-only
 *
 *  This program is free software. You may redistribute it and/or modify it under the terms
 *  of the GNU General Public License, version 2, as published by the Free Software Foundation.
 *  It is distributed WITHOUT ANY WARRANTY, without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See LICENSE for the full terms.
 *
 *  No telemetry, no network, no dependencies. Node >= 20. Linux / macOS / Windows.
 *--------------------------------------------------------------------------------------------*/

/**
 * Signals
 *   startup  time to the editor's own "my shell is on screen" mark. Primary
 *            metric, and the one that crosses editor families — with a seam
 *            that is printed next to it every time it is printed:
 *              code   main-process start -> workbench ready, self-reported via
 *                     `--prof-append-timers` (upstream VS Code machinery,
 *                     inherited unmodified by every fork)
 *              zed    exec -> first frame rendered, timed by the harness from
 *                     the mark Zed writes to its own log
 *            The Code number cannot be measured by the harness instead: VS Code
 *            deliberately waits 15 seconds before appending that file and then
 *            exits, so when the harness *sees* the mark says nothing about
 *            startup (it is kept as markSeenMs, and it is why a launch costs
 *            ~15s). And Zed has no equivalent number to self-report.
 *            So the two clocks do not start in the same place: Zed's starts at
 *            the exec, Code's once Electron has booted far enough to run the
 *            first line of the app's own JavaScript, so Electron's bootstrap
 *            sits on Zed's side of the comparison and not on Code's. `window`
 *            — one clock, one observer, both families — is the cross-check.
 *   timers   the raw self-reported number, recorded per launch for the Code
 *            family. Identical to `startup` there; absent, never zero, for an
 *            editor that is not a Code fork.
 *   window   wall clock from spawn until the window manager first lists a new
 *            window belonging to the launched process tree (Linux/X11 only;
 *            needs `xprop` + `wmctrl`). Cross-editor sanity check; flatters
 *            Electron (an empty shell counts). Optional.
 *   memory   (--memory) tree memory a fixed stretch of wall clock after launch
 *            — the same stretch for every editor, and no ready mark involved,
 *            because the flag that produces one for the Code family also makes
 *            the editor exit a few seconds later. The most honest metric each
 *            OS exposes, labeled as such.
 *   workload (--workload) the same walk of the process tree, but with a real
 *            repository open and repeated for minutes: memory settling to a
 *            steady state, the peak it passed through on the way, the CPU the
 *            editor burned getting there, and the CPU it is still burning once
 *            nobody is touching it. This is the "what does it cost me while I
 *            work" number; startup is the "what does it cost me to begin" one,
 *            and an editor can win either without winning the other.
 *
 * Methodology invariants (each one is load-bearing for the numbers below it;
 * do not "simplify"):
 *   - interleaved round-robin, rotating start order: machine drift is shared,
 *     not charged to whoever ran last
 *   - load gate: runs wait for a quiet machine; gated-out runs are excluded
 *     from stats but still recorded in the report
 *   - a brand new throwaway --user-data-dir, --extensions-dir and timers file
 *     per *launch*, discarded after it: real profiles untouched, no unfair
 *     extension loads, and — the reason it is per launch rather than per
 *     editor — every measured run starts from the same empty state, so run 5
 *     is as cold as run 1 instead of reading a profile the first four runs
 *     warmed. It also makes the singleton-handoff failure mode structurally
 *     impossible: a survivor holds a lock on a path nothing will launch again
 *   - warmups excluded: the profile is wiped between launches, so they no
 *     longer warm a code cache — what they warm is the OS page cache for the
 *     application image, which otherwise charges run 1 for reading the editor
 *     off disk
 *   - one editor at a time; post-kill the harness verifies the process tree is
 *     actually gone and says so loudly when it is not (a survivor competes for
 *     the machine with every run that follows it)
 *   - every row (warmups, timeouts, gated runs) lands in the report, marked —
 *     published numbers must be recomputable from published data
 *
 * usage:
 *   node bench.mjs --help
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.4.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_LINUX = os.platform() === 'linux';
const IS_MAC = os.platform() === 'darwin';
const IS_WIN = os.platform() === 'win32';

// ----------------------------------------------------------------------------
// terminal presentation
//
// Everything here degrades: colour is dropped when the output is redirected or
// NO_COLOR is set, box drawing falls back to ASCII on terminals that predate
// it, and the live status block is simply not drawn when stdout is not a TTY
// (CI logs stay readable and diffable).
// ----------------------------------------------------------------------------

const TTY = process.stdout.isTTY === true;
let COLOR = TTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
let UNICODE = !IS_WIN || Boolean(process.env.WT_SESSION) || process.env.TERM_PROGRAM === 'vscode';
let LIVE = TTY;

const ANSI = {
	reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m',
	red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
	magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m', grey: '\x1b[90m',
	brightGreen: '\x1b[92m', brightCyan: '\x1b[96m', brightYellow: '\x1b[93m',
};

function paint(code, text) {
	return COLOR ? `${code}${text}${ANSI.reset}` : String(text);
}

const c = {
	bold: t => paint(ANSI.bold, t),
	dim: t => paint(ANSI.dim, t),
	grey: t => paint(ANSI.grey, t),
	red: t => paint(ANSI.red, t),
	green: t => paint(ANSI.brightGreen, t),
	yellow: t => paint(ANSI.brightYellow, t),
	blue: t => paint(ANSI.blue, t),
	cyan: t => paint(ANSI.brightCyan, t),
	magenta: t => paint(ANSI.magenta, t),
	title: t => paint(`${ANSI.bold}${ANSI.brightCyan}`, t),
};

const glyphs = () => UNICODE
	? { ok: '✔', fail: '✖', warn: '▲', info: '•', skip: '·', star: '★', arrow: '→',
		full: '█', half: '▌', empty: '░', h: '─', v: '│', tl: '╭', tr: '╮', bl: '╰', br: '╯',
		cross: '┼', tdown: '┬', tup: '┴', tright: '├', tleft: '┤',
		spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] }
	: { ok: '+', fail: 'x', warn: '!', info: '*', skip: '.', star: '*', arrow: '->',
		full: '#', half: '=', empty: '.', h: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+',
		cross: '+', tdown: '+', tup: '+', tright: '+', tleft: '+',
		spinner: ['|', '/', '-', '\\'] };

let G = glyphs();

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = s => String(s).replace(ANSI_RE, '');
const visibleLength = s => stripAnsi(s).length;
const termWidth = () => Math.max(60, Math.min(process.stdout.columns || 100, 200));
/** Everything that draws a full-width frame agrees on one width. */
const layoutWidth = () => Math.min(termWidth(), 96);

function padEndVisible(s, width) {
	const pad = width - visibleLength(s);
	return pad > 0 ? s + ' '.repeat(pad) : s;
}

function padStartVisible(s, width) {
	const pad = width - visibleLength(s);
	return pad > 0 ? ' '.repeat(pad) + s : s;
}

function truncateVisible(s, width) {
	if (visibleLength(s) <= width) { return s; }
	// Cheap and safe: drop styling rather than risk cutting an escape in half.
	return stripAnsi(s).slice(0, Math.max(0, width - 1)) + '…';
}

/**
 * A scrolling log with a sticky status block pinned underneath it. Log lines
 * are printed above the block, which is erased and redrawn around every write
 * so it never ends up interleaved. Every block line is truncated to the
 * terminal width — a wrapped line would make the cursor-up count wrong and the
 * block would smear down the screen.
 */
const ui = {
	blockLines: 0,
	render: undefined,
	timer: undefined,
	frame: 0,

	write(text) { process.stdout.write(text); },

	clearBlock() {
		if (!LIVE || this.blockLines === 0) { return; }
		this.write(`\x1b[${this.blockLines}A\x1b[0J`);
		this.blockLines = 0;
	},

	drawBlock() {
		if (!LIVE || !this.render) { return; }
		const lines = this.render().map(line => truncateVisible(line, termWidth() - 1));
		if (!lines.length) { return; }
		this.write(lines.join('\n') + '\n');
		this.blockLines = lines.length;
	},

	log(line = '') {
		this.clearBlock();
		this.write(`${line}\n`);
		this.drawBlock();
	},

	status(renderFn) {
		this.clearBlock();
		this.render = renderFn;
		if (LIVE && !this.timer) {
			this.write('\x1b[?25l');	// hide cursor while the block animates
			this.timer = setInterval(() => { this.clearBlock(); this.frame++; this.drawBlock(); }, 90);
			this.timer.unref?.();
		}
		this.drawBlock();
	},

	clearStatus() {
		this.clearBlock();
		this.render = undefined;
		if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
		if (LIVE) { this.write('\x1b[?25h'); }
	},

	spinner() { return G.spinner[this.frame % G.spinner.length]; },
};

function restoreCursor() {
	if (LIVE) { try { process.stdout.write('\x1b[?25h'); } catch { /* stream gone */ } }
}

function rule(label) {
	const width = layoutWidth();
	if (!label) { return c.grey(G.h.repeat(width)); }
	const head = `${G.h.repeat(2)} ${label} `;
	return c.grey(head + G.h.repeat(Math.max(0, width - visibleLength(head))));
}

function banner() {
	const width = layoutWidth();
	const lines = [
		`${c.title('akkento-ide-bench')}  ${c.grey(`v${VERSION}`)}`,
		c.grey('startup, memory and workload benchmark for VS Code-family editors and Zed'),
		// GPL-2 section 2(c): an interactive program that announces itself says
		// under what terms, and that it comes with no warranty.
		c.grey('free software under GPL-2.0-only, with ABSOLUTELY NO WARRANTY — see LICENSE'),
	];
	const inner = width - 4;
	const top = c.grey(G.tl + G.h.repeat(width - 2) + G.tr);
	const bottom = c.grey(G.bl + G.h.repeat(width - 2) + G.br);
	const body = lines.map(line => `${c.grey(G.v)} ${padEndVisible(line, inner)} ${c.grey(G.v)}`);
	return [top, ...body, bottom].join('\n');
}

/** Aligned table with a light box frame. `columns`: {label, align, key, style}. */
function table(columns, rows) {
	const widths = columns.map(col => Math.max(
		visibleLength(col.label),
		...rows.map(row => visibleLength(row[col.key] ?? '')),
	));
	const line = (left, mid, right) => c.grey(left + widths.map(w => G.h.repeat(w + 2)).join(mid) + right);
	const renderRow = (cells, styler) => c.grey(G.v) + cells.map((cell, i) => {
		const aligned = columns[i].align === 'right'
			? padStartVisible(cell, widths[i])
			: padEndVisible(cell, widths[i]);
		return ` ${styler ? styler(aligned, i) : aligned} `;
	}).join(c.grey(G.v)) + c.grey(G.v);

	const out = [];
	out.push(line(G.tl, G.tdown, G.tr));
	out.push(renderRow(columns.map(col => col.label), cell => c.bold(cell)));
	out.push(line(G.tright, G.cross, G.tleft));
	for (const row of rows) {
		out.push(renderRow(columns.map(col => row[col.key] ?? ''), (cell, i) => {
			const style = columns[i].style;
			return style ? style(cell, row) : cell;
		}));
	}
	out.push(line(G.bl, G.tup, G.br));
	return out.join('\n');
}

function bar(fraction, width) {
	const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
	return G.full.repeat(filled) + G.empty.repeat(width - filled);
}

/** Filled portion carries the colour; the track stays grey so 0% reads as 0%. */
function progressBar(fraction, width) {
	const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
	return c.cyan(G.full.repeat(filled)) + c.grey(G.empty.repeat(width - filled));
}

function fmtDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) { return '--:--'; }
	const total = Math.round(ms / 1000);
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function fmtMs(value) {
	if (value === undefined || value === null) { return '-'; }
	return `${Math.round(value).toLocaleString('en-US')} ms`;
}

function fmtMB(value) {
	if (value === undefined || value === null) { return '-'; }
	return `${value.toFixed(1)} MB`;
}

function fmtSeconds(value) {
	if (value === undefined || value === null) { return '-'; }
	return `${value.toFixed(1)} s`;
}

/** CPU as a share of one core: 100% is one core pinned, 200% is two. */
function fmtCore(value) {
	if (value === undefined || value === null) { return '-'; }
	return `${value.toFixed(1)}%`;
}

/**
 * The shape of a series in one line of text. Scaled against a floor and a
 * ceiling supplied by the caller rather than against itself, so several
 * editors' curves drawn underneath each other can be read against each other
 * — a sparkline normalised per row would make every editor look identical.
 */
const SPARK = () => UNICODE
	? ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588']
	: ['_', '.', ',', '-', '=', '+', '*', '#'];

function sparkline(values, floor, ceiling) {
	const marks = SPARK();
	const span = ceiling - floor;
	return values.map(value => {
		const fraction = span > 0 ? (value - floor) / span : 0;
		const index = Math.max(0, Math.min(marks.length - 1, Math.round(fraction * (marks.length - 1))));
		return marks[index];
	}).join('');
}

/** Shortest honest way to name a path on screen: ./relative, or ~/absolute. */
function displayPath(target) {
	const relative = path.relative(process.cwd(), target);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
		? `.${path.sep}${relative}`
		: redact(target);
}

/** Home directory stripped from anything that lands in a shared report. */
function redact(value) {
	if (typeof value !== 'string') { return value; }
	const home = os.homedir();
	return home && home !== '/' ? value.split(home).join('~') : value;
}

// ----------------------------------------------------------------------------
// options
// ----------------------------------------------------------------------------

function parseArgs(argv) {
	const opts = {
		config: path.join(HERE, 'editors.json'),
		only: undefined,
		runs: 10,
		warmups: 2,
		maxLoad: 2.5,
		window: true,
		forceX11: false,
		folder: undefined,
		json: undefined,
		outDir: path.resolve('reports'),
		report: true,
		list: false,
		yes: false,
		// Every phase runs unless it is turned off. A batch that reports startup
		// alone answers a third of the question people arrive with, and the one
		// place to disclose what a full batch costs is the plan screen, which
		// prints the launch count and the ETA and then waits for a keypress.
		memory: true,
		memoryRuns: 3,
		memorySettleMs: 30_000,
		workload: true,
		workloadFolder: undefined,
		workloadOpen: undefined,
		workloadCorpus: 'ts-2.5k',
		workloadRuns: 3,
		workloadWindowMs: 180_000,
		workloadSampleMs: 5_000,
		timeoutMs: 90_000,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--config') { opts.config = argv[++i]; }
		else if (a === '--only') { opts.only = argv[++i].split(',').map(s => s.trim()); }
		else if (a === '--runs') { opts.runs = Number(argv[++i]); }
		else if (a === '--warmups') { opts.warmups = Number(argv[++i]); }
		else if (a === '--max-load') { opts.maxLoad = Number(argv[++i]); }
		else if (a === '--timeout') { opts.timeoutMs = Number(argv[++i]); }
		else if (a === '--no-window') { opts.window = false; }
		else if (a === '--force-x11') { opts.forceX11 = true; }
		else if (a === '--folder') { opts.folder = path.resolve(argv[++i]); }
		else if (a === '--json') { opts.json = path.resolve(argv[++i]); }
		else if (a === '--out') { opts.outDir = path.resolve(argv[++i]); }
		else if (a === '--no-report') { opts.report = false; }
		else if (a === '--list') { opts.list = true; }
		else if (a === '--yes' || a === '-y') { opts.yes = true; }
		else if (a === '--memory') { opts.memory = true; }
		// Sticky, so that --no-workload holds regardless of where it sits
		// relative to a --workload-* option that would otherwise re-enable it.
		else if (a === '--no-memory') { opts.memoryOff = true; }
		else if (a === '--no-workload') { opts.workloadOff = true; }
		else if (a === '--memory-runs') { opts.memoryRuns = Number(argv[++i]); }
		else if (a === '--memory-settle') { opts.memorySettleMs = Number(argv[++i]); }
		else if (a === '--workload') { opts.workload = true; }
		else if (a === '--workload-folder') { opts.workload = true; opts.workloadFolder = path.resolve(argv[++i]); }
		else if (a === '--workload-open') { opts.workload = true; opts.workloadOpen = argv[++i]; }
		else if (a === '--workload-corpus') { opts.workload = true; opts.workloadCorpus = argv[++i]; }
		else if (a === '--emit-corpus') { opts.emitCorpus = path.resolve(argv[++i]); }
		else if (a === '--workload-runs') { opts.workload = true; opts.workloadRuns = Number(argv[++i]); }
		else if (a === '--workload-window') { opts.workload = true; opts.workloadWindowMs = Number(argv[++i]); }
		else if (a === '--workload-sample') { opts.workload = true; opts.workloadSampleMs = Number(argv[++i]); }
		else if (a === '--no-color' || a === '--no-colour') { COLOR = false; }
		else if (a === '--plain') { COLOR = false; LIVE = false; UNICODE = false; G = glyphs(); }
		else if (a === '--ascii') { UNICODE = false; G = glyphs(); }
		else if (a === '--version' || a === '-v') { console.log(`akkento-ide-bench ${VERSION}`); process.exit(0); }
		else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
		else { console.error(`unknown option: ${a}\n`); printUsage(); process.exit(1); }
	}
	if (!Number.isFinite(opts.runs) || opts.runs < 1) { console.error('--runs must be >= 1'); process.exit(1); }
	if (!Number.isFinite(opts.warmups) || opts.warmups < 0) { console.error('--warmups must be >= 0'); process.exit(1); }
	if (!Number.isFinite(opts.memoryRuns) || opts.memoryRuns < 1) { console.error('--memory-runs must be >= 1'); process.exit(1); }
	if (opts.memoryOff) { opts.memory = false; }
	if (opts.workloadOff) { opts.workload = false; }
	opts.workloadCorpus = CORPUS_ALIASES[opts.workloadCorpus] ?? opts.workloadCorpus;
	if (opts.emitCorpus && !(opts.workloadCorpus in CORPUS_SIZES)) {
		console.error(`--workload-corpus must be one of: ${Object.keys(CORPUS_SIZES).join(', ')}`);
		process.exit(1);
	}
	if (opts.workload) {
		if (!Number.isFinite(opts.workloadRuns) || opts.workloadRuns < 1) { console.error('--workload-runs must be >= 1'); process.exit(1); }
		if (!Number.isFinite(opts.workloadSampleMs) || opts.workloadSampleMs < 500) { console.error('--workload-sample must be >= 500'); process.exit(1); }
		// Three samples is the floor for the numbers this phase reports: the
		// steady state is the median of the last third of the window, and a
		// median of one sample is not a steady state, it is a sample.
		if (!Number.isFinite(opts.workloadWindowMs) || opts.workloadWindowMs < opts.workloadSampleMs * 6) {
			console.error(`--workload-window must be at least 6 samples long (>= ${opts.workloadSampleMs * 6} at this --workload-sample)`);
			process.exit(1);
		}
		if (!opts.workloadFolder && !(opts.workloadCorpus in CORPUS_SIZES)) {
			console.error(`--workload-corpus must be one of: ${Object.keys(CORPUS_SIZES).join(', ')}`);
			process.exit(1);
		}
		if (opts.workloadFolder && !isDirectory(opts.workloadFolder)) {
			console.error(`--workload-folder is not a directory: ${opts.workloadFolder}`);
			process.exit(1);
		}
	}
	return opts;
}

function printUsage() {
	const rows = [
		['--list', 'show which editors were found, and where'],
		['--yes, -y', 'skip the confirmation prompt and start straight away'],
		['--only a,b', 'benchmark just these editors (names from editors.json)'],
		['--runs N', 'measured runs per editor (default 10)'],
		['--warmups N', 'unmeasured warmup runs per editor (default 2)'],
		['--no-memory', 'skip the idle-memory phase (on by default)'],
		['--memory-runs N', 'memory runs per editor (default 3)'],
		['--memory-settle MS', 'wall clock from launch to the memory sample (default 30000)'],
		['--no-workload', 'skip the workload phase (on by default)'],
		['--workload-folder DIR', 'use this repository instead of the generated corpus'],
		['--workload-corpus NAME', `generated corpus: ${Object.keys(CORPUS_SIZES).join(' | ')} (default ts-2.5k)`],
		['--emit-corpus DIR', 'write the corpus to DIR, print its fingerprint, and exit'],
		['--workload-open PATH', 'file to open inside the repository, or "none" (default: the corpus entry point)'],
		['--workload-runs N', 'workload runs per editor (default 3)'],
		['--workload-window MS', 'how long each workload run is watched (default 180000)'],
		['--workload-sample MS', 'how often the process tree is walked (default 5000)'],
		['--folder DIR', 'open a workspace instead of an empty window'],
		['--max-load L', 'hold runs until 1-min load average is <= L (default 2.5)'],
		['--timeout MS', 'give up on a launch after this long (default 90000)'],
		['--no-window', 'skip the X11 window signal'],
		['--force-x11', 'push Wayland editors onto XWayland so the window signal can see them'],
		['--out DIR', 'directory for the exported report (default ./reports)'],
		['--json FILE', 'also write the raw JSON to this exact path'],
		['--no-report', 'do not write a report file'],
		['--config FILE', 'editor definitions (default editors.json beside this script)'],
		['--plain', 'no colour, no animation, no box drawing (CI-friendly)'],
		['--no-color', 'keep the layout, drop the colour'],
		['--version', 'print the harness version'],
	];
	const width = Math.max(...rows.map(r => r[0].length));
	console.log(`akkento-ide-bench ${VERSION} — startup, memory and workload benchmark for VS Code-family editors and Zed\n`);
	console.log('usage: node bench.mjs [options]\n');
	for (const [flag, help] of rows) { console.log(`  ${flag.padEnd(width)}  ${help}`); }
	console.log('\nevery phase runs by default: startup, then idle memory, then the workload phase.');
	console.log('\nexamples:');
	console.log('  node bench.mjs                                   # all three phases');
	console.log('  node bench.mjs --no-workload                     # startup and idle memory only');
	console.log('  node bench.mjs --no-memory --no-workload         # startup only, the quick one');
	console.log('  node bench.mjs --workload --workload-corpus ts-10k');
	console.log('  node bench.mjs --emit-corpus ./corpus            # inspect exactly what gets opened');
	console.log('  node bench.mjs --only vscode,zed --runs 15');
}

// ----------------------------------------------------------------------------
// environment capture — published numbers are meaningless without this, and a
// report someone sends us is only actionable with the machine attached to it
// ----------------------------------------------------------------------------

/** Run a command for its stdout. Never throws; never blocks for long. */
function sh(cmd, args, timeout = 5000) {
	try {
		const out = execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
		return out.trim() || undefined;
	} catch {
		return undefined;
	}
}

function readFirstLine(file) {
	try { return fs.readFileSync(file, 'utf8').split('\n')[0].trim(); } catch { return undefined; }
}

function readFileSafe(file) {
	try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

function isDirectory(target) {
	try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

function bytesToGB(bytes) {
	return Number((bytes / 2 ** 30).toFixed(1));
}

/**
 * Filesystem backing a directory — on Linux `/tmp` is frequently tmpfs, which
 * is RAM, and a profile written to RAM flatters an editor's startup I/O. Both
 * platforms answer with the longest matching mount point.
 */
function filesystemOf(dir) {
	const mounts = IS_LINUX
		? readFileSafe('/proc/mounts')?.split('\n').map(line => {
			const [, point, type] = line.split(' ');
			return point && type ? { point: point.replace(/\\040/g, ' '), type } : undefined;
		})
		: IS_MAC
			? sh('mount', [], 5000)?.split('\n').map(line => {
				// /dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)
				const match = line.match(/ on (.+?) \(([^,)]+)/);
				return match ? { point: match[1], type: match[2] } : undefined;
			})
			: undefined;
	let best;
	for (const mount of mounts ?? []) {
		if (!mount) { continue; }
		const prefix = mount.point.endsWith('/') ? mount.point : `${mount.point}/`;
		if (dir === mount.point || dir.startsWith(prefix)) {
			if (!best || mount.point.length > best.point.length) { best = mount; }
		}
	}
	return best?.type;
}

function linuxHost() {
	const osRelease = readFileSafe('/etc/os-release') ?? '';
	const distro = osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1];
	const meminfo = readFileSafe('/proc/meminfo') ?? '';
	const swapKB = Number(meminfo.match(/^SwapTotal:\s+(\d+) kB/m)?.[1] ?? 0);

	let power;
	try {
		for (const supply of fs.readdirSync('/sys/class/power_supply')) {
			const type = readFirstLine(`/sys/class/power_supply/${supply}/type`);
			if (type === 'Mains') {
				power = readFirstLine(`/sys/class/power_supply/${supply}/online`) === '1' ? 'ac' : 'battery';
			} else if (type === 'Battery' && power === undefined) {
				const status = readFirstLine(`/sys/class/power_supply/${supply}/status`);
				power = status === 'Discharging' ? 'battery' : 'ac';
			}
		}
	} catch { /* desktop with no power_supply class */ }

	const gpu = sh('lspci', [])?.split('\n')
		.filter(line => /VGA compatible controller|3D controller|Display controller/i.test(line))
		.map(line => line.replace(/^\S+\s+/, '').replace(/^[^:]+:\s*/, '').trim());

	return {
		distro,
		kernel: `${os.type()} ${os.release()}`,
		cpuGovernor: readFirstLine('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
		cpuScalingDriver: readFirstLine('/sys/devices/system/cpu/cpu0/cpufreq/scaling_driver'),
		swapGB: swapKB ? bytesToGB(swapKB * 1024) : 0,
		powerSource: power,
		gpu: gpu?.length ? gpu : undefined,
		sessionType: process.env.XDG_SESSION_TYPE ?? 'unknown',
		desktop: process.env.XDG_CURRENT_DESKTOP ?? 'unknown',
		displayServer: process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : 'none',
	};
}

function macHost() {
	const sysctl = key => sh('sysctl', ['-n', key], 3000);
	const battery = sh('pmset', ['-g', 'batt'], 3000) ?? '';
	const powerSource = /AC Power/.test(battery) ? 'ac' : /Battery Power/.test(battery) ? 'battery' : undefined;
	const charge = battery.match(/(\d+)%/)?.[1];
	const lowPower = sh('pmset', ['-g'], 3000)?.match(/lowpowermode\s+(\d)/)?.[1];
	// CPU_Speed_Limit < 100 means the machine is already throttling: any number
	// measured now is a thermally limited number, and the report has to say so.
	const speedLimit = sh('pmset', ['-g', 'therm'], 3000)?.match(/CPU_Speed_Limit\s*=\s*(\d+)/)?.[1];
	const chipset = sh('system_profiler', ['SPDisplaysDataType'], 12_000)
		?.split('\n').filter(line => /Chipset Model:/.test(line))
		.map(line => line.split(':')[1].trim());

	const performanceCores = Number(sysctl('hw.perflevel0.logicalcpu') ?? 0) || undefined;
	const efficiencyCores = Number(sysctl('hw.perflevel1.logicalcpu') ?? 0) || undefined;

	return {
		distro: [sh('sw_vers', ['-productName'], 3000) ?? 'macOS', sh('sw_vers', ['-productVersion'], 3000)]
			.filter(Boolean).join(' '),
		build: sh('sw_vers', ['-buildVersion'], 3000),
		kernel: `${os.type()} ${os.release()}`,
		model: sysctl('hw.model'),
		chip: sysctl('machdep.cpu.brand_string'),
		performanceCores,
		efficiencyCores,
		rosetta: sysctl('sysctl.proc_translated') === '1' || undefined,
		powerSource,
		batteryPercent: charge ? Number(charge) : undefined,
		lowPowerMode: lowPower === undefined ? undefined : lowPower === '1',
		cpuSpeedLimit: speedLimit ? Number(speedLimit) : undefined,
		gpu: chipset?.length ? chipset : undefined,
		sessionType: 'quartz',
		desktop: 'Aqua',
		displayServer: 'quartz',
	};
}

function windowsHost() {
	// One PowerShell round trip: each additional one costs ~200 ms.
	const script = `
$ErrorActionPreference='SilentlyContinue'
$os  = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name })
$bat = Get-CimInstance Win32_Battery | Select-Object -First 1
[pscustomobject]@{
  caption=$os.Caption; version=$os.Version; build=$os.BuildNumber;
  cpu=$cpu.Name; physicalCores=$cpu.NumberOfCores; maxClockMHz=$cpu.MaxClockSpeed;
  gpu=$gpu; onBattery=[bool]($bat -and $bat.BatteryStatus -eq 1); batteryPercent=$bat.EstimatedChargeRemaining;
  powerPlan=(powercfg /getactivescheme)
} | ConvertTo-Json -Compress -Depth 3`;
	try {
		const raw = sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 15_000);
		const info = raw ? JSON.parse(raw) : {};
		return {
			distro: [info.caption, info.version && `(${info.version})`].filter(Boolean).join(' ') || 'Windows',
			build: info.build,
			kernel: `${os.type()} ${os.release()}`,
			chip: info.cpu,
			physicalCores: info.physicalCores,
			maxClockMHz: info.maxClockMHz,
			gpu: Array.isArray(info.gpu) ? info.gpu : info.gpu ? [info.gpu] : undefined,
			powerSource: info.onBattery ? 'battery' : 'ac',
			batteryPercent: info.batteryPercent ?? undefined,
			powerPlan: info.powerPlan?.match(/\(([^)]+)\)/)?.[1],
			sessionType: 'windows',
			desktop: 'Explorer',
			displayServer: 'dwm',
		};
	} catch {
		return { distro: 'Windows', kernel: `${os.type()} ${os.release()}` };
	}
}

/**
 * Everything about this machine that changes the numbers. Deliberately
 * excludes the hostname and username; binary paths are redacted before they
 * reach the report, so a report can be sent to us as-is.
 */
function captureHost() {
	const perOS = IS_LINUX ? linuxHost() : IS_MAC ? macHost() : windowsHost();
	const cpus = os.cpus();
	return {
		platform: os.platform(),
		arch: os.arch(),
		os: `${os.type()} ${os.release()}`,
		cpu: perOS.chip ?? cpus[0]?.model ?? 'unknown',
		cores: cpus.length,
		cpuSpeedMHz: cpus[0]?.speed || undefined,
		ramGB: Math.round(os.totalmem() / 2 ** 30),
		freeRamGB: bytesToGB(os.freemem()),
		node: process.version,
		v8: process.versions.v8,
		uptimeHours: Number((os.uptime() / 3600).toFixed(1)),
		...perOS,
	};
}

/** One-line machine summary for the console header. */
function hostSummary(host) {
	const parts = [
		host.distro ?? host.os,
		host.model,
		`${host.cpu} × ${host.cores}`,
		`${host.ramGB} GB RAM`,
	];
	if (host.gpu?.length) { parts.push(host.gpu[0]); }
	return parts.filter(Boolean).join(c.grey('  ·  '));
}

/**
 * Conditions that quietly bend results. Surfaced before the run so the
 * operator can fix them, and recorded in the report so a submitted result can
 * be read in context.
 */
function hostWarnings(host) {
	const warnings = [];
	if (host.powerSource === 'battery') {
		warnings.push('running on battery — most laptops clock down off AC; plug in for comparable numbers');
	}
	if (host.lowPowerMode) {
		warnings.push('macOS Low Power Mode is on — it caps clocks; turn it off before benchmarking');
	}
	if (host.cpuSpeedLimit !== undefined && host.cpuSpeedLimit < 100) {
		warnings.push(`CPU is thermally limited to ${host.cpuSpeedLimit}% — let the machine cool down first`);
	}
	if (host.cpuGovernor && host.cpuGovernor !== 'performance') {
		warnings.push(`CPU governor is '${host.cpuGovernor}' — frequency scaling adds variance; 'performance' gives tighter numbers`);
	}
	if (host.rosetta) {
		warnings.push('this harness is running under Rosetta — run it with a native arm64 Node');
	}
	if (host.freeRamGB !== undefined && host.freeRamGB < 2) {
		warnings.push(`only ${host.freeRamGB} GB RAM free — memory pressure will distort startup and memory numbers`);
	}
	return warnings;
}

// ----------------------------------------------------------------------------
// editor families
// ----------------------------------------------------------------------------

/** Zed logs this the moment its workspace has painted. */
const ZED_READY_MARK = 'Rendered first frame';

/**
 * The longest path a unix socket can be bound at: sun_path holds 108 bytes on
 * Linux and 104 on macOS, terminator included. Not a detail — an editor that
 * claims its single-instance lock by binding a socket inside the throwaway
 * profile cannot start at all when the profile path leaves no room for it, so
 * this number decides where the profiles are allowed to live.
 */
const UNIX_SOCKET_MAX = IS_MAC ? 103 : 107;

/**
 * Everything that differs between an editor built on Code and one that is not.
 * The shape of a launch does not differ — isolate a profile, spawn, watch the
 * file the editor writes its own ready mark into, kill, sweep, discard — so a
 * family may only define the pieces that plug into that: the flags, the file,
 * how to read the mark out of it, and where the startup number comes from once
 * it is there. Anything needing more than this would be a different
 * measurement wearing the same column heading.
 */
const FAMILIES = {
	code: {
		title: 'VS Code family',
		readyMark: 'workbench ready',
		startupDefinition: 'main process start → workbench ready, self-reported (--prof-append-timers)',
		/** The mark carries its own elapsed; when it was seen is 15s of noise. */
		startupFrom: mark => mark.timers,
		reportsTimers: true,
		needsExtensionsDir: true,
		/**
		 * The Code family claims its single-instance lock the way Zed does —
		 * by binding a unix socket — and puts it inside the profile, named
		 * `<version, first 4 chars>-<type, first 6>.sock`: `1.13-main.sock`.
		 * Upstream trims that name to keep it short and then only *warns* when
		 * the directory it sits in pushes the whole path over the limit, which
		 * is not what happens next: the bind fails with EINVAL, that is not the
		 * EADDRINUSE which means "hand off to the instance already running", so
		 * the main process prints the error and exits 1 — before a window, on
		 * every launch, for the length of the batch.
		 * On macOS the socket always lands in the profile; elsewhere it goes to
		 * XDG_RUNTIME_DIR when that is set. The harness sizes for the case
		 * where it does not, rather than for the session it happens to be in.
		 */
		profileSocket: IS_WIN ? undefined : '0000-main.sock',
		exitHint: 'a Code-family editor exits this way when the launch was handed off to an instance that was already running (close every copy of it and rerun), or when it could not bind its single-instance socket inside the throwaway profile',
		launchArgs(launch, opts, phase) {
			const args = [
				`--user-data-dir=${launch.userDataDir}`,
				`--extensions-dir=${launch.extensionsDir}`,
				// Startup phase only. This flag does not merely report a
				// number: the editor waits a fixed 15 seconds, appends the
				// file, and then exits — which is fine when the number is what
				// is being collected, and fatal underneath a memory sample,
				// which would be taken of a process tree that had already gone.
				...(phase === 'startup' ? ['--prof-append-timers', launch.timersFile] : []),
				'--disable-workspace-trust',
				'--skip-release-notes',
				'--skip-welcome',
			];
			if (opts.forceX11 && IS_LINUX) { args.push('--ozone-platform=x11'); }
			return args;
		},
		readyFile: launch => launch.timersFile,
		/** One tab-separated line per launch; this file only ever sees ours. */
		readyFrom(lines) {
			const ms = Number(lines[lines.length - 1].split('\t')[0]);
			return Number.isFinite(ms) && ms > 0 ? { timers: ms } : undefined;
		},
		// Reaching workbench-ready is not what the harness is waiting for here,
		// and a note that says otherwise sends the operator hunting a hang that
		// is not there.
		timeoutHint: 'the editor started but has not written its timers file: it holds that write for a fixed 15s after workbench-ready, plus whatever its startup telemetry costs, so a loaded machine can push it past the timeout — raise --timeout, or free the machine up',
		staticVersion: binary => codeStaticVersion(binary),
		versionArgs: probeDir => ['--version', `--user-data-dir=${probeDir}`, `--extensions-dir=${probeDir}`],
		survivorNeedles: launch => [`--user-data-dir=${launch.userDataDir}`],
	},

	zed: {
		title: 'Zed',
		readyMark: `its first rendered frame ("${ZED_READY_MARK}" in its log)`,
		startupDefinition: 'exec → first frame rendered, timed by the harness (Zed reports no elapsed of its own)',
		startupFrom: (mark, observedMs) => observedMs,
		reportsTimers: false,
		needsExtensionsDir: false,
		appBinary: binary => zedAppBinary(binary),
		// Zed binds this inside the profile on Linux, so the profile path has
		// to leave room for it — see the preflight check. On macOS and Windows
		// it takes a machine-wide lock instead, which no profile can sidestep.
		profileSocket: IS_LINUX ? 'zed-nightly.sock' : undefined,
		machineWideLock: !IS_LINUX,
		/**
		 * One flag does what Code needs two for: `--user-data-dir` moves Zed's
		 * database, extensions, logs *and* — because Zed derives it from the
		 * data directory — its config directory, so a launch reads none of the
		 * operator's settings and installs none of their extensions.
		 *
		 * ZED_STATELESS would be the shorter road to a clean start and is
		 * deliberately not taken: it swaps the on-disk database for an
		 * in-memory one, which is work every real Zed launch does and this one
		 * would then be excused from.
		 *
		 * Nothing here mirrors --skip-welcome or --disable-workspace-trust.
		 * Zed has no equivalent, so its cold start pays for whatever it shows
		 * on a fresh profile, and that asymmetry is documented rather than
		 * papered over. `--force-x11` needs no flag either: buildEnv removes
		 * WAYLAND_DISPLAY, which is what Zed reads when it picks a backend.
		 */
		launchArgs(launch) {
			return [`--user-data-dir=${launch.userDataDir}`];
		},
		/**
		 * Zed's logs_dir() honours the data directory on Linux and Windows,
		 * but on macOS it is `~/Library/Logs/Zed` and is derived from the home
		 * directory alone — `--user-data-dir` moves everything else and not
		 * this. A profile-relative path there is a file that is never written,
		 * so every launch would burn the whole timeout without a mark.
		 * That file is shared by every launch, which is what readyOffset is
		 * for: the mark left by the previous run is already in it.
		 */
		readyFile: launch => (IS_MAC
			? path.join(os.homedir(), 'Library', 'Logs', 'Zed', 'Zed.log')
			: path.join(launch.userDataDir, 'logs', 'Zed.log')),
		sharedReadyFile: IS_MAC,
		readyFrom(lines) {
			return lines.some(line => line.includes(ZED_READY_MARK)) ? {} : undefined;
		},
		staticVersion: binary => zedStaticVersion(binary),
		versionArgs: undefined,		// the app binary has no --version; see zedStaticVersion
		// "========== starting zed version 1.2.3+stable.42.<sha>, sha <short> =========="
		versionFromLines: lines => lines
			.map(line => line.match(/starting zed version ([^\s,]+)/)?.[1])
			.find(Boolean),
		/**
		 * The bare path, not `--user-data-dir=`: the helpers Zed runs out of
		 * its own data directory (its bundled node, prettier, language servers)
		 * name a path inside it instead of repeating the flag. The crash
		 * handler names neither — it is passed a socket under the cache
		 * directory, keyed by the pid that started it.
		 */
		survivorNeedles: (launch, rootPid) => [
			launch.userDataDir,
			...(rootPid ? [`zed-crash-handler-${rootPid}`] : []),
		],
		exitHint: 'Zed prints "zed is already running" and exits when it cannot take the single-instance lock: another Zed is running (close it — on macOS and Windows that lock is machine-wide, so a throwaway profile does not sidestep it), or, on Linux, the throwaway profile path is too long for the unix socket Zed binds inside it (set TMPDIR to something shorter)',
	},
};

function familyOf(editor) {
	return FAMILIES[editor.family ?? 'code'] ?? FAMILIES.code;
}

// ----------------------------------------------------------------------------
// editor discovery
// ----------------------------------------------------------------------------

/**
 * The executable inside a macOS .app bundle. Read from Info.plist rather than
 * guessed: forks disagree about it — some keep Electron's default name, others
 * rename it to the product — and a wrong guess is indistinguishable from "not
 * installed" at the point where it matters.
 */
function macBundleExecutable(appDir) {
	const macOSDir = path.join(appDir, 'Contents', 'MacOS');
	const plist = path.join(appDir, 'Contents', 'Info.plist');
	const named = name => {
		const candidate = path.join(macOSDir, name);
		return name && fs.existsSync(candidate) ? candidate : undefined;
	};
	// Info.plist is usually a binary plist; plutil ships with every macOS.
	const json = sh('plutil', ['-convert', 'json', '-o', '-', plist], 5000);
	if (json) {
		try {
			const hit = named(JSON.parse(json).CFBundleExecutable);
			if (hit) { return hit; }
		} catch { /* not JSON-convertible */ }
	}
	const xml = readFileSafe(plist);
	const fromXml = xml?.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
	if (fromXml) {
		const hit = named(fromXml);
		if (hit) { return hit; }
	}
	try {
		const entries = fs.readdirSync(macOSDir).filter(entry => !entry.startsWith('.'));
		if (entries.length === 1) { return path.join(macOSDir, entries[0]); }
	} catch { /* not a bundle */ }
	return undefined;
}

function whichAll(cmd) {
	try {
		const finder = IS_WIN ? 'where' : 'which';
		const out = execFileSync(finder, [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		return out.split('\n').map(l => l.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

const WIN_SPAWNABLE = new Set(['.exe', '.com']);

/**
 * Windows: `where <editor>` returns the CLI shims every Code fork installs
 * into `bin\` — an extensionless POSIX script and a `.cmd` — before (or
 * instead of) anything spawnable. Both are dead ends here:
 *   - Node refuses to spawn `.cmd`/`.bat` without a shell (CVE-2024-27980),
 *     and cannot execute an extensionless script at all: spawn EINVAL
 *   - even through a shell they only re-exec the app with ELECTRON_RUN_AS_NODE
 *     to run `cli.js`, which hands off to a detached process tree — so the pid
 *     we hold would not be the editor, and both the kill and the memory walk
 *     would target the wrong thing
 * Walk the shim back to the app executable it wraps.
 */
function resolveWindowsLauncher(candidate) {
	if (WIN_SPAWNABLE.has(path.extname(candidate).toLowerCase())) { return candidate; }
	const binDir = path.dirname(candidate);
	if (path.basename(binDir).toLowerCase() !== 'bin') { return undefined; }
	const appDir = path.dirname(binDir);

	// The `.cmd` shim names the executable: "%~dp0..\Foo.exe" ... cli.js
	const cmdShim = path.join(binDir, `${path.basename(candidate, path.extname(candidate))}.cmd`);
	try {
		const named = fs.readFileSync(cmdShim, 'utf8').match(/%~dp0\.\.[\\/]([^"]+\.exe)/i);
		if (named) {
			const exe = path.join(appDir, named[1]);
			if (fs.existsSync(exe)) { return exe; }
		}
	} catch { /* no shim, or one we don't recognise */ }

	// Fall back to the lone app executable beside `bin\`. A build that renamed
	// the exe without regenerating the shim lands here — the shim then points
	// at a file that does not exist.
	try {
		const exes = fs.readdirSync(appDir)
			.filter(f => f.toLowerCase().endsWith('.exe') && !/^(unins|setup|update|squirrel)/i.test(f));
		if (exes.length === 1) { return path.join(appDir, exes[0]); }
	} catch { /* unreadable install dir */ }
	return undefined;
}

function isScript(file) {
	try {
		const fd = fs.openSync(file, 'r');
		const head = Buffer.alloc(2);
		fs.readSync(fd, head, 0, 2, 0);
		fs.closeSync(fd);
		return head.toString('latin1') === '#!';
	} catch {
		return false;
	}
}

/**
 * macOS and Linux: `code`, `cursor`, `codium` on PATH are the same CLI shim as
 * on Windows — a shell script (usually reached through a symlink into the
 * install) that re-execs the app with ELECTRON_RUN_AS_NODE to run `cli.js`,
 * which hands off to a detached process. Timing or killing the pid we hold
 * would then be timing or killing the wrong process, so walk it back:
 *   macOS   <App>.app/Contents/Resources/app/bin/<name>  ->  bundle executable
 *   Linux   <root>/bin/<name>  ->  <root>/<product.applicationName>
 */
function resolveUnixLauncher(candidate) {
	let real = candidate;
	try { real = fs.realpathSync(candidate); } catch { /* dangling symlink */ }

	if (IS_MAC) {
		const bundle = real.match(/^(.*?\.app)(?:\/|$)/)?.[1];
		if (bundle) {
			const exe = macBundleExecutable(bundle);
			if (exe) { return { binary: exe, via: candidate }; }
		}
	}

	const binDir = path.dirname(real);
	if (path.basename(binDir) === 'bin') {
		const root = path.dirname(binDir);
		try {
			const product = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'app', 'product.json'), 'utf8'));
			const exe = path.join(root, product.applicationName ?? '');
			if (product.applicationName && fs.existsSync(exe)) { return { binary: exe, via: candidate }; }
		} catch { /* not a Code-family install root */ }
	}

	if (isScript(real)) {
		return {
			reason: `'${path.basename(candidate)}' on PATH is the CLI shim (${redact(candidate)}), which hands off to a detached process the harness cannot time or kill — add the real binary to "paths" in editors.json`,
		};
	}
	return { binary: real, via: real === candidate ? undefined : candidate };
}

/** Resolved binary for a PATH command, plus why it was rejected if it was. */
function resolveCommand(cmd) {
	const hits = whichAll(cmd);
	if (!hits.length) { return {}; }
	if (!IS_WIN) {
		let reason;
		for (const hit of hits) {
			const resolved = resolveUnixLauncher(hit);
			if (resolved.binary) { return resolved; }
			reason = reason ?? resolved.reason;
		}
		return { reason };
	}
	for (const hit of hits) {
		const exe = resolveWindowsLauncher(hit);
		if (exe) { return { binary: exe, via: exe === hit ? undefined : hit }; }
	}
	return { reason: `'${cmd}' on PATH resolves only to CLI shims (${hits.map(redact).join(', ')}) and no app executable was found beside them — add the .exe to editors.json "paths"` };
}

/**
 * Why this binary cannot be launched by the harness, if it cannot. Checked up
 * front: the alternative is discovering it once per round, ten rounds deep.
 */
function launchProblem(binary) {
	if (IS_WIN) {
		if (!WIN_SPAWNABLE.has(path.extname(binary).toLowerCase())) {
			return `${path.basename(binary)} is a script/batch shim, not an executable — Node cannot spawn it (EINVAL), and it would hand off to a detached process the harness cannot time or kill. Point "paths" at the app .exe.`;
		}
		return undefined;
	}
	try {
		fs.accessSync(binary, fs.constants.X_OK);
	} catch {
		return 'not executable (chmod +x, or point "paths" at the real binary)';
	}
	if (isScript(binary)) {
		return 'this is a shell script, not the app binary — it hands off to a detached process the harness cannot time or kill. On macOS point "paths" at the .app bundle; on Linux at the binary in the install root.';
	}
	return undefined;
}

function expandPath(p) {
	return p
		.replace(/^~(?=[\/\\]|$)/, os.homedir())
		.replace(/\$\{?(\w+)\}?/g, (_, name) => process.env[name] ?? '')
		.replace(/%(\w+)%/g, (_, name) => process.env[name] ?? '');
}

/**
 * One configured path -> a launchable binary, or nothing. A macOS entry may
 * name the `.app` bundle itself, which is what a user knows about and what
 * every install path in the wild looks like; the executable inside is derived.
 */
function resolveCandidatePath(candidate) {
	const expanded = expandPath(candidate);
	if (!expanded || !fs.existsSync(expanded)) { return undefined; }
	if (expanded.endsWith('.app')) { return IS_MAC ? macBundleExecutable(expanded) : undefined; }
	try { if (fs.statSync(expanded).isDirectory()) { return undefined; } } catch { return undefined; }
	return expanded;
}

function firstExisting(paths) {
	for (const p of paths ?? []) {
		const resolved = resolveCandidatePath(p);
		if (resolved) { return resolved; }
	}
	return undefined;
}

/**
 * Two configured entries resolving to one executable is not a comparison — it
 * is one editor benchmarked twice, printing a delta against itself and paying
 * for a second batch to do it. This is not hypothetical: after a rebrand the
 * old and the new name both point at an install that changed identity in
 * place, so the first entry wins and the rest are reported and dropped.
 */
function dedupeByBinary(editors) {
	const seen = new Map();
	const unique = [];
	const duplicates = [];
	for (const editor of editors) {
		let key = editor.binary;
		try { key = fs.realpathSync(editor.binary); } catch { /* dangling or raced */ }
		const first = seen.get(key);
		if (first) { duplicates.push({ name: editor.name, sameAs: first, binary: editor.binary }); continue; }
		seen.set(key, editor.name);
		unique.push(editor);
	}
	return { unique, duplicates };
}

function resolveEditors(config, only) {
	const resolved = [];
	for (const editor of config.editors) {
		if (only && !only.includes(editor.name)) { continue; }
		let binary = editor.binary ? firstExisting([editor.binary]) : firstExisting(editor.paths);
		let via;
		let reason;
		if (!binary && !editor.binary) {
			for (const cmd of editor.commands ?? []) {
				const hit = resolveCommand(cmd);
				if (hit.binary) { ({ binary, via } = hit); break; }
				reason = reason ?? hit.reason;
			}
		}
		// A family may ship a launcher that is not the app: walk it back before
		// anything downstream treats this path as the process to measure.
		const app = binary ? familyOf(editor).appBinary?.(binary) : undefined;
		if (app) { via = via ?? binary; binary = app; }
		resolved.push({ ...editor, binary, via, unresolvedReason: binary ? undefined : reason });
	}
	return resolved;
}

/**
 * Candidate `resources/app` directories for a Code-family binary, most likely
 * first. Windows VS Code (>= 1.99) stages each update in a commit-named folder
 * beside the launcher, so the metadata is one level deeper than on Linux.
 */
function appMetadataDirs(binary) {
	const dir = path.dirname(binary);
	const dirs = [
		path.join(dir, 'resources', 'app'),			// Linux/Windows install root
		path.join(dir, '..', 'Resources', 'app'),	// macOS bundle (Contents/MacOS/<exe>)
		path.join(dir, '..', 'resources', 'app'),
	];
	try {
		const staged = fs.readdirSync(dir, { withFileTypes: true })
			.filter(entry => entry.isDirectory() && /^[0-9a-f]{8,40}$/i.test(entry.name))
			.map(entry => path.join(dir, entry.name))
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);	// newest staged build wins
		dirs.push(...staged.map(p => path.join(p, 'resources', 'app')));
	} catch { /* unreadable install dir */ }
	return dirs;
}

/** Version from the shipped metadata — no launch, no window, no waiting. */
function codeStaticVersion(binary) {
	for (const appDir of appMetadataDirs(binary)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
			const product = JSON.parse(fs.readFileSync(path.join(appDir, 'product.json'), 'utf8'));
			const fields = [product.nameLong ?? pkg.name, pkg.version, product.commit, product.quality];
			const line = fields.filter(Boolean).join(' · ');
			if (line) { return line; }
		} catch { /* not this layout */ }
	}
	return undefined;
}

/**
 * `zed` — on PATH, and in every tarball — is a small launcher that hands the
 * paths to the real binary over a socket and exits. The pid the harness held
 * would not be the editor it is timing, killing or walking for memory, so walk
 * it back the way the Code-family shims are walked back:
 *   <root>/bin/zed  ->  <root>/libexec/zed-editor
 * A macOS bundle needs none of this: Info.plist already names the app binary,
 * and Zed's CLI sits beside it under a different name.
 */
function zedAppBinary(binary) {
	const dir = path.dirname(binary);
	if (path.basename(dir).toLowerCase() !== 'bin') { return undefined; }
	for (const name of ['zed-editor', 'zed-editor.exe']) {
		const app = path.join(path.dirname(dir), 'libexec', name);
		if (fs.existsSync(app)) { return app; }
	}
	return undefined;
}

/**
 * Zed's build, without launching it. There is no product.json to read and the
 * app binary rejects `--version` — that flag belongs to the small CLI beside
 * it, which answers instantly and opens no window. When neither is reachable
 * the version is recovered from the first launch's own log instead (see
 * `versionFromLines`), so a report never ships a blank build.
 */
function zedStaticVersion(binary) {
	const dir = path.dirname(binary);
	const candidates = [
		path.join(path.dirname(dir), 'bin', IS_WIN ? 'zed.exe' : 'zed'),	// <root>/libexec/zed-editor
		path.join(dir, IS_WIN ? 'cli.exe' : 'cli'),							// macOS: Contents/MacOS/{zed,cli}
	];
	for (const cli of candidates) {
		try {
			// Never the app binary itself: that one would open a window and
			// hold the lock for every launch that followed.
			if (!fs.existsSync(cli) || fs.realpathSync(cli) === fs.realpathSync(binary)) { continue; }
		} catch { continue; }
		const out = sh(cli, ['--version'], 10_000);
		// "Zed 1.2.3 <sha> – /path/to/zed-editor": the path is the harness's
		// own resolution repeated back, and it would carry $HOME into a report.
		if (out) { return redact(out.split('\n')[0].replace(/\s+[–-]\s+\S*[\\/].*$/, '').trim()); }
	}
	return undefined;
}

/**
 * Version of the editor under test. Read from shipped metadata where possible:
 * a fork whose main process does not special-case `--version` (branded builds
 * frequently don't) opens a real window instead of printing, which costs the
 * probe timeout and can leave a survivor holding the singleton lock — which
 * would turn every later launch into a no-op handoff. The `--version` fallback
 * therefore runs against a throwaway profile and is reaped either way.
 */
async function editorVersion(editor, root) {
	const family = familyOf(editor);
	const fromMetadata = family.staticVersion?.(editor.binary);
	if (fromMetadata) { return fromMetadata; }
	if (!family.versionArgs) { return 'unknown (recovered from the first launch)'; }
	const probeDir = path.join(root, editor.name, 'version-probe');
	try {
		fs.mkdirSync(probeDir, { recursive: true });
		return execFileSync(editor.binary, family.versionArgs(probeDir),
			{ encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] })
			.split('\n').filter(Boolean).slice(0, 3).join(' · ') || 'unknown (no output)';
	} catch (error) {
		return error.killed ? 'unknown (--version did not answer in 15s)' : 'unknown';
	} finally {
		await killByProfile([probeDir]);
	}
}

// ----------------------------------------------------------------------------
// window signal (X11)
// ----------------------------------------------------------------------------

function haveWindowTools() {
	return IS_LINUX && whichAll('wmctrl').length > 0 && whichAll('xprop').length > 0;
}

function clientWindows() {
	try {
		const out = execFileSync('wmctrl', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		return new Set(out.split('\n').filter(Boolean).map(line => line.split(/\s+/)[0]));
	} catch {
		return undefined;
	}
}

function windowPid(id) {
	try {
		const out = execFileSync('xprop', ['-id', id, '_NET_WM_PID'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		const match = out.match(/= (\d+)/);
		return match ? Number(match[1]) : undefined;
	} catch {
		return undefined;
	}
}

// ----------------------------------------------------------------------------
// process tree
// ----------------------------------------------------------------------------

/** [{pid, ppid}] snapshot of all processes, per OS. */
function processTable() {
	if (IS_LINUX) {
		const rows = [];
		for (const entry of fs.readdirSync('/proc')) {
			if (!/^\d+$/.test(entry)) { continue; }
			try {
				const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
				const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
				rows.push({ pid: Number(entry), ppid });
			} catch { /* raced with exit */ }
		}
		return rows;
	}
	if (IS_MAC) {
		try {
			const out = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
			return out.split('\n').filter(Boolean).map(line => {
				const [pid, ppid] = line.trim().split(/\s+/).map(Number);
				return { pid, ppid };
			});
		} catch {
			return [];
		}
	}
	// Windows: CIM over PowerShell. Costly (~200ms) — call sites keep this off
	// the hot polling path.
	try {
		const out = execFileSync('powershell', ['-NoProfile', '-Command',
			'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		return out.split('\n').filter(Boolean).map(line => {
			const [pid, ppid] = line.trim().split(/\s+/).map(Number);
			return { pid, ppid };
		});
	} catch {
		return [];
	}
}

function descendantPids(rootPid) {
	const children = new Map();
	for (const { pid, ppid } of processTable()) {
		if (!children.has(ppid)) { children.set(ppid, []); }
		children.get(ppid).push(pid);
	}
	const result = new Set([rootPid]);
	const queue = [rootPid];
	while (queue.length) {
		for (const child of children.get(queue.pop()) ?? []) {
			if (!result.has(child)) { result.add(child); queue.push(child); }
		}
	}
	return result;
}

/** A literal path as a PowerShell single-quoted string and a `-like` pattern. */
function psLikeLiteral(value) {
	return value.replace(/`/g, '``').replace(/([[\]*?])/g, '`$1').replace(/'/g, "''");
}

/**
 * Pids whose command line references anything belonging to this launch — its
 * profile, and whatever else the family knows names it. Catches processes that
 * re-parented away from the spawn tree (Electron detaches liberally) and the
 * helpers editors spawn from their own install — language servers, MCP servers
 * — which are not the editor executable at all; a survivor competes for the
 * machine with every run that follows it.
 *
 * `ps -ww` on macOS is not optional: without it the command line is truncated
 * to the terminal width, the `--user-data-dir=` argument falls off the end of
 * the line, and every sweep reports clean while the editor is still running.
 *
 * The Windows query has to exclude itself: it walks command lines from a
 * PowerShell process whose own command line contains the profile path. Left in,
 * every sweep matches itself, so it never reports clean — and then kills a pid
 * that has already exited, which Windows is free to have recycled by then.
 */
function pidsUsingProfile(needles) {
	const pids = [];
	if (IS_LINUX) {
		for (const entry of fs.readdirSync('/proc')) {
			if (!/^\d+$/.test(entry)) { continue; }
			try {
				const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
				if (needles.some(needle => cmdline.includes(needle))) {
					pids.push(Number(entry));
				}
			} catch { /* raced */ }
		}
		return pids;
	}
	if (IS_MAC) {
		try {
			const out = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
			for (const line of out.split('\n')) {
				if (needles.some(needle => line.includes(needle))) {
					const pid = Number(line.trim().split(/\s+/)[0]);
					if (Number.isFinite(pid)) { pids.push(pid); }
				}
			}
		} catch { /* best effort */ }
		return pids;
	}
	try {
		const clause = needles.map(needle => `$_.CommandLine -like '*${psLikeLiteral(needle)}*'`).join(' -or ');
		const out = execFileSync('powershell', ['-NoProfile', '-Command',
			`Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (${clause}) } | ForEach-Object { $_.ProcessId }`],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		for (const line of out.split('\n')) {
			const pid = Number(line.trim());
			if (Number.isFinite(pid) && pid > 0) { pids.push(pid); }
		}
	} catch { /* best effort */ }
	return pids;
}

function killPid(pid) {
	if (IS_WIN) {
		try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
	} else {
		try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
	}
}

/**
 * Kill by profile reference until nothing matches. Catches processes that
 * re-parented away from the spawn tree. Returns whatever refused to die — the
 * caller must report that rather than swallow it: a survivor is a process
 * competing with every run that follows.
 */
async function killByProfile(needles) {
	let survivors = [];
	for (let attempt = 0; attempt < 20; attempt++) {
		survivors = pidsUsingProfile(needles);
		if (survivors.length === 0) { return survivors; }
		for (const pid of survivors) { killPid(pid); }
		await sleep(250);
	}
	return pidsUsingProfile(needles);
}

/**
 * The launch under measurement and the temp root, for the interrupt handler,
 * so ^C takes the editor and its profile with it: an orphan left running
 * against a profile in temp becomes the next batch's noise floor, and the
 * operator has no obvious way to know it is there.
 */
let inFlight;
let stateRoot;

function handleInterrupt(signal) {
	ui.clearStatus();
	ui.log('');
	ui.log(`${c.yellow(G.warn)} ${signal === 'SIGINT' ? 'interrupted' : `stopped (${signal})`} — killing the editor under test and removing throwaway profiles`);
	if (inFlight) {
		killTree(inFlight.child);
		for (const pid of pidsUsingProfile(inFlight.launch.needles)) { killPid(pid); }
	}
	if (stateRoot) {
		try { fs.rmSync(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* orphan holds a handle */ }
	}
	restoreCursor();
	process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal] ?? 2));
}

/** Instances of this editor the harness did not start — they skew every run. */
function runningInstances(binary) {
	if (IS_LINUX) {
		let count = 0;
		for (const entry of fs.readdirSync('/proc')) {
			if (!/^\d+$/.test(entry)) { continue; }
			try { if (fs.realpathSync(`/proc/${entry}/exe`) === binary) { count++; } } catch { /* not ours to read */ }
		}
		return count;
	}
	const command = IS_MAC
		? ['ps', ['-axww', '-o', 'comm=']]
		: ['powershell', ['-NoProfile', '-Command',
			`(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq '${psLikeLiteral(binary)}' }).Count`]];
	try {
		const out = execFileSync(command[0], command[1], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
		return IS_MAC
			? out.split('\n').filter(line => line.trim() === binary).length
			: Number(out.trim()) || 0;
	} catch {
		return 0;
	}
}

function killTree(child) {
	if (child.pid === undefined) { return; }
	if (IS_WIN) {
		killPid(child.pid);
	} else {
		try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
		for (const pid of descendantPids(child.pid)) {
			try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
		}
	}
}

async function killEditor(child, launch) {
	killTree(child);
	// Verify the tree is really gone before the next run, then give the OS a
	// beat to release the profile's files.
	const survivors = await killByProfile(launch.needles);
	await sleep(1250);
	return survivors;
}

// ----------------------------------------------------------------------------
// measurement
// ----------------------------------------------------------------------------

/**
 * How often the ready file is read, and how often the window manager is asked
 * for its client list. Each is a floor on the resolution of whatever it feeds:
 * the ready poll is what times Zed (a read of a page-cached file, so it can
 * afford to be tight), the window look shells out to wmctrl and stays where it
 * was. The Code family's number is read out of the mark rather than off this
 * clock, so it is unaffected either way.
 */
const READY_POLL_MS = 10;
const WINDOW_POLL_MS = 20;

async function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForQuiet(maxLoad, timeoutMs, onWait) {
	if (IS_WIN) { return true; }	// Windows reports no load average
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const load = os.loadavg()[0];
		if (load <= maxLoad) { return true; }
		onWait?.(load);
		await sleep(2000);
	}
	return false;
}

/** Current length of a file, or 0 when it does not exist yet. */
function fileSize(file) {
	try { return fs.statSync(file).size; } catch { return 0; }
}

/**
 * Complete (newline-terminated) lines only: a mid-write read must not parse.
 * `fromByte` drops whatever the file already held when the launch began — a
 * family whose ready file is shared by every launch (Zed on macOS) starts
 * each run with the previous run's mark already sitting in it, and reading
 * that would report a startup that never happened.
 */
function completeLines(file, fromByte = 0) {
	let fd;
	try {
		fd = fs.openSync(file, 'r');
		const size = fs.fstatSync(fd).size;
		// A rotated log is shorter than the offset taken before it rotated.
		const start = size < fromByte ? 0 : fromByte;
		if (size <= start) { return []; }
		const buffer = Buffer.allocUnsafe(size - start);
		const read = fs.readSync(fd, buffer, 0, buffer.length, start);
		const content = buffer.toString('utf8', 0, read);
		const upToNewline = content.slice(0, content.lastIndexOf('\n') + 1);
		return upToNewline.split('\n').filter(Boolean);
	} catch {
		return [];
	} finally {
		if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
	}
}

function buildEnv(opts) {
	const env = { ...process.env };
	if (opts.forceX11 && IS_LINUX) {
		// Removed, not blanked: an empty WAYLAND_DISPLAY still reads as
		// "Wayland requested" to GTK, which fails instead of falling back.
		delete env.WAYLAND_DISPLAY;
		delete env.WAYLAND_SOCKET;
		env.XDG_SESSION_TYPE = 'x11';
		env.GDK_BACKEND = 'x11';
	}
	return env;
}

/**
 * The longest path below the state root that this batch will ask the kernel to
 * bind a socket at: the last launch of whichever editor makes the longest one,
 * plus the socket its family binds inside that launch's profile.
 */
function longestProfileSocketTail(available, launchesPerEditor) {
	let longest = 0;
	for (const editor of available) {
		const socket = familyOf(editor).profileSocket;
		if (!socket) { continue; }
		longest = Math.max(longest, path.join(editor.name, `launch-${launchesPerEditor}`, 'user-data', socket).length);
	}
	return longest ? longest + 1 : 0;		// + the separator under the root
}

/**
 * Where the throwaway profiles live. `os.tmpdir()` is the right answer and the
 * one the operator configured — right up until it is not: on macOS it is a
 * ~49-character per-user directory under /var/folders, which leaves a profile
 * path inside it with no room for the single-instance socket an editor binds
 * there, and an editor that cannot bind that socket does not start at all.
 * So a root the batch does not fit in is not accepted quietly: shorter
 * candidates are tried in turn, and the one that was passed over is reported
 * next to the one that was used. Candidates that fit but cannot be created
 * (an unwritable /tmp in a container) fall through to the ones that did not.
 */
function chooseStateRoot(socketTail) {
	const candidates = [{ parent: os.tmpdir(), prefix: 'akkento-ide-bench-' }];
	if (!IS_WIN) {
		candidates.push({ parent: '/tmp', prefix: 'akkento-ide-bench-' }, { parent: '/tmp', prefix: 'aib-' });
	}
	// mkdtemp replaces the six X's it appends, so the length is known up front.
	const fits = candidate => !socketTail
		|| path.join(candidate.parent, `${candidate.prefix}xxxxxx`).length + socketTail <= UNIX_SOCKET_MAX;
	const ordered = [...candidates.filter(fits), ...candidates.filter(candidate => !fits(candidate))];
	let lastError;
	for (const candidate of ordered) {
		try {
			return {
				dir: fs.mkdtempSync(path.join(candidate.parent, candidate.prefix)),
				// Nothing fits: the preflight check below says so with the real
				// numbers rather than this guessing at them.
				passedOver: candidate === candidates[0] || !fits(candidate) ? undefined : candidates[0].parent,
			};
		} catch (error) { lastError = error; }
	}
	throw lastError;
}

/**
 * State for a single launch: profile, extensions and timers file, none of
 * which any other launch has ever touched. Discarded again by
 * `discardProfile` once the tree is confirmed dead, so a 10-run batch does not
 * leave ten Chromium caches behind.
 */
function newLaunch(editor) {
	const family = familyOf(editor);
	editor.launchCount = (editor.launchCount ?? 0) + 1;
	const dir = path.join(editor.stateDir, `launch-${editor.launchCount}`);
	const launch = {
		dir,
		family,
		userDataDir: path.join(dir, 'user-data'),
		extensionsDir: path.join(dir, 'extensions'),
		// Outside `dir`: the profile is deleted after the run, the evidence of
		// what the editor reported is not.
		timersFile: path.join(editor.stateDir, `timers-${editor.launchCount}.txt`),
		outputFile: path.join(editor.stateDir, `output-${editor.launchCount}.txt`),
	};
	fs.mkdirSync(launch.userDataDir, { recursive: true });
	if (family.needsExtensionsDir) { fs.mkdirSync(launch.extensionsDir, { recursive: true }); }
	// Where the ready file already ends. Zero for a per-launch file, which is
	// every family but Zed on macOS; there it is everything the shared log
	// holds before this launch adds to it.
	launch.readyOffset = family.sharedReadyFile ? fileSize(family.readyFile(launch)) : 0;
	// Refined once the pid is known; the interrupt handler may need it before
	// then, and an empty sweep is worse than a coarse one.
	launch.needles = family.survivorNeedles(launch);
	return launch;
}

/** Best effort: a survivor still holding files is reported, not fought. */
function discardProfile(launch) {
	try {
		fs.rmSync(launch.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch { /* survivor holds a handle; the temp root goes at the end */ }
}

/**
 * The editor, launched. Its stdout and stderr go to a file beside the timers
 * file rather than to /dev/null: it costs the launch nothing measurable, the
 * same for every editor, and it is the difference between a failed row that
 * names its cause and one that can only guess at it — what an Electron main
 * process prints on its way out is usually the whole diagnosis.
 */
function spawnEditor(editor, launch, opts, phase) {
	const output = fs.openSync(launch.outputFile, 'a');
	try {
		const child = spawn(editor.binary, buildArgs(editor, launch, opts, phase), {
			detached: true,
			stdio: ['ignore', output, output],
			env: buildEnv(opts),
		});
		child.unref();
		return child;
	} finally {
		// The child holds its own duplicate of the descriptor from here.
		fs.closeSync(output);
	}
}

/** The last thing the editor said, short enough to sit in a report cell. */
function lastOutput(launch) {
	let content;
	try { content = fs.readFileSync(launch.outputFile, 'utf8'); } catch { return undefined; }
	const line = content.split('\n').map(one => one.trim()).filter(Boolean).pop();
	if (!line) { return undefined; }
	return redact(line.length > 200 ? `${line.slice(0, 200)}…` : line);
}

function buildArgs(editor, launch, opts, phase) {
	const args = [
		...familyOf(editor).launchArgs(launch, opts, phase),
		...(editor.extraArgs ?? []),
	];
	// The workload phase opens its own repository, and a file inside it unless
	// told not to: an editor with work loaded is the whole subject of that
	// phase, and it is a different launch from the empty window the others
	// time. Both families take the same positional form — directory first,
	// then the file to put on screen.
	if (phase === 'workload' && opts.workloadTarget) {
		args.push(opts.workloadTarget.folder);
		if (opts.workloadTarget.open) { args.push(opts.workloadTarget.open); }
	} else if (opts.folder) {
		args.push(opts.folder);
	}
	return args;
}

/**
 * The ready mark, if this launch has written it yet, plus whatever the family
 * could read alongside it. One file read per poll: the file is this launch's
 * own, so anything complete in it is ours — no line-count bookkeeping, no way
 * to read a neighbouring run's number or a line half-written by a process we
 * killed mid-append.
 */
function readReadyMark(editor, launch) {
	const family = familyOf(editor);
	const lines = completeLines(family.readyFile(launch), launch.readyOffset);
	if (!lines.length) { return undefined; }
	// Zed carries its build in the same log; a version preflight could not
	// reach fills itself in here rather than shipping a report with a blank.
	if (family.versionFromLines && editor.version?.startsWith('unknown')) {
		editor.version = family.versionFromLines(lines) ?? editor.version;
	}
	return family.readyFrom(lines);
}

async function runOnce(editor, opts, kind, onStatus) {
	const launch = newLaunch(editor);
	const knownWindows = opts.window ? (clientWindows() ?? new Set()) : undefined;

	onStatus?.('launching');
	const child = spawnEditor(editor, launch, opts, 'startup');
	launch.needles = launch.family.survivorNeedles(launch, child.pid);
	inFlight = { child, editor, launch };
	let spawnError;
	let exited;
	child.on('error', error => { spawnError = error; });
	child.on('exit', (code, signal) => { exited = signal ? `signal ${signal}` : `code ${code}`; });
	const t0 = Date.now();
	onStatus?.('waiting for the editor to report ready');

	const family = familyOf(editor);
	// markSeenMs is diagnostic, not a startup time: for the Code family the
	// editor sits on the mark for 15 seconds before writing it, on purpose.
	const sample = { kind, startup: undefined, timers: undefined, markSeenMs: undefined, window: undefined, note: undefined };
	const deadline = t0 + opts.timeoutMs;
	let lastWindowLook = 0;

	while (Date.now() < deadline && !spawnError) {
		if (sample.markSeenMs === undefined) {
			const mark = readReadyMark(editor, launch);
			if (mark) {
				sample.markSeenMs = Date.now() - t0;
				sample.timers = mark.timers;
				sample.startup = family.startupFrom(mark, sample.markSeenMs);
				onStatus?.(opts.window ? 'ready — waiting for the window manager' : 'ready');
			}
		}

		if (opts.window && sample.window === undefined && Date.now() - lastWindowLook >= WINDOW_POLL_MS) {
			lastWindowLook = Date.now();
			const now = clientWindows();
			if (now) {
				const pids = descendantPids(child.pid);
				for (const id of now) {
					if (knownWindows.has(id)) { continue; }
					const pid = windowPid(id);
					if (pid !== undefined && pids.has(pid)) {
						sample.window = Date.now() - t0;
						break;
					}
				}
			}
		}

		if (sample.markSeenMs !== undefined && (!opts.window || sample.window !== undefined)) { break; }
		// An editor that exited without reporting ready is a dead end, not a
		// slow start: waiting out the timeout would cost minutes per batch and
		// learn nothing the exit has not already said.
		if (exited !== undefined && sample.markSeenMs === undefined) { break; }
		await sleep(READY_POLL_MS);
	}

	if (spawnError) {
		sample.note = spawnFailureNote(editor, spawnError);
	} else if (sample.markSeenMs === undefined && (!opts.window || sample.window === undefined)) {
		// As before: a launch that produced *something* is not marked. A window
		// with no ready mark still measures the window; a ready mark with no
		// window (a Wayland session, say) still measures the ready mark.
		sample.note = notReadyNote(editor, launch, opts, exited);
	}

	sample.load = IS_WIN ? null : Number(os.loadavg()[0].toFixed(2));
	onStatus?.('shutting the editor down');
	const survivors = await killEditor(child, launch);
	inFlight = undefined;
	sample.note = withSurvivors(sample.note, editor, survivors);
	onStatus?.('discarding the throwaway profile');
	discardProfile(launch);
	return sample;
}

/**
 * A process that outlived its kill is not a footnote: it holds RAM and CPU
 * against every run after it, so the row it came from is marked (excluding it
 * from the statistics) and the operator is told at the console.
 */
function withSurvivors(note, editor, survivors) {
	if (!survivors.length) { return note; }
	ui.log(`  ${c.yellow(G.warn)} ${c.bold(editor.name)} left ${survivors.length} process(es) alive after kill (pid ${survivors.join(', ')})`);
	ui.log(`    ${c.grey('they compete with every run that follows — kill them and rerun')}`);
	return [note, `SURVIVORS ${survivors.join(',')}`].filter(Boolean).join(' ');
}

/** The OS error, verbatim, plus what it means here — a bare tag debugs nothing. */
function spawnFailureNote(editor, error) {
	const detail = [error.code, error.message].filter(Boolean).join(': ');
	return `SPAWN-FAILED ${detail} [${redact(editor.binary)}]`;
}

/**
 * A launch that produced no number is only actionable with the state that
 * produced it: whether the editor wrote anything at all, and whether it was
 * even still running. "It was gone and it wrote nothing" is a handoff or an
 * early exit; "still running, nothing written" is a genuinely slow or stuck
 * start. The family gets to add what its own dead ends look like.
 */
function notReadyNote(editor, launch, opts, exited) {
	const family = familyOf(editor);
	const seconds = Math.round(opts.timeoutMs / 1000);
	const wrote = completeLines(family.readyFile(launch), launch.readyOffset).length;
	const alive = pidsUsingProfile(launch.needles).length;
	if (exited !== undefined) {
		const said = lastOutput(launch);
		return `EXITED (${exited}) before reporting ready — ${family.exitHint
			?? 'the process the harness held was not the one that would have been measured: a CLI wrapper handing off to a detached process, or a handoff to an instance that was already running'}`
			+ (said ? `; it printed: ${said}` : '');
	}
	if (wrote > 0 && family.reportsTimers) { return `TIMEOUT (timers line unparseable; ${alive} process(es) alive)`; }
	if (wrote > 0) { return `TIMEOUT (no "${family.readyMark}" in ${seconds}s, though the editor was writing; ${alive} process(es) alive)`; }
	return alive === 0
		? `TIMEOUT (no ready mark in ${seconds}s and nothing left running — the launched process exited without reporting ready: a CLI wrapper handing off to a detached process, or a handoff to another instance)`
		: `TIMEOUT (no ready mark in ${seconds}s; ${alive} process(es) still running — ${family.timeoutHint ?? `the editor started but never reached ${family.readyMark}`})`;
}

/**
 * Idle memory of a process tree. The honest metric differs per OS and the
 * result is labeled accordingly — never compare across operating systems:
 *   linux    summed PSS from smaps_rollup (shared pages divided among sharers)
 *   darwin   summed RSS from ps (overcounts shared pages; macOS exposes no
 *            cheap PSS equivalent — within-batch comparisons remain fair
 *            since every editor is overcounted the same way)
 *   windows  summed private working set (WorkingSetPrivate via CIM perf data)
 */
const MEMORY_METRIC = IS_LINUX ? 'pss-sum' : IS_MAC ? 'rss-sum' : 'private-working-set-sum';

const MEMORY_METRIC_LABEL = IS_LINUX
	? 'summed PSS (proportional set size)'
	: IS_MAC ? 'summed RSS (resident set size; shared pages counted per process)'
		: 'summed private working set';

/**
 * Clock ticks per second: what /proc counts CPU time in. It is 100 on every
 * desktop Linux we have seen, and it is asked for rather than assumed because
 * a wrong constant here would not fail — it would silently scale every CPU
 * number in the report.
 */
const CLOCK_TICKS = (IS_LINUX && Number(sh('getconf', ['CLK_TCK']))) || 100;

/**
 * One walk of a process tree: what it has resident now, and how much CPU each
 * of its processes has burned since it started. Both come out of the same pid
 * set in the same pass — walking twice would describe two different trees,
 * because an editor spawns and reaps helpers continuously.
 *
 * CPU is returned per pid rather than summed, so a caller sampling over time
 * can keep the last value it saw for a process that has since exited. Summing
 * live processes only would make a tree that finished indexing and shut its
 * helpers down look like it had un-burned the CPU they spent.
 */
function sampleTree(rootPid) {
	const pids = descendantPids(rootPid);
	let total = 0;
	let processes = 0;
	const cpu = new Map();
	if (IS_LINUX) {
		for (const pid of pids) {
			try {
				const rollup = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
				const match = rollup.match(/^Pss:\s+(\d+) kB/m);
				if (match) {
					total += Number(match[1]) * 1024;
					processes++;
				}
			} catch { continue; /* raced with exit */ }
			try {
				// Past the comm field, which is parenthesised and may itself
				// contain spaces and brackets: utime is field 14, stime 15.
				const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
				const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
				const ticks = Number(fields[11]) + Number(fields[12]);
				if (Number.isFinite(ticks)) { cpu.set(pid, ticks / CLOCK_TICKS); }
			} catch { /* raced with exit */ }
		}
		return { bytes: total, processes, cpu };
	}
	if (IS_MAC) {
		try {
			const out = execFileSync('ps', ['-axo', 'pid=,rss=,time='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
			for (const line of out.split('\n')) {
				const [pidText, rssText, timeText] = line.trim().split(/\s+/);
				const pid = Number(pidText);
				const rssKb = Number(rssText);
				if (!pids.has(pid) || !Number.isFinite(rssKb)) { continue; }
				total += rssKb * 1024;
				processes++;
				const seconds = parseCpuClock(timeText);
				if (seconds !== undefined) { cpu.set(pid, seconds); }
			}
		} catch { /* best effort */ }
		return { bytes: total, processes, cpu };
	}
	try {
		const list = [...pids].join(',');
		const out = execFileSync('powershell', ['-NoProfile', '-Command',
			`$pids=@(${list}); Get-CimInstance Win32_PerfRawData_PerfProc_Process | Where-Object { $pids -contains $_.IDProcess } | ForEach-Object { "$($_.IDProcess) $($_.WorkingSetPrivate) $($_.PercentProcessorTime)" }`],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		for (const line of out.split('\n')) {
			const [pid, bytes, busy100ns] = line.trim().split(/\s+/).map(Number);
			if (!Number.isFinite(bytes)) { continue; }
			total += bytes;
			processes++;
			// In the *raw* performance class this field is not a percentage:
			// it is the cumulative busy time of the process, in 100ns units.
			if (Number.isFinite(busy100ns)) { cpu.set(pid, busy100ns / 1e7); }
		}
	} catch { /* best effort */ }
	return { bytes: total, processes, cpu };
}

/** `ps` cumulative CPU time: [dd-]hh:mm:ss[.ff], or mm:ss.ff, as macOS prints. */
function parseCpuClock(text) {
	if (!text) { return undefined; }
	const [days, rest] = text.includes('-') ? text.split('-') : ['0', text];
	const parts = rest.split(':').map(Number);
	if (!parts.length || parts.some(part => !Number.isFinite(part))) { return undefined; }
	return Number(days) * 86_400 + parts.reduce((carried, part) => carried * 60 + part, 0);
}

function treeMemoryBytes(rootPid) {
	const { bytes, processes } = sampleTree(rootPid);
	return { bytes, processes };
}

/**
 * Memory is sampled on a fixed stretch of wall clock from launch, not on a
 * ready mark, and the reason is the ready mark itself: the flag that produces
 * one for the Code family also makes the editor exit a few seconds after
 * writing it, so a settle measured from *there* would sample a process tree
 * that had already gone — silently, as zero. Nothing here asks the editor for
 * anything. Every editor is given the same seconds to start and go idle in and
 * is sampled at the end of them, which is also the only definition of this
 * metric that means the same thing across two architectures.
 */
async function runMemoryOnce(editor, opts, onStatus) {
	const launch = newLaunch(editor);
	onStatus?.('launching');
	const child = spawnEditor(editor, launch, opts, 'memory');
	launch.needles = launch.family.survivorNeedles(launch, child.pid);
	inFlight = { child, editor, launch };
	let spawnError;
	let exited;
	child.on('error', error => { spawnError = error; });
	child.on('exit', (code, signal) => { exited = signal ? `signal ${signal}` : `code ${code}`; });

	const sampleAt = Date.now() + opts.memorySettleMs;
	while (Date.now() < sampleAt && !spawnError && exited === undefined) {
		onStatus?.(`settling ${Math.ceil((sampleAt - Date.now()) / 1000)}s before sampling`);
		await sleep(250);
	}

	let sample;
	if (spawnError || exited !== undefined) {
		const said = lastOutput(launch);
		sample = {
			pssMB: undefined,
			processes: undefined,
			note: spawnError
				? spawnFailureNote(editor, spawnError)
				: `EXITED (${exited}) before the memory sample — ${familyOf(editor).exitHint
					?? 'the editor did not stay up long enough to be measured idle'}`
					+ (said ? `; it printed: ${said}` : ''),
		};
	} else {
		onStatus?.('sampling the process tree');
		const memory = treeMemoryBytes(child.pid);
		// Zero processes is not zero memory: it is a launch that was not there
		// to measure, and it must never be averaged in as a very good result.
		sample = memory.processes > 0
			? { pssMB: Number((memory.bytes / 1048576).toFixed(1)), processes: memory.processes }
			: { pssMB: undefined, processes: 0, note: 'NO-PROCESSES (nothing in the process tree when it was sampled — the editor never started, or was gone by then)' };
	}

	onStatus?.('shutting the editor down');
	const survivors = await killEditor(child, launch);
	inFlight = undefined;
	sample.note = withSurvivors(sample.note, editor, survivors);
	discardProfile(launch);
	return sample;
}

// ----------------------------------------------------------------------------
// the workload corpus
//
// The workload phase needs a repository to open, and "point it at yours" is a
// number nobody else can reproduce. So the default repository is one this file
// generates: a fixed seed, no clock and no randomness, which makes it identical
// byte for byte on every machine that generates it at this corpus version — and
// it is fingerprinted into the report, so two results can be checked for having
// been measured against the same thing rather than assumed to have been.
//
// It is not real code and does not pretend to be. What it is, is real *work*:
// thousands of TypeScript modules that import each other across directories,
// which is what makes an editor walk a file tree, populate a search index and
// start a language server. `--workload-folder` swaps in an actual repository
// for anyone who would rather measure one, at the cost of a number that only
// somebody with that same checkout can reproduce.
// ----------------------------------------------------------------------------

/**
 * Named for what they contain, because the name ends up in someone's blog post
 * and "medium" tells a reader nothing. `ts-2.5k` is 2,500 TypeScript modules,
 * and it is quotable next to the fingerprint: the pair identifies a repository
 * exactly, the way `react-1k` does in the bundler benchmarks.
 */
const CORPUS_SIZES = { 'ts-500': 500, 'ts-2.5k': 2_500, 'ts-10k': 10_000 };
/** The old names still work; the canonical one is what gets recorded. */
const CORPUS_ALIASES = { small: 'ts-500', medium: 'ts-2.5k', large: 'ts-10k' };
const CORPUS_PACKAGE_SIZE = 25;
const CORPUS_ENTRY = 'src/main.ts';
/** Bumped whenever the generated bytes change: a fingerprint is only useful against a stated version. */
const CORPUS_VERSION = 3;

/**
 * Deterministic pseudo-randomness. `Math.random()` would make the corpus a
 * different repository on every machine, and a benchmark whose input differs
 * per machine measures the input.
 */
function seededRandom(seed) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

const CORPUS_FIELDS = [
	{ type: 'string', value: index => `'field-${index}'` },
	{ type: 'number', value: index => String((index * 37) % 1009) },
	{ type: 'boolean', value: index => (index % 2 === 0 ? 'true' : 'false') },
	{ type: 'string[]', value: index => `['a-${index}', 'b-${index}', 'c-${index}']` },
	{ type: 'Record<string, number>', value: index => `{ count: ${index}, weight: ${index % 13} }` },
	{ type: 'Map<string, number>', value: index => `new Map([['seed', ${index}]])` },
];

const corpusPackage = index => Math.floor(index / CORPUS_PACKAGE_SIZE);

/** One module: an interface, its defaults, a class over them, and a function that pulls in its imports. */
function corpusModule(index, random) {
	const pkg = corpusPackage(index);
	const imports = [];
	for (let attempt = 0; attempt < 3 && index > 0; attempt++) {
		const target = Math.floor(random() * index);
		if (target !== index && !imports.includes(target)) { imports.push(target); }
	}
	const fields = Array.from({ length: 3 + Math.floor(random() * 6) }, (_, field) => ({
		name: `field${field}`,
		...CORPUS_FIELDS[Math.floor(random() * CORPUS_FIELDS.length)],
	}));
	const methods = 2 + Math.floor(random() * 5);
	const importPath = target => (corpusPackage(target) === pkg ? '.' : `../pkg-${corpusPackage(target)}`) + `/module-${target}`;

	const lines = [
		`// module ${index} — generated by akkento-ide-bench. Deterministic, and deliberately meaningless.`,
		...imports.map(target => `import { Shape${target}, defaults${target}, compute${target} } from '${importPath(target)}';`),
		imports.length ? '' : undefined,
		`export interface Shape${index} {`,
		...fields.map(field => `\treadonly ${field.name}: ${field.type};`),
		'}',
		'',
		`export const defaults${index}: Shape${index} = {`,
		...fields.map(field => `\t${field.name}: ${field.value(index)},`),
		'};',
		'',
		`export class Service${index} {`,
		`\tprivate readonly cache = new Map<string, Shape${index}>();`,
		'',
		`\tconstructor(private readonly seed: Shape${index} = defaults${index}) {}`,
		'',
		...Array.from({ length: methods }, (_, method) => [
			`\tresolve${method}(key: string): Shape${index} {`,
			`\t\tconst existing = this.cache.get(key);`,
			`\t\tif (existing) { return existing; }`,
			`\t\tconst made: Shape${index} = { ...this.seed };`,
			`\t\tthis.cache.set(key, made);`,
			`\t\treturn made;`,
			'\t}',
			'',
		]).flat(),
		`\tsize(): number { return this.cache.size; }`,
		'}',
		'',
		`export function compute${index}(input: Shape${index} = defaults${index}): number {`,
		`\tconst weights = Object.keys(input).map(key => key.length);`,
		`\tconst own = weights.reduce((carried, weight) => carried + weight, ${index % 97});`,
		imports.length
			? `\treturn own + ${imports.map(target => `compute${target}(defaults${target})`).join(' + ')};`
			: '\treturn own;',
		'}',
		'',
	];
	return lines.filter(line => line !== undefined).join('\n');
}

function corpusBarrel(pkg, members) {
	return [
		`// pkg-${pkg} — generated by akkento-ide-bench`,
		...members.map(index => `export * from './module-${index}';`),
		'',
	].join('\n');
}

function corpusEntry(count) {
	const sampled = [];
	for (let index = 0; index < count && sampled.length < 40; index += Math.max(1, Math.floor(count / 40))) {
		sampled.push(index);
	}
	return [
		'// entry point — generated by akkento-ide-bench',
		...sampled.map(index => `import { compute${index}, Service${index} } from './pkg-${corpusPackage(index)}/module-${index}';`),
		'',
		'export function main(): number {',
		'\tconst services = [',
		...sampled.map(index => `\t\tnew Service${index}(),`),
		'\t];',
		'\tconst total = [',
		...sampled.map(index => `\t\tcompute${index}(),`),
		'\t].reduce((carried, value) => carried + value, 0);',
		'\treturn total + services.reduce((carried, service) => carried + service.size(), 0);',
		'}',
		'',
		'main();',
		'',
	].join('\n');
}

/** Best effort, and reported as such: an editor with git present does SCM work a bare directory never asks it for. */
function git(args, cwd) {
	try {
		execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] });
		return true;
	} catch {
		return false;
	}
}

/**
 * Generate the corpus and commit it. The commit matters as much as the files:
 * every editor here ships source control, and an uncommitted tree of 2,500 new
 * files is a workload no real repository presents — it would measure each
 * editor's "everything is untracked" path instead of its everyday one.
 */
function buildCorpus(dir, sizeName, onStatus) {
	const modules = CORPUS_SIZES[sizeName];
	const random = seededRandom(0x5eed);
	const hash = createHash('sha256');
	let bytes = 0;
	let files = 0;

	const write = (relative, content) => {
		const target = path.join(dir, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
		hash.update(`${relative}\0${content}`);
		bytes += Buffer.byteLength(content);
		files++;
	};

	write('package.json', JSON.stringify({
		name: 'akkento-ide-bench-corpus',
		version: `1.0.${CORPUS_VERSION}`,
		private: true,
		description: `generated workload corpus (${sizeName}, ${modules} modules) — not real code`,
		type: 'module',
	}, null, 2) + '\n');
	write('tsconfig.json', JSON.stringify({
		compilerOptions: {
			target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler',
			strict: true, noEmit: true, skipLibCheck: true,
		},
		include: ['src'],
	}, null, 2) + '\n');
	write('.gitignore', 'node_modules\n');
	write('README.md', [
		'# akkento-ide-bench workload corpus', '',
		`Generated by akkento-ide-bench, corpus version ${CORPUS_VERSION}, size \`${sizeName}\` (${modules} modules).`,
		'',
		'Deterministic: the same seed produces the same bytes on every machine, which is',
		'the only way two people can compare what their editors did with it. It is not',
		'real code — it is a real amount of code.', '',
	].join('\n'));

	const packages = new Map();
	for (let index = 0; index < modules; index++) {
		if (index % 250 === 0) { onStatus?.(`generating the corpus… ${index}/${modules} modules`); }
		const pkg = corpusPackage(index);
		if (!packages.has(pkg)) { packages.set(pkg, []); }
		packages.get(pkg).push(index);
		write(path.posix.join('src', `pkg-${pkg}`, `module-${index}.ts`), corpusModule(index, random));
	}
	for (const [pkg, members] of packages) {
		write(path.posix.join('src', `pkg-${pkg}`, 'index.ts'), corpusBarrel(pkg, members));
	}
	write(CORPUS_ENTRY, corpusEntry(modules));

	onStatus?.('committing the corpus…');
	const committed = git(['init', '-q', '-b', 'main'], dir)
		&& git(['add', '-A'], dir)
		&& git(['-c', 'user.name=akkento-ide-bench', '-c', 'user.email=bench@localhost',
			'commit', '-q', '--no-gpg-sign', '-m', 'corpus'], dir);

	return {
		dir,
		generated: true,
		size: sizeName,
		modules,
		files,
		bytes,
		corpusVersion: CORPUS_VERSION,
		digest: hash.digest('hex').slice(0, 16),
		git: committed,
	};
}

/** Count of modified/untracked paths, or undefined where git cannot answer. */
function dirtyCount(folder) {
	try {
		const out = execFileSync('git', ['status', '--porcelain'], { cwd: folder, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
		return out.split('\n').filter(Boolean).length;
	} catch {
		return undefined;
	}
}

/**
 * Put the generated corpus back exactly as it was committed. Editors write
 * into a workspace — caches, indexes, an occasional settings file — and run 2
 * of an editor must not open a repository that run 1 left different from the
 * one every other editor was given. Only ever the generated corpus: a folder
 * the operator pointed us at is theirs, and this tool does not reset it.
 */
function restoreCorpus(corpus) {
	if (!corpus?.generated || !corpus.git) { return; }
	git(['reset', '--hard', '-q'], corpus.dir);
	git(['clean', '-qfdx', '-e', '.gitignore'], corpus.dir);
}

// ----------------------------------------------------------------------------
// the workload phase
// ----------------------------------------------------------------------------

/**
 * Everything a single workload run reports, derived from its samples.
 *
 *   steady   the median of the last third of the window. Not the last sample:
 *            one sample is a sample, and editors garbage-collect on their own
 *            schedule, so the final reading can be several per cent either way
 *   peak     the largest sample. An editor that spends 90 seconds at 2 GB and
 *            settles at 700 MB has still asked the machine for 2 GB, and on a
 *            16 GB laptop with a browser open that is the number that hurts
 *   settle   the first sample after which every later sample stays inside the
 *            steady band — how long the editor keeps working after its window
 *            is up. Undefined when it never stopped: reported as such, never
 *            as a small number
 *   cpu      total CPU seconds burned by the whole tree over the window, the
 *            cost of opening this repository at all
 *   idleCpu  CPU over the last third only, as a share of one core: what the
 *            editor costs while nobody is touching it
 */
function summariseWorkload(samples, opts) {
	const live = samples.filter(sample => sample.processes > 0 && sample.mb > 0);
	if (live.length < 3) {
		return { samples, note: 'TOO-FEW-SAMPLES (the process tree was empty or unreadable for most of the window — the editor never really started, or was gone before it ended)' };
	}
	const tailFrom = opts.workloadWindowMs * (2 / 3);
	const tail = live.filter(sample => sample.atMs >= tailFrom);
	const settled = tail.length >= 3 ? tail : live.slice(-3);
	const steadyMB = stats(settled.map(sample => sample.mb)).median;
	const peakMB = Math.max(...live.map(sample => sample.mb));
	// 5%, with a floor: on a 200 MB editor 5% is 10 MB, and below that the
	// band would be chasing ordinary allocator noise rather than measuring it.
	const band = Math.max(steadyMB * 0.05, 5);
	let settleMs;
	for (const [index, sample] of live.entries()) {
		if (live.slice(index).every(later => Math.abs(later.mb - steadyMB) <= band)) {
			settleMs = sample.atMs;
			break;
		}
	}
	const first = settled[0];
	const last = live[live.length - 1];
	const idleSeconds = (last.atMs - first.atMs) / 1000;
	return {
		steadyMB: Number(steadyMB.toFixed(1)),
		peakMB: Number(peakMB.toFixed(1)),
		settleMs,
		stillGrowing: settleMs === undefined,
		cpuSeconds: Number(last.cpuSeconds.toFixed(1)),
		idleCpuPercent: idleSeconds > 0
			? Number((((last.cpuSeconds - first.cpuSeconds) / idleSeconds) * 100).toFixed(1))
			: undefined,
		processes: last.processes,
		samples,
	};
}

/**
 * One workload run: the editor is launched onto a repository and then left
 * completely alone, while the harness walks its process tree every
 * --workload-sample for --workload-window.
 *
 * Nothing waits for a ready mark, for the same reason the memory phase does
 * not — plus one that applies only here. What this phase is about is the work
 * an editor does *after* its window appears: walking the tree, building its
 * search index, starting a language server, and whatever its extensions do on
 * a workspace being opened. A clock that started at "ready" would start after
 * the interesting part had already begun.
 *
 * Every editor gets the same repository, the same seconds, and the same walk.
 */
async function runWorkloadOnce(editor, opts, onStatus) {
	const launch = newLaunch(editor);
	onStatus?.('launching');
	const child = spawnEditor(editor, launch, opts, 'workload');
	launch.needles = launch.family.survivorNeedles(launch, child.pid);
	inFlight = { child, editor, launch };
	let spawnError;
	let exited;
	child.on('error', error => { spawnError = error; });
	child.on('exit', (code, signal) => { exited = signal ? `signal ${signal}` : `code ${code}`; });

	const started = Date.now();
	const totalSamples = Math.floor(opts.workloadWindowMs / opts.workloadSampleMs);
	// Per pid, the most CPU that pid was ever seen to have used. Summing only
	// the processes alive at the final sample would credit an editor for
	// shutting its indexer down — the CPU it burned was still burned.
	const cpuHighWater = new Map();
	const samples = [];

	for (let index = 1; index <= totalSamples; index++) {
		const sampleAt = started + index * opts.workloadSampleMs;
		while (Date.now() < sampleAt && !spawnError && exited === undefined) {
			await sleep(Math.min(250, Math.max(1, sampleAt - Date.now())));
		}
		if (spawnError || exited !== undefined) { break; }

		const tree = sampleTree(child.pid);
		for (const [pid, seconds] of tree.cpu) {
			cpuHighWater.set(pid, Math.max(cpuHighWater.get(pid) ?? 0, seconds));
		}
		let cpuSeconds = 0;
		for (const seconds of cpuHighWater.values()) { cpuSeconds += seconds; }
		const mb = Number((tree.bytes / 1048576).toFixed(1));
		samples.push({
			atMs: Date.now() - started,
			mb,
			processes: tree.processes,
			cpuSeconds: Number(cpuSeconds.toFixed(2)),
		});
		onStatus?.(`working — sample ${index}/${totalSamples} ${c.grey('·')} ${fmtMB(mb)} ${c.grey('·')} ${tree.processes} process(es)`);
	}

	let sample;
	if (spawnError || exited !== undefined) {
		const said = lastOutput(launch);
		sample = {
			samples,
			note: spawnError
				? spawnFailureNote(editor, spawnError)
				: `EXITED (${exited}) ${samples.length ? `after ${Math.round((samples[samples.length - 1].atMs) / 1000)}s of the window` : 'before the first sample'} — ${familyOf(editor).exitHint
					?? 'the editor did not stay up long enough to be measured working'}`
					+ (said ? `; it printed: ${said}` : ''),
		};
	} else {
		sample = summariseWorkload(samples, opts);
	}

	sample.load = IS_WIN ? null : Number(os.loadavg()[0].toFixed(2));
	onStatus?.('shutting the editor down');
	const survivors = await killEditor(child, launch);
	inFlight = undefined;
	sample.note = withSurvivors(sample.note, editor, survivors);

	// What the editor left in the workspace. The generated corpus is put back;
	// a repository the operator supplied is only ever reported on.
	const corpus = opts.workloadTarget?.corpus;
	if (corpus?.generated) {
		restoreCorpus(corpus);
	} else if (corpus?.dirtyAtStart !== undefined) {
		const now = dirtyCount(corpus.dir);
		if (now !== undefined && now !== corpus.dirtyAtStart) {
			sample.wroteIntoWorkspace = now - corpus.dirtyAtStart;
		}
	}

	discardProfile(launch);
	return sample;
}

// ----------------------------------------------------------------------------
// statistics
// ----------------------------------------------------------------------------

function stats(values) {
	if (!values.length) { return undefined; }
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
	const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length;
	return {
		n: sorted.length,
		median,
		mean: Number(mean.toFixed(1)),
		stddev: Number(Math.sqrt(variance).toFixed(1)),
		min: sorted[0],
		max: sorted[sorted.length - 1],
	};
}

/**
 * Mann-Whitney U, two-sided, normal approximation with tie correction and
 * continuity correction. Adequate at n >= 8 per side; below that the p value
 * is indicative only (flagged in the report notes).
 */
function mannWhitney(a, b) {
	if (a.length < 3 || b.length < 3) { return undefined; }
	const all = [...a.map(v => ({ v, g: 0 })), ...b.map(v => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
	const ranks = new Array(all.length);
	for (let i = 0; i < all.length;) {
		let j = i;
		while (j + 1 < all.length && all[j + 1].v === all[i].v) { j++; }
		const rank = (i + j + 2) / 2;
		for (let k = i; k <= j; k++) { ranks[k] = rank; }
		i = j + 1;
	}
	let rankSumA = 0;
	for (let i = 0; i < all.length; i++) { if (all[i].g === 0) { rankSumA += ranks[i]; } }
	const n1 = a.length, n2 = b.length;
	const u1 = rankSumA - (n1 * (n1 + 1)) / 2;
	const u = Math.min(u1, n1 * n2 - u1);
	const tieCounts = new Map();
	for (const { v } of all) { tieCounts.set(v, (tieCounts.get(v) ?? 0) + 1); }
	let tieTerm = 0;
	for (const t of tieCounts.values()) { tieTerm += t ** 3 - t; }
	const n = n1 + n2;
	const sigma = Math.sqrt((n1 * n2 / 12) * ((n + 1) - tieTerm / (n * (n - 1))));
	if (sigma === 0) { return { u, z: 0, p: 1 }; }
	const z = Math.max(0, Math.abs(u1 - (n1 * n2) / 2) - 0.5) / sigma;
	const p = Math.min(1, erfc(z / Math.SQRT2));
	return { u, z: Number(z.toFixed(2)), p: Number(p.toPrecision(2)) };
}

function erfc(x) {
	// Abramowitz & Stegun 7.1.26; |error| <= 1.5e-7
	const t = 1 / (1 + 0.3275911 * x);
	const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
	return poly * Math.exp(-x * x);
}

// ----------------------------------------------------------------------------
// report
// ----------------------------------------------------------------------------

function timestampSlug(date) {
	return date.toISOString().replace(/\.\d+Z$/, '').replace(/[:]/g, '-');
}

function hostRows(host) {
	const rows = [
		['Operating system', host.distro ?? host.os],
		['Build', host.build],
		['Kernel', host.kernel],
		['Architecture', `${host.arch}${host.rosetta ? ' (running under Rosetta)' : ''}`],
		['Machine model', host.model],
		['CPU', host.cpu],
		['Logical cores', host.cores],
		['Physical cores', host.physicalCores],
		['Performance / efficiency cores', host.performanceCores !== undefined
			? `${host.performanceCores} P / ${host.efficiencyCores ?? 0} E` : undefined],
		['CPU clock', host.maxClockMHz ? `${host.maxClockMHz} MHz` : host.cpuSpeedMHz ? `${host.cpuSpeedMHz} MHz` : undefined],
		['CPU governor', host.cpuGovernor && `${host.cpuGovernor}${host.cpuScalingDriver ? ` (${host.cpuScalingDriver})` : ''}`],
		['CPU thermal limit', host.cpuSpeedLimit !== undefined ? `${host.cpuSpeedLimit}%` : undefined],
		['GPU', host.gpu?.join(', ')],
		['Memory', `${host.ramGB} GB total, ${host.freeRamGB} GB free`],
		['Swap', host.swapGB !== undefined ? `${host.swapGB} GB` : undefined],
		['Power', host.powerSource
			? `${host.powerSource === 'ac' ? 'AC' : 'battery'}${host.batteryPercent !== undefined ? ` (${host.batteryPercent}%)` : ''}${host.lowPowerMode ? ', Low Power Mode ON' : ''}`
			: undefined],
		['Power plan', host.powerPlan],
		['Session', [host.desktop, host.sessionType, host.displayServer].filter(Boolean).join(' / ')],
		['Uptime', `${host.uptimeHours} h`],
		['Node', `${host.node} (V8 ${host.v8})`],
		['Temp filesystem', host.tempFilesystem],
	];
	return rows.filter(([, value]) => value !== undefined && value !== null && value !== '');
}

function markdownReport(payload) {
	const { host, options, editors, results, startedAt, durationMs, warnings } = payload;
	const lines = [];
	const push = (...items) => lines.push(...items);

	push(`# akkento-ide-bench report`, '');
	push(`Generated by akkento-ide-bench ${payload.tool.version} on ${startedAt}.`, '');
	push(`Total batch time: ${fmtDuration(durationMs)}.`, '');

	push('## Machine', '');
	push('| | |', '| --- | --- |');
	for (const [label, value] of hostRows(host)) { push(`| **${label}** | ${value} |`); }
	push('');

	if (warnings.length) {
		push('> [!WARNING]', '> Conditions during this run that affect the numbers:', '>');
		for (const warning of warnings) { push(`> - ${warning}`); }
		push('');
	}

	push('## Editors measured', '');
	push('| Editor | Version | Ready mark | Binary |', '| --- | --- | --- | --- |');
	for (const editor of editors) {
		push(`| ${editor.name} | ${editor.version} | ${editor.readyMark ?? ''} | \`${editor.binary}\` |`);
	}
	push('');

	push('## Settings', '');
	push('| | |', '| --- | --- |');
	push(`| Measured runs per editor | ${options.runs} |`);
	push(`| Warmup runs per editor | ${options.warmups} |`);
	push(`| Load gate | ${options.maxLoad} |`);
	push(`| Window signal | ${options.window ? 'on' : 'off'} |`);
	push(`| Workspace | ${options.folder ?? 'empty window'} |`);
	push(`| Memory phase | ${options.memory ? `${options.memoryRuns} runs, sampled ${Math.round(options.memorySampledAfterMs / 1000)}s after launch` : 'off'} |`);
	push(`| Workload phase | ${options.workload ? `${options.workloadRuns} runs, ${Math.round(options.workloadWindowMs / 1000)}s each, sampled every ${Math.round(options.workloadSampleMs / 1000)}s` : 'off'} |`);
	if (options.workload) {
		push(`| Workload repository | ${options.workloadCorpus
			? `generated corpus (${options.workloadCorpus.size}: ${options.workloadCorpus.modules} modules, ${options.workloadCorpus.files} files, ${(options.workloadCorpus.bytes / 1048576).toFixed(1)} MB, fingerprint \`${options.workloadCorpus.digest}\`, corpus v${options.workloadCorpus.corpusVersion}${options.workloadCorpus.git ? ', committed to git' : ', NOT a git repository — git was unavailable'})`
			: options.workloadFolder} |`);
		push(`| Workload file opened | ${options.workloadOpen ?? 'none — the folder only'} |`);
	}
	push('');

	const headings = {
		startup: 'startup — time to the editor reporting its own shell is on screen',
		window: 'window — spawn to first mapped window',
		memory: `memory — footprint of the process tree while idle, measured as ${MEMORY_METRIC_LABEL}`,
	};
	for (const signal of ['startup', 'window', 'memory']) {
		const rows = results.filter(r => r.signal === signal && r.stats);
		if (!rows.length) { continue; }
		const unit = signal === 'memory' ? 'MB' : 'ms';
		const withDelta = signal !== 'memory';
		push(`## ${headings[signal]}`, '');
		if (signal === 'startup') {
			const seen = new Set();
			for (const row of rows) {
				const editor = editors.find(e => e.name === row.editor);
				if (!editor || seen.has(editor.family)) { continue; }
				seen.add(editor.family);
				push(`- \`${editors.filter(e => e.family === editor.family).map(e => e.name).join('`, `')}\`: ${row.measuredAs ?? editor.readyMark}`);
			}
			if (seen.size > 1) {
				push('', 'These clocks do not start in the same place. Read a large gap as a result and a small one as unresolved; `window`, where it is available, is measured identically for both.');
			}
			push('');
		}
		push(`| Editor | Median | Mean | Std dev | Min | Max | n |${withDelta ? ' vs baseline |' : ''}`,
			`| --- | ---: | ---: | ---: | ---: | ---: | ---: |${withDelta ? ' --- |' : ''}`);
		for (const row of rows) {
			const s = row.stats;
			const delta = row.delta === undefined || row.delta === null
				? 'baseline'
				: `${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(1)} ${unit}${row.vsBaseline ? ` (p=${row.vsBaseline.p})` : ''}`;
			push(`| ${row.editor} | ${s.median.toFixed(1)} ${unit} | ${s.mean.toFixed(1)} ${unit} | ${s.stddev} | ${s.min} | ${s.max} | ${s.n} |${withDelta ? ` ${delta} |` : ''}`);
		}
		push('');
	}

	if (options.workload) {
		const pick = signal => results.filter(row => row.signal === signal && row.stats);
		const steadyRows = pick('workload-memory');
		if (steadyRows.length) {
			push(`## workload — the editor with a repository open, sampled over ${Math.round(options.workloadWindowMs / 1000)}s`, '');
			push(`Memory is ${MEMORY_METRIC_LABEL} of the whole process tree. **steady** is the median of the last third of the window, **peak** the largest single sample.`, '');
			push('| Editor | Steady (median) | Peak (median) | Steady min | Steady max | n | vs baseline |',
				'| --- | ---: | ---: | ---: | ---: | ---: | --- |');
			for (const row of steadyRows) {
				const peak = pick('workload-peak').find(entry => entry.editor === row.editor);
				const delta = row.baseline
					? 'baseline'
					: row.delta === null || row.delta === undefined
						? ''
						: `${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(1)} MB${row.vsBaseline ? ` (p=${row.vsBaseline.p})` : ''}`;
				push(`| ${row.editor} | ${row.stats.median.toFixed(1)} MB | ${peak ? `${peak.stats.median.toFixed(1)} MB` : ''} | ${row.stats.min.toFixed(1)} | ${row.stats.max.toFixed(1)} | ${row.stats.n} | ${delta} |`);
			}
			push('');
			push('| Editor | CPU over the window (median) | Idle CPU, last third (median) | Settled after (median) | Runs that never settled |',
				'| --- | ---: | ---: | ---: | ---: |');
			for (const row of steadyRows) {
				const cpu = pick('workload-cpu').find(entry => entry.editor === row.editor);
				const idle = pick('workload-idle-cpu').find(entry => entry.editor === row.editor);
				const settle = results.find(entry => entry.editor === row.editor && entry.signal === 'workload-settle');
				push(`| ${row.editor} | ${cpu ? `${cpu.stats.median.toFixed(1)} s` : ''} | ${idle ? `${idle.stats.median.toFixed(1)}% of one core` : ''} | ${settle?.stats ? `${Math.round(settle.stats.median)} ms` : `> ${Math.round(options.workloadWindowMs / 1000)}s`} | ${settle?.runsThatNeverSettled ?? 0} |`);
			}
			push('');
			push('CPU is the whole process tree, accumulated per process at its high-water mark. Idle CPU is a share of one core: 100% is one core fully busy while nobody is touching the editor.', '');
			push(`"Settled after" is the first sample from which memory stayed inside a 5% band (5 MB minimum) of the steady value. It can be no finer than one sample — ${Math.round(options.workloadSampleMs / 1000)}s here — and an editor that was already settled at its first sample reports that first sample.`, '');
		}

		push('### Workload runs', '');
		push('Every run, including the excluded ones. The full sample series of every run is in the JSON report beside this file.', '');
		push('| Editor | Run | steady (MB) | peak (MB) | settled after (ms) | cpu (s) | idle cpu (%) | processes | note |',
			'| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
		for (const editor of editors) {
			editor.workloadRuns.forEach((run, index) => {
				const settled = run.stillGrowing ? 'never' : run.settleMs ?? '';
				push(`| ${editor.name} | ${index + 1} | ${run.steadyMB ?? ''} | ${run.peakMB ?? ''} | ${settled} | ${run.cpuSeconds ?? ''} | ${run.idleCpuPercent ?? ''} | ${run.processes ?? ''} | ${run.note ?? ''} |`);
			});
		}
		push('');
		push('<details><summary>Memory curve of every run (MB, one sample every '
			+ `${Math.round(options.workloadSampleMs / 1000)}s from launch)</summary>`, '');
		for (const editor of editors) {
			editor.workloadRuns.forEach((run, index) => {
				if (!run.samples?.length) { return; }
				push(`- \`${editor.name}\` run ${index + 1}: ${run.samples.map(sample => sample.mb).join(', ')}`);
			});
		}
		push('', '</details>', '');
	}

	push('## Raw runs', '');
	push('Every launch, including warmups and excluded rows. Statistics above use only `run` rows with no note.', '');
	push('| Editor | Launch | startup (ms) | timers (ms) | mark seen (ms) | window (ms) | load | note |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
	for (const editor of editors) {
		const counters = { warmup: 0, run: 0 };
		for (const row of editor.rows) {
			counters[row.kind]++;
			push(`| ${editor.name} | ${row.kind} ${counters[row.kind]} | ${row.startup ?? ''} | ${row.timers ?? ''} | ${row.markSeenMs ?? ''} | ${row.window ?? ''} | ${row.load ?? ''} | ${row.note ?? ''} |`);
		}
	}
	push('');

	if (options.memory) {
		push('| Editor | Memory run | value (MB) | processes | note |', '| --- | --- | ---: | ---: | --- |');
		for (const editor of editors) {
			editor.memorySamples.forEach((row, index) => {
				push(`| ${editor.name} | ${index + 1} | ${row.pssMB ?? ''} | ${row.processes ?? ''} | ${row.note ?? ''} |`);
			});
		}
		push('');
	}

	push('## Method', '');
	for (const note of payload.notes) { push(`- ${note}`); }
	push('');
	push('---', '', 'Absolute numbers are machine-specific. Only comparisons within this single batch mean anything.');
	return lines.join('\n');
}

function writeReport(payload, opts) {
	const written = [];
	const slug = `akkento-ide-bench-${timestampSlug(new Date(payload.startedAt))}-${payload.host.platform}`;
	const json = JSON.stringify(payload, null, 2);

	if (opts.report) {
		fs.mkdirSync(opts.outDir, { recursive: true });
		const jsonPath = path.join(opts.outDir, `${slug}.json`);
		const mdPath = path.join(opts.outDir, `${slug}.md`);
		fs.writeFileSync(jsonPath, json);
		fs.writeFileSync(mdPath, markdownReport(payload));
		written.push(jsonPath, mdPath);
	}
	if (opts.json) {
		fs.mkdirSync(path.dirname(opts.json), { recursive: true });
		fs.writeFileSync(opts.json, json);
		written.push(opts.json);
	}
	return written;
}

// ----------------------------------------------------------------------------
// console sections
// ----------------------------------------------------------------------------

/** Comma-separated list, wrapped to width, continuation lines indented. */
function wrapList(items, prefix, width) {
	const lines = [];
	let current = prefix;
	for (const [index, item] of items.entries()) {
		const piece = index === items.length - 1 ? item : `${item}, `;
		if (visibleLength(current) + visibleLength(piece) > width && current !== prefix) {
			lines.push(current);
			current = ' '.repeat(prefix.length);
		}
		current += piece;
	}
	if (current.trim()) { lines.push(current); }
	return lines;
}

function check(symbol, text, detail) {
	ui.log(`  ${symbol} ${text}`);
	if (detail) { ui.log(`    ${c.grey(detail)}`); }
}

const OK = () => c.green(G.ok);
const FAIL = () => c.red(G.fail);
const WARN = () => c.yellow(G.warn);
const INFO = () => c.grey(G.info);

/** Only the candidates that could ever match here — the rest is noise. */
function candidatesForThisPlatform(editor) {
	const windowsish = p => p.includes('\\') || /^%\w+%/.test(p);
	const macish = p => p.endsWith('.app');
	return [...(editor.paths ?? []).filter(p => IS_WIN ? windowsish(p) : IS_MAC ? !windowsish(p) : !windowsish(p) && !macish(p)),
		...(editor.commands ?? [])];
}

function printEditorList(editors) {
	ui.log('');
	for (const editor of editors) {
		const symbol = !editor.binary ? c.grey(G.skip) : editor.problem ? FAIL() : OK();
		const state = !editor.binary ? c.grey('not installed') : editor.problem ? c.red('cannot be launched') : c.green('ready');
		ui.log(`  ${symbol} ${c.bold(padEndVisible(editor.name, 12))} ${state}`);
		if (editor.binary) { ui.log(`      ${c.grey(redact(editor.binary))}`); }
		if (editor.family && editor.family !== 'code') {
			ui.log(`      ${c.grey(`${familyOf(editor).title} — timed to ${familyOf(editor).readyMark}`)}`);
		}
		else {
			for (const line of wrapList(candidatesForThisPlatform(editor).map(redact), 'tried: ', layoutWidth() - 6)) {
				ui.log(`      ${c.grey(line)}`);
			}
		}
		if (editor.via) { ui.log(`      ${c.grey(`resolved from ${redact(editor.via)}`)}`); }
		if (editor.problem) { ui.log(`      ${c.yellow(editor.problem)}`); }
		if (editor.unresolvedReason) { ui.log(`      ${c.yellow(editor.unresolvedReason)}`); }
	}
	ui.log('');
}

/**
 * What the operator has to know before a batch starts, while they can still
 * act on it. Almost every unusable result we have been sent came from one of
 * these three things, and all three are only fixable *before* the first run.
 */
function printWelcome(opts) {
	const bullet = (text, continuation = []) => {
		ui.log(`    ${c.cyan(G.info)} ${text}`);
		for (const line of continuation) { ui.log(`      ${c.grey(line)}`); }
	};
	ui.log('');
	ui.log(rule('before you start'));
	ui.log('');
	ui.log(`  ${c.grey('Each editor is launched many times over and timed from launch until it')}`);
	ui.log(`  ${c.grey('reports its own shell is on screen. The machine is busy for the whole batch.')}`);
	ui.log('');
	ui.log(`  ${c.bold('For numbers worth comparing')}`);
	bullet('Close every editor you have open.',
		['A running copy competes for the machine with every run that follows it,', 'including its competitors\' runs.']);
	bullet('Leave the machine alone until it finishes.',
		['No builds, no video calls, no browsing. Runs are held back while the', 'machine is busy, and a run that never got a quiet machine is discarded.']);
	bullet('On a laptop: plug it in, and turn battery saver off.',
		['Most laptops clock down on battery, which is measured as the editor being slow.']);
	ui.log('');
	ui.log(`  ${c.bold('What this does to your system')}`);
	bullet('Your real profiles and extensions are never touched.',
		['Every launch gets a brand new throwaway profile, deleted straight after it.']);
	bullet('Nothing is sent anywhere — there is no network code in this tool.',
		[`A report is written to ${displayPath(opts.outDir)} at the end, for you to share if you choose to.`,
			'The editors themselves may use the network — one that downloads a language server on',
			'first use will do it during the workload phase, on a fresh profile, every run.']);
	if (opts.workload && !opts.workloadFolder) {
		bullet('A repository is generated in temp for the workload phase.',
			['Thousands of files, deleted with everything else at the end. Nothing of yours is opened.']);
	}
	if (opts.workloadFolder) {
		bullet(`The workload phase opens ${displayPath(opts.workloadFolder)}.`,
			['Editors write into a workspace they open (caches, indexes, the odd settings file).',
				'It is your repository: this tool reports what changed in it and never resets it.']);
	}
	bullet(`${c.bold('Ctrl+C')} stops cleanly at any point.`,
		['The editor under test is killed and the throwaway profiles are removed.']);
}

/**
 * Wait for the operator, so that everything above is read rather than scrolled
 * past. Skipped when there is no one at the keyboard (a pipe, a CI runner) or
 * when --yes says so, because a prompt nobody can answer is a hang.
 */
async function confirmStart(opts, hasWarnings) {
	if (opts.yes || !process.stdin.isTTY || !TTY) {
		if (!opts.yes) { ui.log(`  ${c.grey('non-interactive input — starting without waiting for a keypress')}`); }
		return;
	}
	const { createInterface } = await import('node:readline');
	const prompt = `  ${c.bold(hasWarnings ? 'Press Enter to start anyway' : 'Press Enter to start')}`
		+ `  ${c.grey('·')}  ${c.grey('Ctrl+C to cancel')}  `;
	await new Promise(resolve => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		// Without an explicit listener, readline swallows ^C at a prompt and
		// merely pauses — the operator would be stuck with no way out.
		rl.on('SIGINT', () => { rl.close(); handleInterrupt('SIGINT'); });
		rl.question(prompt, () => { rl.close(); resolve(); });
	});
	// Redraw the answered prompt line as a plain acknowledgement.
	if (LIVE) { ui.write('\x1b[1A\x1b[0J'); }
	ui.log(`  ${OK()} ${c.grey('starting')}`);
}

/** Median-relative bar chart — the shape of the result, before the numbers. */
function printBars(entries, unit) {
	if (entries.length < 2) { return; }
	const isMemory = unit === 'MB';
	const worst = Math.max(...entries.map(e => e.value));
	const best = Math.min(...entries.map(e => e.value));
	const nameWidth = Math.max(...entries.map(e => e.name.length));
	const width = Math.max(12, Math.min(38, layoutWidth() - nameWidth - 30));
	ui.log('');
	for (const entry of [...entries].sort((a, b) => a.value - b.value)) {
		const fraction = worst === 0 ? 0 : entry.value / worst;
		const isBest = entry.value === best;
		const colour = isBest ? c.green : entry.value / best > 1.25 ? c.red : c.yellow;
		const relative = isBest
			? c.green(isMemory ? 'smallest' : 'fastest')
			: c.grey(`${((entry.value / best - 1) * 100).toFixed(0)}% ${isMemory ? 'more' : 'slower'}`);
		ui.log(`  ${c.bold(padEndVisible(entry.name, nameWidth))}  ${colour(bar(fraction, width))}  ${padStartVisible(isMemory ? fmtMB(entry.value) : fmtMs(entry.value), 10)}  ${relative}`);
	}
	ui.log('');
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const startedAt = new Date();
	const t0 = Date.now();

	let config;
	try {
		config = JSON.parse(fs.readFileSync(opts.config, 'utf8'));
	} catch (error) {
		console.error(`${G.fail} could not read editor config ${opts.config}\n  ${error.message}`);
		process.exit(1);
	}
	const editors = resolveEditors(config, opts.only);

	for (const editor of editors) {
		editor.problem = editor.binary ? launchProblem(editor.binary) : undefined;
	}

	ui.log('');
	ui.log(banner());

	if (opts.list) {
		ui.log('');
		ui.log(rule('editors'));
		printEditorList(editors);
		return;
	}

	// The corpus, written out and handed over. A benchmark whose input can only
	// be seen by running the benchmark is a benchmark nobody audits: this puts
	// the exact repository every workload run opens on disk, in two seconds,
	// with the fingerprint that a report can be checked against.
	if (opts.emitCorpus) {
		ui.log('');
		ui.log(rule('corpus'));
		ui.log('');
		if (fs.existsSync(opts.emitCorpus) && fs.readdirSync(opts.emitCorpus).length) {
			ui.log(`  ${FAIL()} ${displayPath(opts.emitCorpus)} already exists and is not empty`);
			ui.log(`    ${c.grey('pick a path that does not exist yet — this writes thousands of files and will not merge into a directory it did not create')}`);
			ui.log('');
			process.exit(1);
		}
		let status = 'generating…';
		ui.status(() => [`  ${c.cyan(ui.spinner())} ${status}`]);
		const corpus = buildCorpus(opts.emitCorpus, opts.workloadCorpus, text => { status = text; });
		ui.clearStatus();
		ui.log(table([
			{ key: 'field', label: 'field' },
			{ key: 'value', label: 'value' },
		], [
			{ field: 'corpus', value: c.bold(corpus.size) },
			{ field: 'corpus version', value: String(corpus.corpusVersion) },
			{ field: 'fingerprint', value: c.bold(corpus.digest) },
			{ field: 'modules', value: corpus.modules.toLocaleString('en-US') },
			{ field: 'files', value: corpus.files.toLocaleString('en-US') },
			{ field: 'source bytes', value: `${(corpus.bytes / 1048576).toFixed(1)} MB` },
			{ field: 'git', value: corpus.git ? 'committed' : c.yellow('unavailable — not a repository') },
		]));
		ui.log('');
		// Outside the table: a long path would stretch every row with it.
		ui.log(`  ${c.grey('written to')} ${displayPath(corpus.dir)}`);
		ui.log('');
		ui.log(`  ${c.grey('This is exactly what a workload run opens. Anyone who generates the same corpus')}`);
		ui.log(`  ${c.grey('at the same version gets the same fingerprint — that is what makes a published')}`);
		ui.log(`  ${c.grey('workload number checkable without trusting whoever published it.')}`);
		ui.log('');
		return;
	}

	const { unique: available, duplicates } = dedupeByBinary(editors.filter(e => e.binary && !e.problem));
	const missing = editors.filter(e => !e.binary);
	const broken = editors.filter(e => e.binary && e.problem);

	// Refuse to start rather than emit a partial comparison that reads as a
	// complete one: an unlaunchable binary is a config error, and the failure
	// would otherwise surface once per round for the length of the run.
	if (broken.length) {
		ui.log('');
		ui.log(rule('cannot start'));
		ui.log('');
		for (const editor of broken) {
			ui.log(`  ${FAIL()} ${c.bold(editor.name)}  ${c.grey(redact(editor.binary))}`);
			ui.log(`      ${c.yellow(editor.problem)}`);
			ui.log('');
		}
		ui.log(`  ${c.grey('Fix the "paths" entry in editors.json (node bench.mjs --list re-checks), or exclude it with --only.')}`);
		ui.log('');
		process.exit(1);
	}
	if (available.length < 1) {
		ui.log('');
		ui.log(`  ${FAIL()} no editors found — check editors.json, or install one (see the README)`);
		ui.log(`    ${c.grey('node bench.mjs --list  shows every path that was tried')}`);
		ui.log('');
		process.exit(1);
	}

	printWelcome(opts);

	// ------------------------------------------------------------------
	// preflight
	// ------------------------------------------------------------------
	ui.log('');
	ui.log(rule('preflight'));
	ui.log('');

	const host = captureHost();
	check(OK(), c.bold('machine'), hostSummary(host));

	if (opts.window && !haveWindowTools()) {
		check(INFO(), 'window signal disabled', IS_LINUX
			? 'wmctrl/xprop not found — install them for the second signal, or pass --no-window to silence this'
			: 'the window signal is Linux/X11 only; startup is measured on every platform');
		opts.window = false;
	} else if (opts.window) {
		check(OK(), 'window signal enabled', 'wmctrl + xprop found');
	}

	if (IS_WIN) {
		check(INFO(), 'load gate inactive', 'Windows reports no load average — close other work by hand');
	} else {
		check(OK(), 'load gate', `runs hold until the 1-minute load average is <= ${opts.maxLoad}`);
	}

	// An editor that claims its single-instance lock by binding a unix socket
	// inside the throwaway profile can only start if the whole path fits the
	// kernel's cap, so where the profiles go is decided by the longest path
	// this batch would need — not by TMPDIR alone.
	const launchesPerEditor = opts.warmups + opts.runs
		+ (opts.memory ? opts.memoryRuns : 0)
		+ (opts.workload ? opts.workloadRuns : 0);
	const chosenRoot = chooseStateRoot(longestProfileSocketTail(available, launchesPerEditor));
	stateRoot = chosenRoot.dir;
	host.tempFilesystem = filesystemOf(stateRoot);
	check(OK(), 'throwaway profiles', `${redact(stateRoot)}${host.tempFilesystem ? c.grey(` (${host.tempFilesystem})`) : ''}`);
	if (chosenRoot.passedOver) {
		ui.log(`    ${c.grey(`not ${redact(chosenRoot.passedOver)}: a profile there leaves no room for the single-instance socket each launch binds inside it`)}`);
	}

	// Not just ^C: a `timeout`, a closed terminal or a stop from a CI runner
	// arrives as SIGTERM/SIGHUP, and leaving the editor under test running
	// against a profile in temp is the same problem whichever signal it was.
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
		process.on(signal, () => handleInterrupt(signal));
	}
	process.on('exit', restoreCursor);

	for (const editor of available) {
		editor.stateDir = path.join(stateRoot, editor.name);
		fs.mkdirSync(editor.stateDir, { recursive: true });
		editor.rows = [];
		editor.memorySamples = [];
		editor.workloadRuns = [];
	}

	// The socket cap again, now against the paths that will really be used —
	// chooseStateRoot has already tried every shorter root by here, so this is
	// the last word. It is checked for the same reason an unlaunchable binary
	// is: the failure would otherwise surface once per round, after the machine
	// is committed, as a wall of rows that never reached a window.
	for (const editor of available) {
		const socket = familyOf(editor).profileSocket;
		if (!socket) { continue; }
		const longest = path.join(editor.stateDir, `launch-${launchesPerEditor}`, 'user-data', socket);
		if (longest.length <= UNIX_SOCKET_MAX) { continue; }
		ui.log('');
		ui.log(`  ${FAIL()} ${c.bold(editor.name)} cannot be launched from ${redact(stateRoot)}`);
		ui.log(`      ${c.yellow(`throwaway profile paths reach ${longest.length} bytes, and ${editor.name} binds a unix socket inside the profile — the kernel caps that path at ${UNIX_SOCKET_MAX}`)}`);
		ui.log(`      ${c.grey('every launch would fail before the editor drew anything. Set TMPDIR to something shorter (TMPDIR=/tmp node bench.mjs), or exclude it with --only.')}`);
		ui.log('');
		fs.rmSync(stateRoot, { recursive: true, force: true });
		process.exit(1);
	}
	const machineWide = available.filter(editor => familyOf(editor).machineWideLock);
	if (machineWide.length) {
		check(INFO(), `${machineWide.map(e => e.name).join(', ')}: the single-instance lock is machine-wide here`,
			'a throwaway profile does not sidestep it — a copy you have open will turn every launch into a handoff, and the batch into a wall of EXITED rows');
	}

	// The workload phase's repository is decided and built here, before
	// anything is timed: generating a large corpus is a minute of file writes,
	// and a minute of file writes in the middle of a measured batch is a minute
	// charged to whichever editor was running.
	if (opts.workload) {
		if (opts.workloadFolder) {
			const dirty = dirtyCount(opts.workloadFolder);
			opts.workloadTarget = {
				folder: opts.workloadFolder,
				corpus: { dir: opts.workloadFolder, generated: false, dirtyAtStart: dirty },
			};
			check(OK(), 'workload repository', redact(opts.workloadFolder));
			ui.log(`    ${c.grey(dirty === undefined
				? 'not a git repository (or git is not installed) — nothing here can tell you what an editor wrote into it'
				: `git says ${dirty} uncommitted path(s) before the batch; it is your repository, so it is reported on and never reset`)}`);
		} else {
			let corpusStatus = 'generating the workload corpus…';
			ui.status(() => [`  ${c.cyan(ui.spinner())} ${corpusStatus}`]);
			const corpus = buildCorpus(path.join(stateRoot, 'corpus'), opts.workloadCorpus, text => { corpusStatus = text; });
			ui.clearStatus();
			opts.workloadTarget = { folder: corpus.dir, corpus };
			check(OK(), 'workload corpus',
				`${corpus.size}: ${corpus.modules.toLocaleString('en-US')} modules, ${corpus.files.toLocaleString('en-US')} files, ${(corpus.bytes / 1048576).toFixed(1)} MB`);
			ui.log(`    ${c.grey(`fingerprint ${corpus.digest} (corpus v${corpus.corpusVersion}) — the same on every machine that generates it`)}`);
			if (!corpus.git) {
				ui.log(`    ${c.yellow('git is not available: the corpus is not a repository, so no editor does source-control work on it')}`);
			}
		}

		const requested = opts.workloadOpen ?? (opts.workloadFolder ? 'none' : CORPUS_ENTRY);
		if (requested !== 'none') {
			const target = path.resolve(opts.workloadTarget.folder, requested);
			if (!fs.existsSync(target)) {
				ui.log('');
				ui.log(`  ${FAIL()} --workload-open: no such file in the workload repository`);
				ui.log(`      ${c.yellow(redact(target))}`);
				ui.log('');
				fs.rmSync(stateRoot, { recursive: true, force: true });
				process.exit(1);
			}
			opts.workloadTarget.open = target;
			opts.workloadTarget.openRelative = requested;
			check(OK(), 'workload file', `${requested} ${c.grey('— opened in the editor, which is what makes a language server start')}`);
		} else {
			check(INFO(), 'workload file: none',
				'only the folder is opened. Most editors start a language server when a file is opened, not when a folder is — pass --workload-open PATH to measure that too');
		}
	}

	ui.status(() => [`  ${c.cyan(ui.spinner())} reading editor versions…`]);
	for (const editor of available) {
		editor.version = await editorVersion(editor, stateRoot);
	}
	ui.clearStatus();

	for (const editor of available) {
		check(OK(), c.bold(padEndVisible(editor.name, 12)) + c.grey(editor.version),
			redact(editor.binary) + (editor.via ? c.grey(`  ← ${redact(editor.via)}`) : ''));
	}

	for (const duplicate of duplicates) {
		check(INFO(), `${c.bold(duplicate.name)} skipped`,
			`same executable as ${duplicate.sameAs} (${redact(duplicate.binary)}) — one editor cannot be compared against itself`);
	}

	if (missing.length) {
		check(INFO(), `${missing.length} editor(s) not installed`, missing.map(e => e.name).join(', '));
		for (const editor of missing.filter(e => e.unresolvedReason)) {
			ui.log(`      ${c.yellow(editor.unresolvedReason)}`);
		}
	}

	// Your own open copy of an editor under test competes for CPU and RAM with
	// every run, including the runs of its competitors.
	const alreadyRunning = [];
	for (const editor of available) {
		const already = runningInstances(editor.binary);
		if (already > 0) { alreadyRunning.push(`${editor.name} (${already} process${already === 1 ? '' : 'es'})`); }
	}
	if (alreadyRunning.length) {
		check(WARN(), c.yellow('an editor under test is already running'),
			`${alreadyRunning.join(', ')} — close it: everything measured here is otherwise measured on a machine it is already using`);
	} else {
		check(OK(), 'no editor under test is already running');
	}

	const warnings = hostWarnings(host);
	for (const warning of warnings) { check(WARN(), c.yellow(warning)); }
	if (alreadyRunning.length) {
		warnings.push(`an editor under test was already running when the batch started: ${alreadyRunning.join(', ')}`);
	}

	// ------------------------------------------------------------------
	// plan
	// ------------------------------------------------------------------
	const startupLaunches = (opts.warmups + opts.runs) * available.length;
	const memoryLaunches = opts.memory ? opts.memoryRuns * available.length : 0;
	const workloadLaunches = opts.workload ? opts.workloadRuns * available.length : 0;
	const totalLaunches = startupLaunches + memoryLaunches + workloadLaunches;
	// Rough priors so the first ETA is not blank; replaced by measured rates.
	const estimateMs = startupLaunches * 14_000
		+ memoryLaunches * (opts.memorySettleMs + 4_000)
		+ workloadLaunches * (opts.workloadWindowMs + 6_000);

	ui.log('');
	ui.log(rule('plan'));
	ui.log('');
	ui.log(`  ${c.bold(available.length)} editor(s) ${c.grey('·')} ${c.bold(opts.warmups)} warmup + ${c.bold(opts.runs)} measured run(s) each${opts.memory ? ` ${c.grey('·')} ${c.bold(opts.memoryRuns)} memory run(s) each` : ''}${opts.workload ? ` ${c.grey('·')} ${c.bold(opts.workloadRuns)} workload run(s) each` : ''}`);
	ui.log(`  ${c.bold(totalLaunches)} launches in total ${c.grey('·')} roughly ${c.bold(fmtDuration(estimateMs))} ${c.grey('(machine dependent)')}`);
	ui.log(`  ${c.grey(`interleaved round-robin, rotating start order; one editor at a time; a brand new profile per launch${opts.folder ? `; opening ${redact(opts.folder)}` : ''}`)}`);
	if (opts.workload) {
		ui.log(`  ${c.grey(`workload runs open ${redact(opts.workloadTarget.folder)}${opts.workloadTarget.open ? ` and ${path.basename(opts.workloadTarget.open)}` : ''} and watch it for ${Math.round(opts.workloadWindowMs / 1000)}s, sampling every ${Math.round(opts.workloadSampleMs / 1000)}s`)}`);
	}
	ui.log('');

	await confirmStart(opts, warnings.length > 0);
	ui.log('');

	// ------------------------------------------------------------------
	// live progress state
	// ------------------------------------------------------------------
	const progress = {
		done: 0,
		total: totalLaunches,
		editor: '',
		label: '',
		status: 'starting',
		launchStart: Date.now(),
		durations: [],
	};

	const eta = () => {
		if (progress.durations.length < 2) { return undefined; }
		const average = progress.durations.reduce((a, b) => a + b, 0) / progress.durations.length;
		return average * (progress.total - progress.done);
	};

	const summaryFor = editor => {
		const values = editor.rows.filter(r => r.kind === 'run' && !r.note && r.startup !== undefined).map(r => r.startup);
		const s = stats(values);
		return s ? `median so far ${c.bold(fmtMs(s.median))} ${c.grey(`(n=${s.n})`)}` : c.grey('no measured run yet');
	};

	let currentEditor;
	const renderStatus = () => {
		const width = Math.max(14, Math.min(34, termWidth() - 56));
		const fraction = progress.total ? progress.done / progress.total : 0;
		const elapsed = Date.now() - t0;
		const remaining = eta();
		const head = `  ${progressBar(fraction, width)} ${c.bold(`${progress.done}/${progress.total}`)} launches`;
		const clock = `${c.grey('elapsed')} ${fmtDuration(elapsed)}  ${c.grey('eta')} ${remaining === undefined ? '--:--' : fmtDuration(remaining)}`;
		const runtime = ((Date.now() - progress.launchStart) / 1000).toFixed(1);
		return [
			c.grey(G.h.repeat(layoutWidth())),
			`${head}   ${clock}`,
			`  ${c.cyan(ui.spinner())} ${c.bold(padEndVisible(progress.editor, 12))} ${c.grey(padEndVisible(progress.label, 12))} ${progress.status} ${c.grey(`${runtime}s`)}`,
			`    ${currentEditor ? summaryFor(currentEditor) : ''}`,
		];
	};

	const setStatus = text => { progress.status = text; };

	/**
	 * The load gate can hold a run for minutes. With the live block drawn that
	 * is visible; without it (CI, a redirected log) it would be dead silence,
	 * so say it once per launch instead.
	 */
	const gateWatcher = () => {
		let announced = false;
		return load => {
			setStatus(`waiting for a quiet machine ${c.grey(`(load ${load.toFixed(2)} > ${opts.maxLoad})`)}`);
			if (!LIVE && !announced) {
				announced = true;
				ui.log(`  ${INFO()} ${c.grey(`${progress.editor}: waiting for the machine to go quiet (load ${load.toFixed(2)} > ${opts.maxLoad})`)}`);
			}
		};
	};

	// ------------------------------------------------------------------
	// startup phase
	// ------------------------------------------------------------------
	ui.log(rule('startup phase'));
	ui.log('');
	ui.status(renderStatus);

	const rounds = opts.warmups + opts.runs;
	for (let round = 0; round < rounds; round++) {
		const kind = round < opts.warmups ? 'warmup' : 'run';
		const order = available.slice(round % available.length).concat(available.slice(0, round % available.length));
		for (const editor of order) {
			currentEditor = editor;
			progress.editor = editor.name;
			progress.label = kind === 'warmup' ? `warmup ${round + 1}/${opts.warmups}` : `run ${round + 1 - opts.warmups}/${opts.runs}`;
			progress.launchStart = Date.now();
			setStatus('waiting for a quiet machine');

			const quiet = await waitForQuiet(opts.maxLoad, 120_000, gateWatcher());
			const sample = await runOnce(editor, opts, kind, setStatus);
			if (!quiet) { sample.note = sample.note ?? 'LOAD-GATE-TIMEOUT'; }
			editor.rows.push(sample);

			progress.done++;
			progress.durations.push(Date.now() - progress.launchStart);

			const symbol = sample.note ? FAIL() : kind === 'warmup' ? c.grey(G.skip) : OK();
			const numbers = [
				`${c.grey('startup')} ${padStartVisible(sample.startup === undefined ? '-' : c.bold(fmtMs(sample.startup)), 9)}`,
				opts.window ? `${c.grey('window')} ${padStartVisible(fmtMs(sample.window), 9)}` : '',
				sample.load === null ? '' : `${c.grey('load')} ${sample.load}`,
			].filter(Boolean).join('  ');
			ui.log(`  ${symbol} ${c.bold(padEndVisible(editor.name, 12))} ${c.grey(padEndVisible(progress.label, 12))} ${numbers}`);
			if (sample.note) { ui.log(`      ${c.yellow(sample.note)}`); }
		}
	}
	ui.clearStatus();

	// ------------------------------------------------------------------
	// memory phase
	// ------------------------------------------------------------------
	if (opts.memory) {
		ui.log('');
		ui.log(rule('memory phase'));
		ui.log('');
		ui.log(`  ${c.grey(`${opts.memoryRuns} run(s) per editor · ${MEMORY_METRIC_LABEL} of the whole process tree, sampled ${Math.round(opts.memorySettleMs / 1000)}s after launch`)}`);
		ui.log('');
		progress.durations = [];	// the memory phase paces differently; re-learn its rate
		ui.status(renderStatus);

		for (let round = 0; round < opts.memoryRuns; round++) {
			const order = available.slice(round % available.length).concat(available.slice(0, round % available.length));
			for (const editor of order) {
				currentEditor = editor;
				progress.editor = editor.name;
				progress.label = `memory ${round + 1}/${opts.memoryRuns}`;
				progress.launchStart = Date.now();
				setStatus('waiting for a quiet machine');

				await waitForQuiet(opts.maxLoad, 120_000, gateWatcher());
				const sample = await runMemoryOnce(editor, opts, setStatus);
				editor.memorySamples.push(sample);

				progress.done++;
				progress.durations.push(Date.now() - progress.launchStart);

				const symbol = sample.note ? FAIL() : OK();
				const processes = sample.processes === undefined ? '-' : `${sample.processes} process${sample.processes === 1 ? '' : 'es'}`;
				ui.log(`  ${symbol} ${c.bold(padEndVisible(editor.name, 12))} ${c.grey(padEndVisible(progress.label, 12))} ${c.grey('memory')} ${padStartVisible(c.bold(fmtMB(sample.pssMB)), 10)}  ${c.grey(processes)}`);
				if (sample.note) { ui.log(`      ${c.yellow(sample.note)}`); }
			}
		}
		ui.clearStatus();
	}

	// ------------------------------------------------------------------
	// workload phase
	// ------------------------------------------------------------------
	if (opts.workload) {
		ui.log('');
		ui.log(rule('workload phase'));
		ui.log('');
		ui.log(`  ${c.grey(`${opts.workloadRuns} run(s) per editor · ${redact(opts.workloadTarget.folder)}${opts.workloadTarget.open ? ` + ${path.basename(opts.workloadTarget.open)}` : ''}`)}`);
		ui.log(`  ${c.grey(`each run is watched for ${Math.round(opts.workloadWindowMs / 1000)}s, walking the process tree every ${Math.round(opts.workloadSampleMs / 1000)}s · ${MEMORY_METRIC_LABEL}`)}`);
		ui.log('');
		progress.durations = [];	// a workload run costs minutes; re-learn the rate
		ui.status(renderStatus);

		for (let round = 0; round < opts.workloadRuns; round++) {
			const order = available.slice(round % available.length).concat(available.slice(0, round % available.length));
			for (const editor of order) {
				currentEditor = editor;
				progress.editor = editor.name;
				progress.label = `workload ${round + 1}/${opts.workloadRuns}`;
				progress.launchStart = Date.now();
				setStatus('waiting for a quiet machine');

				await waitForQuiet(opts.maxLoad, 120_000, gateWatcher());
				const run = await runWorkloadOnce(editor, opts, setStatus);
				editor.workloadRuns.push(run);

				progress.done++;
				progress.durations.push(Date.now() - progress.launchStart);

				const symbol = run.note ? FAIL() : OK();
				const numbers = [
					`${c.grey('steady')} ${padStartVisible(c.bold(fmtMB(run.steadyMB)), 10)}`,
					`${c.grey('peak')} ${padStartVisible(fmtMB(run.peakMB), 10)}`,
					`${c.grey('cpu')} ${padStartVisible(fmtSeconds(run.cpuSeconds), 8)}`,
					`${c.grey('idle')} ${padStartVisible(fmtCore(run.idleCpuPercent), 7)}`,
				].join('  ');
				ui.log(`  ${symbol} ${c.bold(padEndVisible(editor.name, 12))} ${c.grey(padEndVisible(progress.label, 12))} ${numbers}`);
				if (run.stillGrowing) {
					ui.log(`      ${c.yellow(`still growing when the ${Math.round(opts.workloadWindowMs / 1000)}s window ended — it had not reached a steady state`)}`);
				}
				if (run.wroteIntoWorkspace) {
					ui.log(`      ${c.yellow(`${run.wroteIntoWorkspace} new uncommitted path(s) in your repository after this run`)}`);
				}
				if (run.note) { ui.log(`      ${c.yellow(run.note)}`); }
			}
		}
		ui.clearStatus();
	}

	// ------------------------------------------------------------------
	// results
	// ------------------------------------------------------------------
	ui.log('');
	ui.log(rule('results'));

	const results = [];
	const baseline = available[0];
	const validRuns = (editor, signal) => editor.rows
		.filter(row => row.kind === 'run' && !row.note)
		.map(row => row[signal])
		.filter(value => value !== undefined);

	const signalHelp = {
		startup: 'time to the editor reporting its own shell is on screen',
		window: 'spawn → first window mapped (an empty Electron shell counts; not time-to-usable)',
	};
	for (const signal of ['startup', 'window']) {
		if (signal === 'window' && !opts.window) { continue; }
		ui.log('');
		ui.log(`  ${c.title(signal)}  ${c.grey(signalHelp[signal])}`);
		ui.log('');

		// What each editor is being timed to, and from where. Printed with the
		// numbers rather than in a footnote: one column over two families is
		// exactly the thing a reader is entitled to see immediately.
		if (signal === 'startup') {
			const families = new Map();
			for (const editor of available) {
				const family = familyOf(editor);
				if (!families.has(family)) { families.set(family, []); }
				families.get(family).push(editor.name);
			}
			if (families.size > 1) {
				for (const [family, names] of families) {
					ui.log(`  ${c.grey(padEndVisible(wrapList(names, '', 26)[0] + (names.length > 3 ? ' …' : ''), 28))} ${c.grey(family.startupDefinition)}`);
				}
				ui.log(`  ${c.grey('the two clocks do not start in the same place — see the README before reading a small gap as a result')}`);
				ui.log('');
			}
		}

		const baselineStats = stats(validRuns(baseline, signal));
		const rows = [];
		const chart = [];
		let fastest;
		for (const editor of available) {
			const s = stats(validRuns(editor, signal));
			if (s && (!fastest || s.median < fastest.median)) { fastest = { name: editor.name, median: s.median }; }
		}
		for (const editor of available) {
			const s = stats(validRuns(editor, signal));
			let mw = null;
			let delta = null;
			if (s && baselineStats && editor !== baseline) {
				mw = mannWhitney(validRuns(baseline, signal), validRuns(editor, signal)) ?? null;
				delta = s.median - baselineStats.median;
			}
			results.push({
				editor: editor.name, signal, stats: s ?? null, delta, vsBaseline: mw,
				...(signal === 'startup' ? { measuredAs: familyOf(editor).startupDefinition } : {}),
			});
			if (!s) {
				rows.push({ editor: `  ${editor.name}`, median: c.grey('no data'), mean: '', stddev: '', range: '', n: '', delta: c.grey('every run was excluded') });
				continue;
			}
			chart.push({ name: editor.name, value: s.median });
			const isFastest = fastest?.name === editor.name;
			const deltaText = editor === baseline
				? c.grey('baseline')
				: delta === null ? '' : `${delta <= 0 ? c.green(`${delta.toFixed(0)} ms`) : c.red(`+${delta.toFixed(0)} ms`)}${mw ? c.grey(`  p=${mw.p}`) : ''}`;
			rows.push({
				editor: `${isFastest ? c.green(G.star) : ' '} ${editor.name}`,
				median: c.bold(fmtMs(s.median)),
				mean: fmtMs(s.mean),
				stddev: String(s.stddev),
				range: `${Math.round(s.min)} – ${Math.round(s.max)}`,
				n: String(s.n),
				delta: deltaText,
			});
		}
		ui.log(table([
			{ key: 'editor', label: 'editor' },
			{ key: 'median', label: 'median', align: 'right' },
			{ key: 'mean', label: 'mean', align: 'right' },
			{ key: 'stddev', label: 'stddev', align: 'right' },
			{ key: 'range', label: 'min – max', align: 'right' },
			{ key: 'n', label: 'n', align: 'right' },
			{ key: 'delta', label: `vs ${baseline.name}` },
		], rows));
		printBars(chart, 'ms');
	}

	if (opts.memory) {
		ui.log('');
		ui.log(`  ${c.title('memory')}  ${c.grey(`idle footprint of the whole process tree · ${MEMORY_METRIC_LABEL}`)}`);
		ui.log(`  ${c.grey('never compare memory numbers across operating systems')}`);
		ui.log('');
		const rows = [];
		const chart = [];
		const memoryStats = available.map(editor => stats(editor.memorySamples.map(x => x.pssMB).filter(v => v !== undefined)));
		const smallest = Math.min(...memoryStats.filter(Boolean).map(s => s.median));
		for (const [index, editor] of available.entries()) {
			const s = memoryStats[index];
			results.push({ editor: editor.name, signal: 'memory', metric: MEMORY_METRIC, stats: s ?? null, delta: null, vsBaseline: null });
			if (!s) {
				rows.push({ editor: `  ${editor.name}`, median: c.grey('no data'), range: '', processes: '', n: '' });
				continue;
			}
			chart.push({ name: editor.name, value: s.median });
			const processes = editor.memorySamples.findLast(x => x.processes !== undefined)?.processes;
			rows.push({
				editor: `${s.median === smallest ? c.green(G.star) : ' '} ${editor.name}`,
				median: c.bold(fmtMB(s.median)),
				range: `${s.min.toFixed(1)} – ${s.max.toFixed(1)}`,
				processes: String(processes ?? '-'),
				n: String(s.n),
			});
		}
		ui.log(table([
			{ key: 'editor', label: 'editor' },
			{ key: 'median', label: 'median', align: 'right' },
			{ key: 'range', label: 'min – max', align: 'right' },
			{ key: 'processes', label: 'processes', align: 'right' },
			{ key: 'n', label: 'n', align: 'right' },
		], rows));
		printBars(chart, 'MB');
	}

	if (opts.workload) {
		const target = opts.workloadTarget;
		ui.log('');
		ui.log(`  ${c.title('workload')}  ${c.grey(`with ${target.corpus.generated ? `the generated corpus (${target.corpus.modules.toLocaleString('en-US')} modules)` : redact(target.folder)}${target.open ? ` and ${path.basename(target.open)}` : ''} open`)}`);
		ui.log(`  ${c.grey(`${Math.round(opts.workloadWindowMs / 1000)}s per run, sampled every ${Math.round(opts.workloadSampleMs / 1000)}s · ${MEMORY_METRIC_LABEL} · never compare across operating systems`)}`);
		ui.log('');

		const valid = editor => editor.workloadRuns.filter(run => !run.note && run.steadyMB !== undefined);
		const across = (editor, key) => stats(valid(editor).map(run => run[key]).filter(value => value !== undefined));
		const baselineSteady = across(baseline, 'steadyMB');

		const memoryRows = [];
		const cpuRows = [];
		const chart = [];
		const curves = [];
		let smallest;
		for (const editor of available) {
			const steady = across(editor, 'steadyMB');
			if (steady && (smallest === undefined || steady.median < smallest)) { smallest = steady.median; }
		}
		for (const editor of available) {
			const runs = valid(editor);
			const steady = across(editor, 'steadyMB');
			const peak = across(editor, 'peakMB');
			const cpu = across(editor, 'cpuSeconds');
			const idle = across(editor, 'idleCpuPercent');
			const settle = across(editor, 'settleMs');
			const neverSettled = runs.filter(run => run.stillGrowing).length;
			const mw = steady && baselineSteady && editor !== baseline
				? mannWhitney(valid(baseline).map(run => run.steadyMB), runs.map(run => run.steadyMB)) ?? null
				: null;

			results.push({
				editor: editor.name, signal: 'workload-memory', metric: MEMORY_METRIC, stats: steady ?? null,
				baseline: editor === baseline,
				delta: steady && baselineSteady && editor !== baseline ? Number((steady.median - baselineSteady.median).toFixed(1)) : null,
				vsBaseline: mw,
			});
			results.push({ editor: editor.name, signal: 'workload-peak', metric: MEMORY_METRIC, stats: peak ?? null, delta: null, vsBaseline: null });
			results.push({ editor: editor.name, signal: 'workload-cpu', metric: 'cpu-seconds', stats: cpu ?? null, delta: null, vsBaseline: null });
			results.push({ editor: editor.name, signal: 'workload-idle-cpu', metric: 'percent-of-one-core', stats: idle ?? null, delta: null, vsBaseline: null });
			results.push({
				editor: editor.name, signal: 'workload-settle', metric: 'ms-from-launch', stats: settle ?? null,
				delta: null, vsBaseline: null, runsThatNeverSettled: neverSettled,
			});

			if (!steady) {
				memoryRows.push({ editor: `  ${editor.name}`, steady: c.grey('no data'), peak: '', range: '', processes: '', n: '', delta: c.grey('every run was excluded') });
				cpuRows.push({ editor: `  ${editor.name}`, cpu: c.grey('no data'), idle: '', settle: '', n: '' });
				continue;
			}
			chart.push({ name: editor.name, value: steady.median });
			// The run that came out in the middle: a curve should be typical of
			// the batch, not the prettiest or the worst of it.
			const middle = [...runs].sort((a, b) => a.steadyMB - b.steadyMB)[Math.floor((runs.length - 1) / 2)];
			curves.push({ name: editor.name, samples: middle?.samples ?? [] });

			memoryRows.push({
				editor: `${steady.median === smallest ? c.green(G.star) : ' '} ${editor.name}`,
				steady: c.bold(fmtMB(steady.median)),
				peak: peak ? fmtMB(peak.median) : '-',
				range: `${steady.min.toFixed(0)} – ${steady.max.toFixed(0)}`,
				processes: String(runs[runs.length - 1]?.processes ?? '-'),
				n: String(steady.n),
				delta: editor === baseline
					? c.grey('baseline')
					: !baselineSteady
						? c.grey(`no ${baseline.name} data`)
						: `${steady.median <= baselineSteady.median
							? c.green(`${(steady.median - baselineSteady.median).toFixed(0)} MB`)
							: c.red(`+${(steady.median - baselineSteady.median).toFixed(0)} MB`)}${mw ? c.grey(`  p=${mw.p}`) : ''}`,
			});
			cpuRows.push({
				editor: `  ${editor.name}`,
				cpu: c.bold(fmtSeconds(cpu?.median)),
				idle: fmtCore(idle?.median),
				settle: neverSettled === runs.length
					? c.yellow(`> ${Math.round(opts.workloadWindowMs / 1000)}s`)
					: `${fmtMs(settle?.median)}${neverSettled ? c.yellow(` (${neverSettled}/${runs.length} never did)`) : ''}`,
				n: String(steady.n),
			});
		}

		ui.log(table([
			{ key: 'editor', label: 'editor' },
			{ key: 'steady', label: 'steady', align: 'right' },
			{ key: 'peak', label: 'peak', align: 'right' },
			{ key: 'range', label: 'steady min – max', align: 'right' },
			{ key: 'processes', label: 'proc', align: 'right' },
			{ key: 'n', label: 'n', align: 'right' },
			{ key: 'delta', label: `vs ${baseline.name}` },
		], memoryRows));
		printBars(chart, 'MB');
		if (chart.length < 2) { ui.log(''); }

		ui.log(`  ${c.grey('cpu is the whole tree over the window; idle is the last third only, as a share of one core')}`);
		ui.log(`  ${c.grey(`settle is when memory stopped moving outside a 5% band — how long the editor kept working after its window was up`)}`);
		ui.log(`  ${c.grey(`it can be no finer than one sample (${Math.round(opts.workloadSampleMs / 1000)}s here), and an editor already settled at the first sample reports that first sample`)}`);
		ui.log('');
		ui.log(table([
			{ key: 'editor', label: 'editor' },
			{ key: 'cpu', label: 'cpu over window', align: 'right' },
			{ key: 'idle', label: 'idle cpu', align: 'right' },
			{ key: 'settle', label: 'settled after', align: 'right' },
			{ key: 'n', label: 'n', align: 'right' },
		], cpuRows));

		// The curve, which is the part a single number cannot carry: an editor
		// that opens flat at 900 MB and one that spikes to 1.6 GB and comes
		// back down have the same steady state and are not the same editor.
		const drawable = curves.filter(curve => curve.samples.length > 1);
		if (drawable.length) {
			const ceiling = Math.max(...drawable.flatMap(curve => curve.samples.map(sample => sample.mb)));
			const nameWidth = Math.max(...drawable.map(curve => curve.name.length));
			ui.log('');
			ui.log(`  ${c.grey(`memory over the run, typical run of each editor · 0 – ${fmtMB(ceiling)} across all of them`)}`);
			ui.log('');
			for (const curve of drawable) {
				ui.log(`  ${c.bold(padEndVisible(curve.name, nameWidth))}  ${c.cyan(sparkline(curve.samples.map(sample => sample.mb), 0, ceiling))}  ${c.grey(fmtMB(curve.samples[curve.samples.length - 1].mb))}`);
			}
			const marks = Math.max(...drawable.map(curve => curve.samples.length));
			const rightLabel = `${Math.round(opts.workloadWindowMs / 1000)}s`;
			ui.log(`  ${' '.repeat(nameWidth)}  ${c.grey(`0s${' '.repeat(Math.max(1, marks - 2 - rightLabel.length))}${rightLabel}`)}`);
			ui.log('');
		}
	}

	// excluded rows, so a polluted batch is never quietly presented as a clean one
	const excluded = [];
	for (const editor of available) {
		const count = editor.rows.filter(r => r.kind === 'run' && r.note).length
			+ editor.memorySamples.filter(r => r.note).length
			+ editor.workloadRuns.filter(r => r.note).length;
		if (count) { excluded.push(`${editor.name} (${count})`); }
	}
	if (excluded.length) {
		ui.log('');
		ui.log(`  ${WARN()} ${c.yellow('excluded runs')}: ${excluded.join(', ')}`);
		ui.log(`    ${c.grey('they are in the report but not in the statistics — fix the cause and rerun rather than trusting a polluted batch')}`);
	}

	// ------------------------------------------------------------------
	// report
	// ------------------------------------------------------------------
	const payload = {
		tool: { name: 'akkento-ide-bench', version: VERSION, schema: 4 },
		startedAt: startedAt.toISOString(),
		durationMs: Date.now() - t0,
		host,
		warnings,
		skippedAsDuplicate: duplicates.map(d => ({ ...d, binary: redact(d.binary) })),
		options: {
			runs: opts.runs, warmups: opts.warmups, maxLoad: opts.maxLoad,
			window: opts.window, forceX11: opts.forceX11, folder: redact(opts.folder) ?? null,
			memory: opts.memory, memoryRuns: opts.memoryRuns, memorySampledAfterMs: opts.memorySettleMs,
			memoryMetric: MEMORY_METRIC,
			workload: opts.workload,
			workloadRuns: opts.workload ? opts.workloadRuns : 0,
			workloadWindowMs: opts.workload ? opts.workloadWindowMs : null,
			workloadSampleMs: opts.workload ? opts.workloadSampleMs : null,
			workloadFolder: opts.workload ? redact(opts.workloadTarget.folder) : null,
			workloadOpen: opts.workload ? opts.workloadTarget.openRelative ?? null : null,
			workloadMemoryMetric: opts.workload ? MEMORY_METRIC : null,
			// The corpus identifies itself: a fingerprint is what lets two
			// reports be compared instead of merely being about the same tool.
			workloadCorpus: opts.workload && opts.workloadTarget.corpus.generated
				? {
					size: opts.workloadTarget.corpus.size,
					corpusVersion: opts.workloadTarget.corpus.corpusVersion,
					modules: opts.workloadTarget.corpus.modules,
					files: opts.workloadTarget.corpus.files,
					bytes: opts.workloadTarget.corpus.bytes,
					digest: opts.workloadTarget.corpus.digest,
					git: opts.workloadTarget.corpus.git,
				}
				: null,
			timeoutMs: opts.timeoutMs,
		},
		editors: available.map(e => ({
			name: e.name,
			family: e.family ?? 'code',
			readyMark: familyOf(e).readyMark,
			startupMeasuredAs: familyOf(e).startupDefinition,
			reportsTimers: familyOf(e).reportsTimers,
			binary: redact(e.binary),
			resolvedFromShim: redact(e.via) ?? null,
			version: e.version,
			extraArgs: e.extraArgs ?? [],
			rows: e.rows,			// every launch, including warmups and excluded runs
			memorySamples: e.memorySamples,
			workloadRuns: e.workloadRuns,	// every workload run, with its whole sample series
		})),
		results,
		notes: [
			'startup is the primary signal: time to the editor reporting its own shell is on screen. startupMeasuredAs on each editor says exactly what was timed — the VS Code family self-reports main-process-start to workbench-ready, Zed is timed by the harness from exec to its first rendered frame. The clocks do not start in the same place: Electron\'s bootstrap, before the first line of the app\'s own JavaScript, is charged to Zed and not to the Code family. Read a large gap across families as a result and a small one as unresolved; window, where available, is measured identically for both',
			'the memory phase does not pass --prof-append-timers and does not wait for a ready mark: that flag makes a Code-family editor exit a few seconds after writing it. Every editor is launched, left alone for memorySampledAfterMs, and sampled — the same wall clock for all of them',
			'the workload phase is the memory phase with a repository open and a clock that keeps running: the editor is launched onto options.workloadFolder (opening options.workloadOpen as well, when set), then the whole process tree is walked every workloadSampleMs for workloadWindowMs. steadyMB is the median of the last third of that window, peakMB the largest single sample, settleMs the first sample after which every later one stays within 5% (or 5 MB, whichever is larger) of steady — absent when memory never stopped moving, which is reported as stillGrowing rather than as a large number',
			'workload cpuSeconds is the CPU the whole tree burned over the window, accumulated per pid at its high-water mark so that a helper exiting does not un-spend what it spent; CPU used by a process that both started and exited between two samples is not counted. idleCpuPercent is CPU over the last third of the window only, as a share of one core (100% is one core fully busy)',
			'each workload run gets the same brand new throwaway profile treatment as every other launch, so an editor that downloads a language server on first use pays for that download inside the window, every run. That is a real cost of a first open and it is not a steady-state cost — which is why peak, steady and the settle curve are all reported separately, and why the whole sample series is in this file',
			'the generated corpus is deterministic (fixed seed, no clock, no randomness) and fingerprinted: two reports with the same workloadCorpus.digest and corpusVersion measured byte-identical repositories. It is committed to git where git is available, because an editor opening 2,500 untracked files does source-control work no real checkout would ask of it',
			'the generated corpus lives on the same temp filesystem as the profiles (host.tempFilesystem), which on many Linux systems is tmpfs — reading it is not charged for disk I/O, equally, for every editor. Use --workload-folder to measure a repository on real disk',
			'markSeenMs is when the harness could first read the mark, and is NOT a startup time: VS Code deliberately waits 15 seconds before appending its timers file and then exits, which is also why each Code-family launch costs about that much wall clock',
			'timers is the raw self-reported number for the Code family, identical to startup there and absent (never zero) for an editor that is not a Code fork',
			'rows[] contains ALL launches; statistics use only kind=run rows with no note',
			'every launch gets a brand new throwaway profile, discarded afterwards — user-data-dir plus extensions-dir for the Code family, Zed\'s own user-data-dir (which also relocates its config) for Zed: each run is a cold profile, not a profile the previous runs warmed',
			'vsBaseline compares each editor against the first configured editor using Mann-Whitney U (two-sided, normal approximation with tie and continuity correction); with n < 8 per side treat p as indicative only',
			'absolute numbers are machine-specific; only comparisons within one batch are meaningful',
			'home directory paths are redacted to ~ so a report can be shared as-is',
		],
	};

	if (opts.report || opts.json) {
		let written = [];
		try {
			written = writeReport(payload, opts);
		} catch (error) {
			ui.log(`  ${FAIL()} could not write the report: ${error.message}`);
		}
		if (written.length) {
			ui.log('');
			ui.log(rule('report'));
			ui.log('');
			for (const file of written) {
				const kind = file.endsWith('.md') ? 'human readable' : 'raw data';
				ui.log(`  ${OK()} ${padEndVisible(displayPath(file), 52)} ${c.grey(kind)}`);
			}
			ui.log('');
			ui.log(`  ${c.grey('The report carries your hardware, the editor versions and every raw launch.')}`);
			ui.log(`  ${c.grey('Nothing was sent anywhere — send it to us yourself if you want your result included:')}`);
			ui.log(`  ${c.cyan('https://github.com/Akkento/akkento-ide-bench/discussions')}`);
			ui.log('');
		}
	}

	ui.log(c.grey(`  finished in ${fmtDuration(Date.now() - t0)}`));
	ui.log('');

	try {
		fs.rmSync(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch {
		ui.log(`  ${WARN()} could not remove ${redact(stateRoot)} — a survivor process is probably still holding files in it`);
	}
}

main().catch(error => {
	ui.clearStatus();
	restoreCursor();
	console.error(error);
	process.exit(1);
});
