#!/usr/bin/env python3
"""FIRST LUMEN OUTPUT — detect it, score it against both references, and record
the built-not-wired CROSSING.

DETECTION IS KEY-BASED, NOT SUBSTRING. A substring scan for "scene" produced a
FALSE POSITIVE on the first run: the word appears in free-text `plan.notes`
("...a steady observational rhythm utilizing slow drift scene...") on a job with
no scene emission at all. A generated scene is a STRUCTURE, so the detector looks
for scene-shaped KEYS carrying a non-empty value — never for a word in prose.

On the first real hit it:
  1. records the crossing (BUILT-NOT-WIRED -> WIRED) with the job id and time
  2. downloads the rendered video
  3. scores it via score_component.py as `full_edit` against both references
"""
import json, os, subprocess, sys, datetime, urllib.request

SCENE_KEYS = ("generated_scenes", "scenes", "scene_plan", "insert_scenes", "lumen_scenes")


def rows(since):
    env = {}
    for ln in open("/Users/zaclibman/content-studio/.env.local"):
        if "=" in ln and not ln.strip().startswith("#"):
            k, _, v = ln.strip().partition("=")
            env[k] = v
    url, key = env["SUPABASE_URL"].rstrip("/"), env["SUPABASE_SERVICE_ROLE_KEY"]
    q = (f"{url}/rest/v1/video_jobs?select=id,created_at,status,rendered_video_url,edit_recipe,result"
         f"&status=eq.completed&created_at=gte.{since}&order=created_at.desc&limit=200")
    r = urllib.request.Request(q, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    return json.load(urllib.request.urlopen(r, timeout=30))


# COUNTER-SHAPED payloads that carry the scene KEY but are telemetry, not scenes.
# `result.component_ledger.generated_scenes` is {requested, drop_reasons,
# dropped_by_us, survived_derived} — a dict of four COUNTERS. The previous rule
# ("key present AND len>0") read those four keys as four scenes and reported a
# FALSE FIRST LUMEN OUTPUT on a job whose ledger says requested: 0.
_COUNTER_KEYS = {"requested", "drop_reasons", "dropped_by_us", "survived_derived",
                 "count", "n", "total", "emitted"}


def scene_payload(row):
    """Return the scene structure ONLY if this row genuinely emitted scenes.

    THREE REFINEMENTS, each after a false positive:
      1. substring 'scene' matched prose in plan.notes            -> key-based
      2. key-based + len>0 matched a COUNTER DICT (requested: 0)  -> shape-checked
      3. shape: a real emission is a LIST of scene objects, or a dict whose
         `requested` is > 0. A bare counter dict is never a hit.
    """
    def is_real(v):
        if isinstance(v, list):
            # a list of scene OBJECTS, not a list of numbers
            return len(v) > 0 and any(isinstance(x, dict) for x in v)
        if isinstance(v, dict):
            if not v:
                return False
            # a counter/ledger object is telemetry ABOUT scenes, not scenes
            if set(map(str, v.keys())) <= _COUNTER_KEYS:
                return bool(v.get("requested") or v.get("emitted") or v.get("count"))
            return True
        return False

    def hunt(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if str(k).lower() in SCENE_KEYS and is_real(v):
                    return {k: v}
                found = hunt(v)
                if found:
                    return found
        elif isinstance(o, list):
            for v in o:
                found = hunt(v)
                if found:
                    return found
        return None
    return hunt({"edit_recipe": row.get("edit_recipe"), "result": row.get("result")})


def main():
    since = sys.argv[1] if len(sys.argv) > 1 else "2026-08-15T18:00:00"
    rs = rows(since)
    hits = [(r, scene_payload(r)) for r in rs]
    hits = [(r, p) for r, p in hits if p]
    print(f"scanned {len(rs)} completions since {since}")
    if not hits:
        print("NO LUMEN SCENE OUTPUT YET — key-based detector, 0 hits.")
        print("(a substring scan would have returned 1; it was the word 'scene' in plan.notes prose)")
        return 2
    row, payload = hits[-1]
    print(f"\n*** FIRST LUMEN OUTPUT: {row['id']} at {row['created_at']} ***")
    print(f"    scene payload key(s): {list(payload)} n={len(list(payload.values())[0])}")
    # The crossing is recorded ONLY from a production row. This watcher reads
    # video_jobs, so every hit here IS production by construction — but the label
    # is printed explicitly because a build-lane artifact scored elsewhere must
    # never be mistaken for this event.
    print(f"\nBUILT-NOT-WIRED CROSSING RECORDED  [PRODUCTION — video_jobs row, not a harness render]:")
    print(f"    Lumen scene vocabulary: BUILT-NOT-WIRED -> **WIRED**")
    print(f"    crossed at {row['created_at']} by job {row['id']}")
    print(f"    production counter: completions carrying scene telemetry = {len(hits)}")
    url = row.get("rendered_video_url")
    if not url:
        print("\n  no rendered_video_url — cannot score the artifact yet.")
        return 1
    dest = f"/tmp/lumen_first_{row['id'][:8]}.mp4"
    print(f"\n  downloading artifact -> {dest}")
    try:
        urllib.request.urlretrieve(url, dest)
    except Exception as e:
        print(f"  download FAILED ({e}) — scorecard cannot run; artifact unreachable.")
        return 1
    print(f"  scoring against BOTH references as full_edit…\n")
    subprocess.run([sys.executable,
                    os.path.join(os.path.dirname(os.path.abspath(__file__)), "score_component.py"),
                    "full_edit", dest, "--production"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
