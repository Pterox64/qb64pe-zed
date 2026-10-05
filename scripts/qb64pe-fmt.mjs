#!/usr/bin/env node
/**
 * qb64pe-fmt.mjs — standalone formatter for QB64-PE (Phoenix Edition) source.
 *
 * This is a dependency-free port of the two independent formatting passes from
 * the reference VS Code extension (grymmjack/qb64pe-vscode):
 *
 *   1. Block-aware re-indentation (whitespace only — never changes code).
 *   2. Optional keyword casing (`--case upper|lower|mixed`).
 *
 * It is designed to be wired into Zed as an external formatter, which pipes the
 * buffer contents to the command's stdin and reads the result from stdout:
 *
 *   "languages": {
 *     "QB64-PE": {
 *       "formatter": {
 *         "external": {
 *           "command": "node",
 *           "arguments": ["/absolute/path/to/scripts/qb64pe-fmt.mjs"]
 *         }
 *       }
 *     }
 *   }
 *
 * Usage:
 *   node qb64pe-fmt.mjs [options] [file]
 *   node qb64pe-fmt.mjs --case upper < program.bas > formatted.bas
 *
 * Options:
 *   --indent-size N    Spaces per indent level (default 4).
 *   --no-indent        Disable re-indentation.
 *   --no-indent-subs   Do not indent SUB/FUNCTION bodies.
 *   --case MODE        Keyword casing: upper | lower | mixed | none (default none).
 *   --normalize        Normalise glued block keywords (ENDIF -> END IF, ...).
 *   -h, --help         Show this help.
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Keyword vocabulary (kept in sync with tree-sitter/qb64/grammar.js).
// ---------------------------------------------------------------------------

const KEYWORDS = new Set(
  `
  ABS ABSOLUTE ACCEPTFILEDROP ACCESS ACOS ACOSH ADLER32 ALIAS ALL
  ALLOWFULLSCREEN ALPHA ALPHA32 AND ANDALSO ANY APPEND AS ASC ASIN ASINH
  ASSERT ATAN2 ATANH ATN AUTODISPLAY AXIS BACKGROUNDCOLOR BASE BEEP BIN$
  BINARY BIT BLEND BLINK BLOAD BLUE BLUE32 BSAVE BUTTON BUTTONCHANGE BYTE
  BYVAL CALL CAPSLOCK CASE CDBL CEIL CHAIN CHDIR CHR$ CINP CINT CIRCLE
  CLEAR CLEARCOLOR CLIP CLIPBOARD$ CLIPBOARDIMAGE CLNG CLOSE CLS COLOR
  COLORCHOOSERDIALOG COM COMMAND$ COMMANDCOUNT COMMON CONNECTED
  CONNECTIONADDRESS CONNECTIONADDRESS$ CONSOLE CONSOLECURSOR CONSOLEFONT
  CONSOLEINPUT CONSOLETITLE CONST CONTINUE CONTROLCHR COPYIMAGE COPYPALETTE
  COS COSH COT COTH CRC32 CSC CSCH CSNG CSRLIN CUSTOMTYPE CV CVD CVDMBF CVI
  CVL CVS CVSMBF CWD$ D2G D2R DATA DATE$ DECLARE DEF DEFAULTCOLOR DEFDBL
  DEFINE DEFINT DEFLATE$ DEFLNG DEFSNG DEFSTR DELAY DEPTHBUFFER DESKTOPHEIGHT
  DESKTOPWIDTH DEST DEVICE$ DEVICEINPUT DEVICES DIM DIR$ DIREXISTS DISPLAY
  DISPLAYORDER DO DONTBLEND DONTWAIT DOUBLE DRAW DROPPEDFILE DROPPEDFILE$
  DYNAMIC ECHO ELSE ELSEIF EMBEDDED$ END ENVIRON ENVIRON$ ENVIRONCOUNT EOF
  EQV ERASE ERDEV ERDEV$ ERL ERR ERROR ERRORLINE ERRORMESSAGE$ EVERYCASE EXIT
  EXP EXPLICIT EXPLICITARRAY FIELD FILEATTR FILEEXISTS FILES FILES$
  FILLBACKGROUND FINISHDROP FIX FLOAT FOR FPS FRE FREE FREEFILE FREEFONT
  FREEIMAGE FREETIMER FULLPATH$ FULLSCREEN FUNCTION G2D G2R GET GOSUB GOTO
  GREEN GREEN32 HARDWARE HARDWARE1 HEIGHT HEX$ HIDE HYPOT ICON IF IMP
  INCLERRORFILE$ INCLERRORLINE INFLATE$ INKEY$ INP INPUT INPUT$ INPUTBOX$
  INSTR INSTRREV INT INTEGER INTEGER64 INTERRUPT INTERRUPTX IOCTL IOCTL$ IS
  KEEPBACKGROUND KEY KEYCLEAR KEYDOWN KEYHIT KILL LASTAXIS LASTBUTTON
  LASTWHEEL LBOUND LCASE$ LEFT$ LEN LET LIBRARY LIMIT LINE LIST LOADFONT
  LOADIMAGE LOC LOCATE LOCK LOF LOG LONG LOOP LPOS LPRINT LSET LTRIM$
  MAPTRIANGLE MAPUNICODE MD5$ MEM MEMCOPY MEMELEMENT MEMEXISTS MEMFILL
  MEMFREE MEMGET MEMIMAGE MEMNEW MEMPUT MEMSOUND MESSAGEBOX MID$ MIDDLE MK$
  MKD$ MKDIR MKDMBF$ MKI$ MKL$ MKS$ MKSMBF$ MOD MOUSEBUTTON MOUSEHIDE
  MOUSEINPUT MOUSEMOVE MOUSEMOVEMENTX MOUSEMOVEMENTY MOUSEPIPEOPEN MOUSESHOW
  MOUSEWHEEL MOUSEX MOUSEY NAME NEGATE NEWIMAGE NEXT NONE NOT NOTIFYPOPUP
  NUMLOCK OCT$ OFF OFFSET ON ONLY ONLYBACKGROUND ONTOP OPEN OPENCLIENT
  OPENCONNECTION OPENFILEDIALOG$ OPENHOST OPTION OR ORELSE OS$ OUT OUTPUT
  PAINT PALETTE PALETTECOLOR PCOPY PEEK PEN PI PIXELSIZE PLAY PMAP POINT POKE
  POS PRESERVE PRESET PRINT PRINTIMAGE PRINTMODE PRINTSTRING PRINTWIDTH PSET
  PUT PUTIMAGE R2D R2G RANDOM RANDOMIZE READ READBIT READFILE$ RED RED32
  REDIM RESET RESETBIT RESIZE RESIZEHEIGHT RESIZEWIDTH RESTORE RESUME RETURN
  RGB RGB32 RGBA RGBA32 RIGHT$ RMDIR RND ROL ROR ROUND RSET RTRIM$ RUN SADD
  SAVEFILEDIALOG$ SAVEIMAGE SCALEDHEIGHT SCALEDWIDTH SCREEN SCREENCLICK
  SCREENEXISTS SCREENHIDE SCREENICON SCREENIMAGE SCREENMOVE SCREENPRINT
  SCREENSHOW SCREENX SCREENY SCROLLLOCK SEAMLESS SEC SECH SEEK SEG SELECT
  SELECTFOLDERDIALOG$ SETALPHA SETBIT SETMEM SGN SHARED SHELL SHELLHIDE SHL
  SHR SIGNAL SIN SINGLE SINH SLEEP SMOOTH SMOOTHSHRUNK SMOOTHSTRETCHED SNDBAL
  SNDCLOSE SNDCOPY SNDGETPOS SNDLEN SNDLIMIT SNDLOOP SNDNEW SNDOPEN
  SNDOPENRAW SNDPAUSE SNDPAUSED SNDPLAY SNDPLAYCOPY SNDPLAYFILE SNDPLAYING
  SNDRATE SNDRAW SNDRAWDONE SNDRAWLEN SNDSETPOS SNDSTOP SNDVOL SOFTWARE SOUND
  SOURCE SPACE$ SPC SQR SQUAREPIXELS STARTDIR$ STATIC STATUSCODE STEP STICK
  STOP STR$ STRCMP STRETCH STRICMP STRIG STRING STRING$ SUB SWAP SYSTEM TAB
  TAN TANH THEN TIME$ TIMER TITLE TITLE$ TO TOGGLE TOGGLEBIT TOTALDROPPEDFILES
  TRIM$ TROFF TRON TYPE UBOUND UCASE$ UCHARPOS UEVENT UFONTHEIGHT ULINESPACING
  UNLOCK UNSIGNED UNTIL UPRINTSTRING UPRINTWIDTH USING VAL VARPTR VARPTR$
  VARSEG VIEW WAIT WEND WHEEL WHILE WIDTH WINDOW WINDOWHANDLE WINDOWHASFOCUS
  WORD WRITE WRITEFILE XOR
  _ACCEPTFILEDROP _ADLER32 _ALLOWFULLSCREEN _ALPHA _ALPHA32 _ANDALSO
  _ANTICLOCKWISE _ASSERT _AUTODISPLAY _AXIS _BACKGROUNDCOLOR _BEHIND _BIN$
  _BIT _BLEND _BLINK _BLUE _BLUE32 _BUTTON _BUTTONCHANGE _BYTE _CAPSLOCK
  _CEIL _CLEARCOLOR _CLIP _CLIPBOARD$ _CLIPBOARDIMAGE _CLOCKWISE
  _COLORCHOOSERDIALOG$ _COMMAND$ _COMMANDCOUNT _CONNECTED _CONNECTIONADDRESS
  _CONNECTIONADDRESS$ _CONSOLE _CONSOLECURSOR _CONSOLEFONT _CONSOLEINPUT
  _CONSOLETITLE _CONTINUE _CONTROLCHR _COPYIMAGE _COPYPALETTE _CRC32 _CWD$
  _CV _D2G _D2R _DEFAULTCOLOR _DEFLATE$ _DELAY _DEPTHBUFFER _DESKTOPHEIGHT
  _DESKTOPWIDTH _DEST _DEVICE$ _DEVICEINPUT _DEVICES _DIR$ _DIREXISTS _DISPLAY
  _DISPLAYORDER _DONTBLEND _DONTWAIT _DROPPEDFILE _DROPPEDFILE$ _ECHO
  _EMBEDDED$ _ENVIRON _ENVIRON$ _ENVIRONCOUNT _ERDEV _ERDEV$ _ERRORLINE
  _ERRORMESSAGE$ _EXPLICIT _EXPLICITARRAY _FILEEXISTS _FILES _FILES$
  _FILLBACKGROUND _FINISHDROP _FLOAT _FONT _FONTHEIGHT _FONTWIDTH _FPS _FRE
  _FREE _FREEFILE _FREEFONT _FREEIMAGE _FREETIMER _FULLPATH$ _FULLSCREEN _G2D
  _G2R _GREEN _GREEN32 _HARDWARE _HARDWARE1 _HEIGHT _HIDE _HYPOT _ICON
  _INCLERRORFILE$ _INCLERRORLINE _INFLATE$ _INPUT$ _INPUTBOX$ _INSTR _INSTRREV
  _INTEGER _INTEGER64 _KEEPBACKGROUND _KEYCLEAR _KEYDOWN _KEYHIT _LASTAXIS
  _LASTBUTTON _LASTWHEEL _LBOUND _LIMIT _LOADFONT _LOADIMAGE _MAPUNICODE
  _MAPTRIANGLE _MD5$ _MEM _MEMCOPY _MEMELEMENT _MEMEXISTS _MEMFILL _MEMFREE
  _MEMGET _MEMIMAGE _MEMNEW _MEMPUT _MEMSOUND _MESSAGEBOX _MIDDLE _MOUSEBUTTON
  _MOUSEHIDE _MOUSEINPUT _MOUSEMOVE _MOUSEMOVEMENTX _MOUSEMOVEMENTY
  _MOUSEPIPEOPEN _MOUSESHOW _MOUSEWHEEL _MOUSEX _MOUSEY _NEGATE _NEWIMAGE
  _NONE _NOTIFYPOPUP _NUMLOCK _OFFSET _ONLY _ONLYBACKGROUND _ONTOP _OPENCLIENT
  _OPENCONNECTION _OPENFILEDIALOG$ _OPENHOST _ORELSE _OS$ _PALETTECOLOR _PI
  _PIXELSIZE _PRESERVE _PRINTIMAGE _PRINTMODE _PRINTSTRING _PRINTWIDTH
  _PUTIMAGE _R2D _R2G _READBIT _READFILE$ _RED _RED32 _RESETBIT _RESIZE
  _RESIZEHEIGHT _RESIZEWIDTH _RGB _RGB32 _RGBA _RGBA32 _ROL _ROR _ROUND
  _SAVEFILEDIALOG$ _SAVEIMAGE _SCALEDHEIGHT _SCALEDWIDTH _SCREEN
  _SCREENCLICK _SCREENEXISTS _SCREENHIDE _SCREENICON _SCREENIMAGE _SCREENMOVE
  _SCREENPRINT _SCREENSHOW _SCREENX _SCREENY _SCROLLLOCK _SEC _SECH
  _SELECTFOLDERDIALOG$ _SETALPHA _SETBIT _SETMEM _SHELLHIDE _SHL _SHR _SIGNAL
  _SINH _SMOOTH _SMOOTHSHRUNK _SMOOTHSTRETCHED _SNDBAL _SNDCLOSE _SNDCOPY
  _SNDGETPOS _SNDLEN _SNDLIMIT _SNDLOOP _SNDNEW _SNDOPEN _SNDOPENRAW
  _SNDPAUSE _SNDPAUSED _SNDPLAY _SNDPLAYCOPY _SNDPLAYFILE _SNDPLAYING
  _SNDRATE _SNDRAW _SNDRAWDONE _SNDRAWLEN _SNDSETPOS _SNDSTOP _SNDVOL
  _SOFTWARE _SOURCE _SQUAREPIXELS _STARTDIR$ _STATUSCODE _STRCMP _STRETCH
  _STRICMP _TITLE _TITLE$ _TOGGLE _TOGGLEBIT _TOTALDROPPEDFILES _TRIM$
  _UCASE$ _UCHARPOS _UEVENT _UFONTHEIGHT _ULINESPACING _UNSIGNED _UPRINTSTRING
  _UPRINTWIDTH _WHEEL _WIDTH _WINDOWHANDLE _WINDOWHASFOCUS _WRITEFILE
  `
    .trim()
    .split(/\s+/),
);

// Glued block keywords normalised by `--normalize`.
const GLUED_KEYWORDS = new Map([
  ["ENDIF", "END IF"],
  ["ENDSUB", "END SUB"],
  ["ENDFUNCTION", "END FUNCTION"],
  ["ENDTYPE", "END TYPE"],
  ["ENDSELECT", "END SELECT"],
  ["ENDDECLARE", "END DECLARE"],
]);

// ---------------------------------------------------------------------------
// Line-level lexer (strings/comments masked, columns preserved).
// ---------------------------------------------------------------------------

const IDENT_CHAR = /[A-Za-z0-9_]/;
const METACOMMAND = /^\s*'?\$[A-Za-z]/;
const IDENTIFIER = /\$?[A-Za-z_][A-Za-z0-9_]*(?:~?(?:%%|&&|##|[%&!#`])|\$)?/g;
const SIGIL = /(?:~?(?:%%|&&|##|[%&!#`])|\$)$/;

function scanLine(line) {
  const n = line.length;
  const colons = [];
  const spans = [];

  if (METACOMMAND.test(line)) {
    return { mask: line, commentStart: -1, colons, spans, isMetacommand: true };
  }

  const mask = line.split("");
  let commentStart = -1;
  let atStatementStart = true;
  let i = 0;

  while (i < n) {
    const c = line[i];

    if (c === '"') {
      const start = i;
      i++;
      while (i < n && line[i] !== '"') i++;
      const end = Math.min(i + 1, n);
      for (let k = start; k < end; k++) mask[k] = " ";
      spans.push({ start, end, kind: "string" });
      i = end;
      atStatementStart = false;
      continue;
    }

    if (c === "'") {
      commentStart = i;
      break;
    }

    if (
      atStatementStart &&
      (c === "R" || c === "r") &&
      /^rem$/i.test(line.substring(i, i + 3)) &&
      (i + 3 >= n || !IDENT_CHAR.test(line[i + 3]))
    ) {
      commentStart = i;
      break;
    }

    if (c === ":") {
      colons.push(i);
      atStatementStart = true;
      i++;
      continue;
    }

    if (!/\s/.test(c)) atStatementStart = false;
    i++;
  }

  if (commentStart >= 0) {
    for (let k = commentStart; k < n; k++) mask[k] = " ";
    spans.push({ start: commentStart, end: n, kind: "comment" });
  }

  return { mask: mask.join(""), commentStart, colons, spans, isMetacommand: false };
}

// ---------------------------------------------------------------------------
// Keyword casing.
// ---------------------------------------------------------------------------

function caseWord(word, mode) {
  switch (mode) {
    case "upper":
      return word.toUpperCase();
    case "lower":
      return word.toLowerCase();
    case "mixed":
      return word.replace(
        /[A-Za-z]+/g,
        (chunk) => chunk[0].toUpperCase() + chunk.slice(1).toLowerCase(),
      );
    default:
      return word;
  }
}

function formatContentLine(line, opts) {
  if (opts.mode === "none" && !opts.normalize) return line;
  const scan = scanLine(line);
  if (scan.isMetacommand) return line;

  IDENTIFIER.lastIndex = 0;
  let out = "";
  let last = 0;
  let m;
  while ((m = IDENTIFIER.exec(scan.mask)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const word = line.slice(start, end);
    const upper = m[0].toUpperCase();

    if (opts.normalize && GLUED_KEYWORDS.has(upper)) {
      const replaced = GLUED_KEYWORDS.get(upper);
      out += line.slice(last, start) +
        (opts.mode === "none" ? replaced : caseWord(replaced, opts.mode));
      last = end;
      continue;
    }

    const stripped = m[0].replace(SIGIL, "").toUpperCase();
    if (KEYWORDS.has(upper) || KEYWORDS.has(stripped)) {
      out += line.slice(last, start) + caseWord(word, opts.mode);
      last = end;
    }
  }
  return out + line.slice(last);
}

// ---------------------------------------------------------------------------
// Block-aware re-indentation (ported from the VS Code extension's indent.ts).
// ---------------------------------------------------------------------------

function indentStr(unit, level) {
  return level > 0 ? unit.repeat(level) : "";
}

const NONE = {
  opens: false,
  closes: false,
  mid: false,
  select: false,
  case: false,
  endSelect: false,
  continuation: false,
};

function splitAtColons(code, colons) {
  if (!colons || colons.length === 0) return [code];
  const parts = [];
  let start = 0;
  for (const idx of colons) {
    if (idx >= start && idx <= code.length) {
      parts.push(code.slice(start, idx));
      start = idx + 1;
    }
  }
  parts.push(code.slice(start));
  return parts;
}

function classifyStatement(code, opts) {
  const indentSubs = opts.indentSubs !== false;
  const upper = code.trim().toUpperCase();
  if (!upper) return NONE;
  const first = upper.split(/[\s:(]/, 1)[0];
  const r = (over) => ({ ...NONE, ...over });

  if (/^END\s+SELECT\b/.test(upper) || first === "ENDSELECT") return r({ endSelect: true });
  if (/^SELECT\b/.test(upper)) return r({ select: true });
  if (first === "CASE") return r({ case: true });

  if (/^END\s+(SUB|FUNCTION)\b/.test(upper) || first === "ENDSUB" || first === "ENDFUNCTION") {
    return r({ closes: indentSubs });
  }
  if (
    /^END\s+(IF|TYPE|DECLARE)\b/.test(upper) ||
    first === "ENDIF" ||
    first === "ENDTYPE" ||
    first === "LOOP" ||
    first === "WEND" ||
    first === "NEXT"
  ) {
    return r({ closes: true });
  }

  if (first === "ELSE" || first === "ELSEIF") return r({ mid: true });

  if (first === "SUB" || first === "FUNCTION") {
    if (/^DECLARE\b/.test(upper)) return r({});
    return r({ opens: indentSubs });
  }
  if (first === "TYPE") return r({ opens: true });
  if (/^DECLARE\s+(DYNAMIC\s+)?LIBRARY\b/.test(upper)) return r({ opens: true });

  if (first === "IF") {
    if (/\bTHEN\s*$/.test(upper)) return r({ opens: true });
    return r({});
  }
  if (first === "FOR") {
    if (/\bNEXT\b/.test(upper)) return r({});
    return r({ opens: true });
  }
  if (first === "DO") {
    if (/\bLOOP\b/.test(upper)) return r({});
    return r({ opens: true });
  }
  if (first === "WHILE") {
    if (/\bWEND\b/.test(upper)) return r({});
    return r({ opens: true });
  }

  return r({});
}

function classify(raw, opts) {
  const scan = scanLine(raw);
  if (scan.isMetacommand) {
    const m = raw.trim().toUpperCase();
    if (/^\$IF\b/.test(m)) return { ...NONE, opens: true };
    if (/^\$END\s*IF\b/.test(m)) return { ...NONE, closes: true };
    if (/^\$ELSE(IF)?\b/.test(m)) return { ...NONE, mid: true };
    return NONE;
  }

  const codeFull = scan.mask.replace(/'.*$/, "");
  const continuation = /_\s*$/.test(codeFull.trim());
  const stmts = splitAtColons(codeFull, scan.colons)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (stmts.length <= 1) {
    return { ...classifyStatement(stmts[0] ?? "", opts), continuation };
  }

  const primary = classifyStatement(stmts[0], opts);
  if (primary.select || primary.case || primary.endSelect) {
    return { ...primary, continuation };
  }

  let delta = 0;
  for (const s of stmts) {
    const cs = classifyStatement(s, opts);
    if (cs.opens) delta += 1;
    else if (cs.closes) delta -= 1;
  }

  if (primary.mid || primary.closes) {
    if (delta < 0) return { ...NONE, closes: true, continuation };
    return { ...NONE, mid: true, continuation };
  }
  if (delta > 0) return { ...NONE, opens: true, continuation };
  if (delta < 0) return { ...NONE, closes: true, continuation };
  return { ...NONE, continuation };
}

function reindentLines(lines, unit, opts) {
  const out = [];
  let depth = 0;
  const selects = [];
  let continued = false;

  for (const raw of lines) {
    const content = raw.trim();
    if (content.length === 0) {
      out.push("");
      continue;
    }

    const c = classify(raw, opts);

    if (continued) {
      out.push(indentStr(unit, depth + 1) + content);
      continued = c.continuation;
      continue;
    }

    let render = depth;

    if (c.endSelect) {
      const frame = selects.pop();
      if (frame && frame.caseOpen) depth = Math.max(0, depth - 1);
      depth = Math.max(0, depth - 1);
      render = depth;
    } else if (c.case) {
      const frame = selects[selects.length - 1];
      if (frame && frame.caseOpen) depth = Math.max(0, depth - 1);
      render = depth;
      depth += 1;
      if (frame) frame.caseOpen = true;
    } else if (c.closes) {
      depth = Math.max(0, depth - 1);
      render = depth;
    } else if (c.mid) {
      render = Math.max(0, depth - 1);
    }

    out.push(indentStr(unit, render) + content);

    if (c.select) {
      selects.push({ select: true, caseOpen: false });
      depth += 1;
    } else if (c.opens) {
      depth += 1;
    }

    continued = c.continuation;
  }

  return out;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const HELP = `qb64pe-fmt — formatter for QB64-PE source

Usage: node qb64pe-fmt.mjs [options] [file]

Options:
  --indent-size N    Spaces per indent level (default 4).
  --no-indent        Disable re-indentation.
  --no-indent-subs   Do not indent SUB/FUNCTION bodies.
  --case MODE        Keyword casing: upper | lower | mixed | none (default none).
  --normalize        Normalise glued block keywords (ENDIF -> END IF, ...).
  -h, --help         Show this help.

Reads from stdin when no file (or "-") is given.
`;

function parseArgs(argv) {
  const opts = {
    indentSize: 4,
    indent: true,
    indentSubs: true,
    mode: "none",
    normalize: false,
    file: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--indent-size") {
      opts.indentSize = Math.max(1, parseInt(argv[++i], 10) || 4);
    } else if (a.startsWith("--indent-size=")) {
      opts.indentSize = Math.max(1, parseInt(a.slice(14), 10) || 4);
    } else if (a === "--no-indent") {
      opts.indent = false;
    } else if (a === "--no-indent-subs") {
      opts.indentSubs = false;
    } else if (a === "--case") {
      opts.mode = (argv[++i] || "none").toLowerCase();
    } else if (a.startsWith("--case=")) {
      opts.mode = a.slice(7).toLowerCase();
    } else if (a === "--normalize") {
      opts.normalize = true;
    } else if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (!a.startsWith("-")) {
      opts.file = a;
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const input =
    opts.file && opts.file !== "-"
      ? readFileSync(opts.file, "utf8")
      : readFileSync(0, "utf8");

  if (input.length === 0) return;

  const eol = input.includes("\r\n") ? "\r\n" : "\n";
  let lines = input.split(/\r?\n/);

  lines = lines.map((line) => formatContentLine(line, opts));

  if (opts.indent) {
    lines = reindentLines(lines, " ".repeat(opts.indentSize), {
      indentSubs: opts.indentSubs,
    });
  }

  process.stdout.write(lines.join(eol));
}

main();
