#!/usr/bin/env python3
"""EVERY ASSERTION MUST REACH ITS GATE'S EXIT CODE.

The defect, found only because a RED-prove came back 0-for-4: five assertions
in generation-contract-gate called `note`, which that section of the file does
not define -- it uses `ufail`. Bash runs an undefined command, prints "command
not found" to stderr, and carries on with the gate's failure counter
untouched. Each printed a convincing FAIL line and then let the build through.
"Print FAIL, exit 0", one level up.

PRECISION IS THE WHOLE POINT. A first cut of this cried wolf 42 times, by
reading `|| fail=1` (an assignment) and `a && b` inside a python heredoc
(that language's operator) as shell commands. A check wrong five times in six
trains you to skim past it, so both are excluded exactly rather than softened.
"""
import os, re, subprocess, sys

BUILTIN = set("""echo printf exit true false return continue break cat sed grep awk cut head
tail sort uniq tr wc test eval read cd rm mkdir touch python3 node xargs find command
: [ [[ let local export unset shift trap set source""".split())

def shell_only(text):
    """Drop heredoc bodies: only shell text may be read as shell."""
    out, delim = [], None
    for ln in text.splitlines():
        if delim is not None:
            if ln.strip() == delim:
                delim = None
            continue
        out.append(ln)
        m = re.search(r"<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?", ln)
        if m and not ln.lstrip().startswith('#'):
            delim = m.group(1)
    return out

def resolvable(tok, cache={}):
    if tok not in cache:
        cache[tok] = subprocess.run(['/bin/bash', '-c', f'command -v -- {tok!r}'],
                                    capture_output=True).returncode == 0
    return cache[tok]


def scan(text):
    """Yield (token, next_char) for every command position after && or ||.

    Quote state is tracked ACROSS LINES, because a shell string can span them:
    `node -e '...'` opens a quote on one line and closes it four lines later,
    and per-line tracking read that JavaScript as shell. Comments are skipped
    the same way -- a `#` inside a quote is not one.
    """
    sq = dq = False
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '\\' and (dq or not sq):
            i += 2; continue
        if c == "'" and not dq:
            sq = not sq; i += 1; continue
        if c == '"' and not sq:
            dq = not dq; i += 1; continue
        if not sq and not dq:
            if c == '#' and (i == 0 or text[i-1] in ' \t\n'):
                j = text.find('\n', i)
                i = n if j < 0 else j + 1
                continue
            if text.startswith('&&', i) or text.startswith('||', i):
                m = re.match(r"(?:\|\||&&)\s*([A-Za-z_][A-Za-z0-9_]*)(.?)", text[i:])
                if m:
                    yield m.group(1), m.group(2)
                    i += m.end(); continue
        i += 1


def check(path):
    lines = shell_only(open(path, encoding='utf-8', errors='replace').read())
    defined = set()
    for ln in lines:
        m = re.match(r"\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)", ln)
        if m:
            defined.add(m.group(1))
    bad = []
    for tok, nxt in scan('\n'.join(lines)):
        # The token is matched WHOLE and the assignment test applied after,
        # because a negative lookahead here backtracks: `fail=1` matched as
        # `fai` plus a non-`=` next character, and reported a function name
        # that was never written.
        if nxt == '=':
            continue              # assignment, not a command
        if tok in defined or tok in BUILTIN or resolvable(tok):
            continue
        bad.append(tok)
    return sorted(set(bad))


root = sys.argv[1] if len(sys.argv) > 1 else '.'
failed = 0
for g in sorted(os.listdir(root)):
    if not g.endswith('.sh') or g == 'gate-integrity-gate.sh' or g.startswith('__sweep_'):
        continue
    for tok in check(os.path.join(root, g)):
        print(f"  ✗ {g}: `{tok}` is called after && or || but is defined nowhere"
              f" — that assertion prints and cannot fail the gate")
        failed = 1
sys.exit(failed)
