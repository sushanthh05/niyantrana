"""Download NHANES public data files from the CDC.

NHANES is the reference corpus for fatty-liver / metabolic-risk modelling: it is
free, needs no application, and measures triglycerides, GGT, HbA1c and blood
pressure alongside a 24-hour dietary recall -- the same quantities this app
collects from the user. That correspondence is what lets a model trained here be
served on app-collected inputs.

Files live at:
    https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public/{start_year}/DataFiles/{NAME}_{suffix}.xpt
"""
import os
import time
import urllib.request

BASE_URL = "https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public/{year}/DataFiles/{name}_{suffix}.xpt"
CACHE_DIR = os.environ.get('NHANES_CACHE', 'data/nhanes')

# NHANES releases data in two-year cycles, each with a letter suffix.
CYCLES = {
    '2013-2014': ('2013', 'H'),
    '2015-2016': ('2015', 'I'),
    '2017-2018': ('2017', 'J'),
}

# Component -> why we want it.
COMPONENTS = {
    'DEMO':   'age, sex, ethnicity, income',
    'BMX':    'BMI, waist circumference',
    'TRIGLY': 'triglycerides (FLI input, target)',
    'BIOPRO': 'GGT, ALT, AST (FLI input, target)',
    'HDL':    'HDL cholesterol',
    'GHB':    'HbA1c (diabetes target)',
    'GLU':    'fasting glucose',
    'BPX':    'blood pressure (hypertension target)',
    'DR1TOT': '24-hour dietary recall: kcal, fat, carbs, protein, sugar, fibre',
    'ALQ':    'alcohol intake (major GGT confounder)',
    'PAQ':    'physical activity minutes',
    'SLQ':    'sleep duration',
    'SMQ':    'smoking status',
    'DIQ':    'diagnosed diabetes',
    'BPQ':    'diagnosed hypertension, BP medication',
}


def download_file(name, cycle, cache_dir=CACHE_DIR, retries=3):
    """Fetch one component for one cycle. Returns the local path, or None."""
    year, suffix = CYCLES[cycle]
    url = BASE_URL.format(year=year, name=name, suffix=suffix)
    os.makedirs(cache_dir, exist_ok=True)
    dest = os.path.join(cache_dir, f"{name}_{suffix}.xpt")

    if os.path.exists(dest) and os.path.getsize(dest) > 1024:
        return dest

    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'niyantrana-research/1.0'})
            with urllib.request.urlopen(req, timeout=120) as resp:
                payload = resp.read()
            # The CDC serves a styled 404 page with HTTP 200 for unknown files.
            if not payload.startswith(b'HEADER RECORD'):
                print(f"  {name}_{suffix}: not available for {cycle}")
                return None
            with open(dest, 'wb') as fh:
                fh.write(payload)
            print(f"  {name}_{suffix}: {len(payload)/1_048_576:.1f} MB")
            return dest
        except Exception as exc:
            if attempt == retries - 1:
                print(f"  {name}_{suffix}: FAILED ({exc})")
                return None
            time.sleep(2 ** attempt)
    return None


def download_cycle(cycle, components=None, cache_dir=CACHE_DIR):
    components = components or list(COMPONENTS)
    print(f"\nCycle {cycle}:")
    return {name: download_file(name, cycle, cache_dir) for name in components}


if __name__ == '__main__':
    import sys
    cycles = sys.argv[1:] or list(CYCLES)
    total = 0
    for cycle in cycles:
        got = download_cycle(cycle)
        total += sum(1 for v in got.values() if v)
    print(f"\n{total} files cached in {CACHE_DIR}/")
