#!/usr/bin/env python3
"""build_course_data.py — turn the mined lesson sets into the member-portal course data.

Inputs (all produced by the mining scripts, never hand-edited):
  ~/.hermes/state/airbnb_lessons.json      airbnb_lesson_mine.py
  ~/.hermes/state/tax_course_lessons.json  tax_course_mine.py
  ~/.hermes/state/*_course_calls.json      the worklists (module + guest + drive_id)
  ~/.hermes/state/ev_drive_index.json      name -> Drive file id (for video deep links)

Outputs:
  api/_shared/courses/airbnb.js   course data bundled INTO the function (member-only)
  api/_shared/courses/tax.js
  api/_shared/courses/index.js    the catalogue the hub lists
  ~/projects/tax-course/tax-course-content.md       human-readable copy
  ~/projects/airbnb-course/airbnb-course-content.md

Why curation happens here: the miners deliberately over-extract (every teachable
moment). A MINI course cannot ship 262 lessons. This step scores, de-duplicates
across calls (the same tax point gets taught in four different calls) and caps each
module, so the member gets the tight spine rather than a transcript dump.

Run:  python3 scripts/build_course_data.py
"""
import json, os, re, sys, time
from collections import defaultdict

HOME = os.path.expanduser("~")
STATE = f"{HOME}/.hermes/state"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = f"{REPO}/api/_shared/courses"

# ── The two courses ─────────────────────────────────────────────────────────────
AIRBNB_MODULES = {
    "0": "Thesis — why Airbnb, and the velocity of money",
    "1": "Pick your market and your wedge",
    "2": "Underwrite before you tour",
    "3": "Structure and finance the purchase",
    "4": "Design and furnish for revenue",
    "5": "Launch and rank on Airbnb",
    "6": "Run it like a micro hotel",
    "7": "Equity, ADUs and tax",
}
TAX_BLURB = ("The tax side of the portfolio: depreciation, cost segregation, the real estate "
             "professional, entities and the year-end deadline — taught on Kassidy's own calls.")
AIRBNB_BLURB = ("Buy, launch and run short-term rentals, in lifecycle order. Built from the "
                "Escape Velocity call archive — every lesson links to the recording it came from.")

# Lessons from the Airbnb pass that belong in the TAX course instead (module 7 of the
# Airbnb course is "Equity, ADUs and tax" — the Section 179 / cost-seg / REP material).
TAX_ANCHOR = re.compile(
    r"\btax|depreciat|cost seg|\b179\b|1031|write[- ]?off|deduct|deduction|deductible|"
    r"\bAGI\b|adjusted gross|capital gain|recapture|\bCPA\b|\bIRS\b|cost basis|stepped[- ]up|"
    r"step[- ]up|passive|real estate professional|\bREP\b|\bLLC\b|entity|holding company|"
    r"audit|commingl|bookkeep|bonus depre|in[- ]service|in service|placed in service|"
    r"self[- ]employ|S[- ]?corp|C[- ]?corp|umbrella|quitclaim|Section 121", re.I)
STOP = set("""a an the and or of to in for with on at by from is are be as that this it its
you your we our they them he she his her not no so if then than when where which who what
do does did done can could should would will may might must have has had one two three
about into over under more most less least all any each every other another""".split())

# ── Module hygiene for the tax course ────────────────────────────────────────────
# The miner picks the module itself, and it drifts: module 4 ("Vehicles, Section 179 and
# equipment") kept collecting general tax lessons (IRR targets, 3D renders, Section 121).
# Module 4 is only trustworthy when it is actually about vehicles/179 — everything else
# is re-routed to the module it belongs to, or dropped when it is not tax content at all.
VEHICLE_179 = re.compile(
    r"section 179|\b179\b|6,?0{3} (pounds|lb)|6,?001|GVWR|GWVR|light truck|51% business|"
    r"\bvehicle\b|\btruck\b|mileage|business use of (your |the )?(car|vehicle)", re.I)
RETAG_RULES = [
    ("3", re.compile(r"real estate professional|\bREP\b|material participation|100[- ]hour|"
                     r"passive (loss|activit|income|investor)|STR loophole|transient|"
                     r"average stay of seven|short[- ]term rental loophole", re.I)),
    ("5", re.compile(r"1031|capital gain|section 121|stepped[- ]up|step[- ]up in basis|"
                     r"depreciation recapture|recapture|inherit", re.I)),
    ("6", re.compile(r"\bLLC\b|entity|holding company|umbrella|insurance|commingl|"
                     r"\bS[- ]?corp\b|\bC[- ]?corp\b|bank account|bookkeep|QuickBooks|Xero|"
                     r"audit|operating agreement|quitclaim|EIN", re.I)),
    ("1", re.compile(r"cost seg|depreciat|bonus depre|in[- ]service|in service|"
                     r"placed in service|27\.5|39[- ]year|5[- ]year|7[- ]year", re.I)),
]


OFFTOPIC_TITLE = re.compile(
    r"equity multiple|\bIRR\b|20% rule|2\.5x|cash[- ]on[- ]cash|underwrit", re.I)


def retag_tax(lesson):
    """Return the module this lesson really belongs in, or None to drop it."""
    if str(lesson.get("module")) != "4":
        return lesson.get("module")
    blob = " ".join(str(lesson.get(k) or "") for k in ("title", "teaches", "rule"))
    if VEHICLE_179.search(blob):
        return "4"
    for mod, rx in RETAG_RULES:
        if rx.search(blob):
            return mod
    return None


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def toks(s):
    return {w for w in norm(s).split() if w not in STOP and len(w) > 2}


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def load_drive_index():
    """name (without extension) -> media file id, longest-extension match wins."""
    idx = load(f"{STATE}/ev_drive_index.json", {}).get("files", {})
    out = {}
    for name, val in idx.items():
        fid = val[0] if isinstance(val, list) else val
        base, ext = os.path.splitext(name)
        if ext.lower() not in (".mp4", ".mov", ".mp3", ".m4a"):
            continue
        key = norm(base)
        # prefer mp4 over mp3 when both exist
        if key in out and not name.lower().endswith(".mp4"):
            continue
        out[key] = fid
    return out


def drive_id_for(entry, index):
    if entry.get("drive_id"):
        return entry["drive_id"]
    key = norm(entry.get("name") or entry.get("label") or "")
    if key in index:
        return index[key]
    # loose containment fallback (e.g. trailing punctuation differences)
    for k, fid in index.items():
        if key and (key in k or k in key):
            return fid
    return None


def hhmmss(s):
    if s is None:
        return None
    s = int(s)
    return f"{s // 3600}:{(s % 3600) // 60:02d}:{s % 60:02d}"


def load_clips():
    """Clip URLs built by ~/.hermes/scripts/ev_clip_pipeline.py, keyed by "label|startSec"."""
    d = load(f"{STATE}/ev_clips.json", {"clips": {}}).get("clips", {})
    out = {}
    for k, c in d.items():
        if c.get("status") == "ok" and c.get("url"):
            out[k] = {"url": c["url"], "dur": c.get("dur"), "bytes": c.get("bytes")}
    return out


def watch_url(drive_id, start_sec):
    if not drive_id:
        return None
    if start_sec is None:
        return f"https://drive.google.com/file/d/{drive_id}/view"
    return f"https://drive.google.com/file/d/{drive_id}/view?t={int(start_sec)}"


def score_lesson(L):
    """Higher = better candidate for the curated spine."""
    s = 0.0
    rule = L.get("rule") or ""
    if rule:
        s += 2.0
    if re.search(r"\d", rule):
        s += 2.0
    if re.search(r"\d", L.get("title") or ""):
        s += 0.5
    conf = (L.get("confidence") or "").lower()
    s += {"high": 1.5, "medium": 0.5, "low": -1.0}.get(conf, 0.0)
    if len(rule) > 60:
        s += 0.5
    if (L.get("title") or "").strip().endswith("?"):
        s -= 0.5
    return s


def curate(lessons, modules, cap_per_module):
    """Deduplicate across calls, keep the best version of each idea, cap per module."""
    kept, dropped = [], 0
    # bucket by module first so a strong idea in module 1 can't eat module 5's slot
    by_mod = defaultdict(list)
    for L in lessons:
        by_mod[str(L.get("module") or "")].append(L)

    for mod in sorted(by_mod):
        bucket = by_mod[mod]
        for L in bucket:
            L["_score"] = score_lesson(L)
        bucket.sort(key=lambda x: -x["_score"])
        chosen = []
        for L in bucket:
            sig = toks(L.get("title") or "") | toks(L.get("rule") or "")
            dup_of = None
            for C in chosen:
                if jaccard(sig, C["_sig"]) >= 0.45:
                    dup_of = C
                    break
            if dup_of is not None:
                src = L.get("_source")
                if src and src not in dup_of["_also"]:
                    dup_of["_also"].append(src)
                dropped += 1
                continue
            L["_sig"] = sig
            L["_also"] = list(L.get("_also") or [])
            chosen.append(L)
            if len(chosen) >= cap_per_module:
                break
        for L in chosen:
            kept.append(L)
    return kept, dropped


def build_course(course_id, title, subtitle, blurb, modules, mined, worklist, index, cap, tax_only=False,
                 tax_from_other=None, clips=None):
    """mined: list of {label, lessons[]}  ->  a course document for the portal."""
    meta = {c["label"]: c for c in worklist.get("calls", [])}
    pool = []
    for run in mined:
        # focus sweeps are stored as "<label> [focus M4]" — resolve the base entry for it
        base_label = re.sub(r"\s*\[(focus|grep) M\d+\]$", "", run.get("label") or "")
        for L in run.get("lessons", []):
            blob = " ".join(str(L.get(k) or "") for k in ("title", "teaches", "rule"))
            if tax_only and not TAX_ANCHOR.search(blob):
                continue
            L = dict(L)
            if course_id == "tax":
                # underwriting metrics (equity multiple, IRR, 20% rule) are the Airbnb
                # course's job — they clutter a tax course and the miner keeps pulling them in
                if OFFTOPIC_TITLE.search(L.get("title") or ""):
                    continue
                mod = retag_tax(L)
                if mod is None:
                    continue
                L["module"] = mod
            L["_label"] = base_label
            e = meta.get(base_label, {})
            did = run.get("drive_id") or e.get("drive_id") or drive_id_for(e, index) or drive_id_for(run, index)
            L["_source"] = {
                "label": base_label,
                "guest": e.get("guest"),
                "driveId": did,
                "startSec": L.get("start_sec"),
                "endSec": L.get("end_sec"),
                "at": hhmmss(L.get("start_sec")),
                "watch": watch_url(did, L.get("start_sec")),
            }
            if L.get("start_sec") is not None:
                cl = (clips or {}).get(f"{base_label}|{int(L['start_sec'])}")
                if cl:
                    L["_source"]["clip"] = cl
            pool.append(L)

    kept, dropped = curate(pool, modules, cap)

    by_mod = defaultdict(list)
    for L in kept:
        by_mod[str(L.get("module") or "")].append(L)

    mods = []
    for m in sorted(modules):
        lessons = sorted(by_mod.get(m, []), key=lambda x: -(x.get("_score") or 0))
        if not lessons:
            continue
        mods.append({
            "n": m,
            "title": modules[m],
            "count": len(lessons),
            "lessons": [{
                "title": L.get("title"),
                "teaches": L.get("teaches"),
                "rule": L.get("rule"),
                "speaker": L.get("speaker") or "Kassidy",
                "source": L["_source"],
                "alsoIn": [
                    {"label": a["label"], "watch": a["watch"], "at": a["at"]}
                    for a in L.get("_also", [])
                ],
            } for L in lessons],
        })

    return {
        "id": course_id,
        "title": title,
        "subtitle": subtitle,
        "blurb": blurb,
        "moduleCount": len(mods),
        "lessonCount": sum(m["count"] for m in mods),
        "sourceCalls": len({L["_source"]["label"] for L in kept}),
        "modules": mods,
        "_dropped": dropped,
    }


def js_module(name, obj):
    body = json.dumps(obj, ensure_ascii=False, indent=1)
    body = body.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return (f"// AUTO-GENERATED by scripts/build_course_data.py — do not edit by hand.\n"
            f"// Member-only course data: bundled into the serverless function, never in public/.\n"
            f"const {name} = {body};\n\nexport default {name};\n")


def write_markdown(course, path):
    """A readable export of the CURATED course (same content the portal serves)."""
    L = [f"# {course['title']}", "", f"*{course['subtitle']}*", "",
         course["blurb"], "",
         f"**{course['lessonCount']} lessons · {course['moduleCount']} modules · "
         f"drawn from {course['sourceCalls']} recorded Escape Velocity calls.**", "",
         "Live, gated version: https://www.vomcalc.com/members/", ""]
    for m in course["modules"]:
        L += [f"## Module {m['n']} — {m['title']}", ""]
        for i, les in enumerate(m["lessons"], 1):
            s = les.get("source") or {}
            src = s.get("label") or ""
            bits = [b for b in [src, f"guest: {s['guest']}" if s.get("guest") else None,
                                s.get("at")] if b]
            L += [f"### {m['n']}.{i} {les['title']}", f"*{' · '.join(bits)}*", ""]
            if les.get("teaches"):
                L += [les["teaches"], ""]
            if les.get("rule"):
                L += [f"**The rule:** {les['rule']}", ""]
            if s.get("watch"):
                L += [f"[Watch this part]({s['watch']})", ""]
            also = [a for a in (les.get("alsoIn") or []) if a.get("watch")]
            if also:
                L += ["Also taught in: " + "; ".join(
                    f"[{a['label']}]({a['watch']})" for a in also[:3]), ""]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("\n".join(L))
    return path


def main():
    index = load_drive_index()
    ab_wl = load(f"{STATE}/airbnb_course_calls.json", {"calls": []})
    tax_wl = load(f"{STATE}/tax_course_calls.json", {"calls": []})
    ab = load(f"{STATE}/airbnb_lessons.json", {"calls": []})
    tax = load(f"{STATE}/tax_course_lessons.json", {"calls": [], "modules": {}})

    tax_modules = tax.get("modules") or {}

    clips = load_clips()
    airbnb = build_course(
        "airbnb", "The Airbnb Playbook",
        "Buy, launch and run short-term rentals — in lifecycle order",
        AIRBNB_BLURB, AIRBNB_MODULES, ab.get("calls", []), ab_wl, index, cap=12, clips=clips)

    # The tax course draws on BOTH passes: its own tax worklist, plus the tax-anchored
    # lessons the Airbnb pass extracted (Section 179, cost seg, REP, the lazy 1031).
    taxcourse = build_course(
        "tax", "The Tax Playbook",
        "Turn the portfolio into a tax machine — depreciation, cost seg, REP, entities, year-end",
        TAX_BLURB, tax_modules or {"0": "Tax is the fourth lever"}, tax.get("calls", []), tax_wl,
        index, cap=11, tax_only=True, clips=clips)
    extra = build_course(
        "tax", "The Tax Playbook (from the Airbnb archive)", "", "",
        tax_modules or {"0": "Tax is the fourth lever"}, ab.get("calls", []), ab_wl, index,
        cap=40, tax_only=True, clips=clips)

    # merge the two tax pools, then curate again so the combined set stays tight
    def carry(les, module_n):
        src = les["source"]
        also = []
        for a in les.get("alsoIn") or []:
            also.append({"label": a["label"], "_source": {
                "label": a["label"], "guest": None, "driveId": None,
                "startSec": None, "at": a.get("at"), "watch": a.get("watch"),
            }, "at": a.get("at"), "watch": a.get("watch")})
        return {"title": les["title"], "module": module_n, "teaches": les["teaches"],
                "rule": les["rule"], "speaker": les["speaker"], "confidence": "high",
                "start_sec": src.get("startSec"), "_source": src, "_label": src["label"],
                "_also": also}

    merged_pool = []
    for L in taxcourse["modules"]:
        for les in L["lessons"]:
            merged_pool.append(carry(les, L["n"]))
    for L in extra["modules"]:
        for les in L["lessons"]:
            merged_pool.append(carry(les, L["n"]))
    kept, dropped = curate(merged_pool, tax_modules or {"0": "Tax is the fourth lever"}, 12)
    by_mod = defaultdict(list)
    for L in kept:
        by_mod[str(L.get("module") or "")].append(L)
    mods = []
    for m in sorted(tax_modules or {"0": "Tax is the fourth lever"}):
        les = sorted(by_mod.get(m, []), key=lambda x: -(x.get("_score") or 0))
        if not les:
            continue
        mods.append({"n": m, "title": tax_modules.get(m, ""), "count": len(les),
                     "lessons": [{"title": L["title"], "teaches": L["teaches"], "rule": L["rule"],
                                  "speaker": L["speaker"], "source": L["_source"],
                                  "alsoIn": [{"label": a["label"], "watch": a["watch"], "at": a["at"]}
                                             for a in L.get("_also", [])]} for L in les]})
    taxcourse = {
        "id": "tax", "title": "The Tax Playbook",
        "subtitle": "Depreciation, cost segregation, REP, entities and the year-end deadline",
        "blurb": TAX_BLURB, "moduleCount": len(mods),
        "lessonCount": sum(m["count"] for m in mods),
        "sourceCalls": len({L["_source"]["label"] for L in kept}),
        "modules": mods, "_dropped": dropped,
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    for course in (airbnb, taxcourse):
        course.pop("_dropped", None)

    with open(f"{OUT_DIR}/airbnb.js", "w") as f:
        f.write(js_module("airbnb", airbnb))
    with open(f"{OUT_DIR}/tax.js", "w") as f:
        f.write(js_module("tax", taxcourse))
    with open(f"{OUT_DIR}/index.js", "w") as f:
        f.write(
            "// AUTO-GENERATED by scripts/build_course_data.py\n"
            "import airbnb from './airbnb.js';\n"
            "import tax from './tax.js';\n\n"
            "const courses = { airbnb, tax };\n\n"
            "export function catalogue() {\n"
            "  return Object.values(courses).map((c) => ({\n"
            "    id: c.id, title: c.title, subtitle: c.subtitle, blurb: c.blurb,\n"
            "    moduleCount: c.moduleCount, lessonCount: c.lessonCount, sourceCalls: c.sourceCalls,\n"
            "    modules: c.modules.map((m) => ({ n: m.n, title: m.title, count: m.count })),\n"
            "  }));\n"
            "}\n\n"
            "export default courses;\n")

    for c in (airbnb, taxcourse):
        print(f"{c['id']:<8} {c['lessonCount']:>3} lessons · {c['moduleCount']} modules · "
              f"{c['sourceCalls']} source calls")
    print(f"wrote {OUT_DIR}/{{airbnb,tax,index}}.js")

    print(write_markdown(airbnb, f"{HOME}/projects/airbnb-course/THE-AIRBNB-PLAYBOOK.md"))
    print(write_markdown(taxcourse, f"{HOME}/projects/tax-course/THE-TAX-PLAYBOOK.md"))


if __name__ == "__main__":
    sys.exit(main())
