"""Join NHANES components into one tidy modelling table.

Design constraint driving every choice here: **only use features the Niyantrana
app can actually supply at inference time.** NHANES measures hundreds of things,
but a model that needs a lab draw to predict a lab draw is useless in an app. So
the feature set is restricted to what onboarding, meal logs and a wearable
provide -- age, sex, BMI, waist, dietary macros, sleep hours, activity minutes,
alcohol and smoking.

NHANES encodes "refused" and "do not know" as sentinel values (7/9, 77/99,
777/999, 7777/9999) that are numerically valid and will silently poison a model.
Every such code is mapped to NaN below.
"""
import os

import numpy as np
import pandas as pd

CACHE_DIR = os.environ.get('NHANES_CACHE', 'data/nhanes')
OUTPUT_PATH = 'data/processed/nhanes_metabolic.csv'

CYCLE_SUFFIX = {'2013-2014': 'H', '2015-2016': 'I', '2017-2018': 'J'}

# NHANES refused / do-not-know sentinels, per variable.
MISSING_CODES = {
    'ALQ121': [77, 99], 'ALQ130': [777, 999],
    'PAQ605': [7, 9], 'PAQ620': [7, 9], 'PAQ650': [7, 9], 'PAQ665': [7, 9],
    'PAQ610': [77, 99], 'PAQ625': [77, 99], 'PAQ655': [77, 99], 'PAQ670': [77, 99],
    'PAD615': [7777, 9999], 'PAD630': [7777, 9999],
    'PAD660': [7777, 9999], 'PAD675': [7777, 9999], 'PAD680': [7777, 9999],
    'SLQ050': [7, 9], 'SMQ020': [7, 9], 'SMQ040': [7, 9],
    'DIQ010': [7, 9], 'BPQ020': [7, 9], 'BPQ040A': [7, 9], 'BPQ050A': [7, 9],
}

# ALQ121 drinking-frequency category -> approximate days per week.
ALQ_FREQ_TO_DAYS = {0: 0.0, 1: 7.0, 2: 6.0, 3: 3.5, 4: 2.0, 5: 1.0,
                    6: 0.58, 7: 0.23, 8: 0.17, 9: 0.09, 10: 0.03}


def _read(component, suffix):
    path = os.path.join(CACHE_DIR, f"{component}_{suffix}.xpt")
    if not os.path.exists(path):
        return None
    df = pd.read_sas(path)
    df.columns = [c.upper() for c in df.columns]
    return df


def _clean_codes(df):
    for col, codes in MISSING_CODES.items():
        if col in df.columns and codes:
            df[col] = df[col].replace(codes, np.nan)
    return df


def _mean_bp(df, prefix):
    """Average the valid BP readings; a reading of 0 means not obtained."""
    cols = [c for c in (f'{prefix}1', f'{prefix}2', f'{prefix}3', f'{prefix}4')
            if c in df.columns]
    if not cols:
        return pd.Series(np.nan, index=df.index)
    return df[cols].replace(0, np.nan).mean(axis=1)


def _activity_minutes(df):
    """Weekly moderate and vigorous minutes from the four PAQ activity domains."""
    def domain(gate, days, mins):
        if not all(c in df.columns for c in (gate, days, mins)):
            return pd.Series(0.0, index=df.index)
        weekly = df[days].fillna(0) * df[mins].fillna(0)
        # Gate == 2 means no such activity; treat as zero rather than missing.
        return weekly.where(df[gate] != 2, 0.0).fillna(0.0)

    vigorous = domain('PAQ605', 'PAQ610', 'PAD615') + domain('PAQ650', 'PAQ655', 'PAD660')
    moderate = domain('PAQ620', 'PAQ625', 'PAD630') + domain('PAQ665', 'PAQ670', 'PAD675')
    return vigorous, moderate


COMPONENT_COLUMNS = [
    ('BMX', ['BMXBMI', 'BMXWAIST', 'BMXWT', 'BMXHT']),
    ('TRIGLY', ['LBXTR', 'LBDLDL']),
    ('BIOPRO', ['LBXSGTSI', 'LBXSATSI', 'LBXSASSI']),
    ('HDL', ['LBDHDD']),
    ('GHB', ['LBXGH']),
    ('GLU', ['LBXGLU']),
    ('BPX', ['BPXSY1', 'BPXSY2', 'BPXSY3', 'BPXSY4',
             'BPXDI1', 'BPXDI2', 'BPXDI3', 'BPXDI4']),
    ('DR1TOT', ['DR1TKCAL', 'DR1TTFAT', 'DR1TCARB', 'DR1TPROT',
                'DR1TSUGR', 'DR1TFIBE', 'DR1TSFAT', 'DR1TALCO']),
    ('ALQ', ['ALQ121', 'ALQ130']),
    ('PAQ', ['PAQ605', 'PAQ610', 'PAD615', 'PAQ620', 'PAQ625', 'PAD630',
             'PAQ650', 'PAQ655', 'PAD660', 'PAQ665', 'PAQ670', 'PAD675', 'PAD680']),
    ('SLQ', ['SLD012', 'SLQ050']),
    ('SMQ', ['SMQ020', 'SMQ040']),
    ('DIQ', ['DIQ010']),
    ('BPQ', ['BPQ020', 'BPQ040A', 'BPQ050A']),
]


def build_cycle(cycle):
    suffix = CYCLE_SUFFIX[cycle]
    demo = _read('DEMO', suffix)
    if demo is None:
        print(f"{cycle}: DEMO missing, skipping")
        return None

    df = demo[['SEQN', 'RIDAGEYR', 'RIAGENDR', 'RIDRETH3', 'INDFMPIR']].copy()
    for component, cols in COMPONENT_COLUMNS:
        part = _read(component, suffix)
        if part is None:
            continue
        keep = ['SEQN'] + [c for c in cols if c in part.columns]
        df = df.merge(part[keep], on='SEQN', how='left')

    df = _clean_codes(df)
    df['cycle'] = cycle
    return df


def derive_features(df):
    out = pd.DataFrame(index=df.index)
    out['seqn'] = df['SEQN']
    out['cycle'] = df['cycle']

    # --- Collected at onboarding ---
    out['age'] = df['RIDAGEYR']
    out['sex_male'] = (df['RIAGENDR'] == 1).astype(float)
    out['bmi'] = df.get('BMXBMI')
    out['waist_cm'] = df.get('BMXWAIST')

    # --- From meal logging (NHANES 24h dietary recall) ---
    out['energy_kcal'] = df.get('DR1TKCAL')
    out['fat_g'] = df.get('DR1TTFAT')
    out['carb_g'] = df.get('DR1TCARB')
    out['protein_g'] = df.get('DR1TPROT')
    out['sugar_g'] = df.get('DR1TSUGR')
    out['fibre_g'] = df.get('DR1TFIBE')
    out['satfat_g'] = df.get('DR1TSFAT')

    # --- From a wearable ---
    out['sleep_hours'] = df.get('SLD012')
    vigorous, moderate = _activity_minutes(df)
    out['vigorous_min_week'] = vigorous
    out['moderate_min_week'] = moderate
    # Standard MET weighting: vigorous minutes count double.
    out['mvpa_min_week'] = moderate + 2 * vigorous
    out['sedentary_min_day'] = df.get('PAD680')

    # --- Lifestyle ---
    if 'ALQ121' in df.columns and 'ALQ130' in df.columns:
        days = df['ALQ121'].map(ALQ_FREQ_TO_DAYS)
        out['alcohol_drinks_week'] = (days * df['ALQ130'].fillna(0)).fillna(0.0)
    else:
        out['alcohol_drinks_week'] = 0.0

    smoke = pd.Series(np.nan, index=df.index)
    if 'SMQ020' in df.columns:
        smoke = smoke.mask(df['SMQ020'] == 2, 0.0)                 # never
        if 'SMQ040' in df.columns:
            smoke = smoke.mask(df['SMQ040'] == 3, 1.0)             # former
            smoke = smoke.mask(df['SMQ040'].isin([1, 2]), 2.0)     # current
    out['smoking_status'] = smoke

    # --- Targets ---
    out['triglycerides'] = df.get('LBXTR')
    out['ggt'] = df.get('LBXSGTSI')
    out['hba1c'] = df.get('LBXGH')
    out['glucose'] = df.get('LBXGLU')
    out['systolic_bp'] = _mean_bp(df, 'BPXSY')
    out['diastolic_bp'] = _mean_bp(df, 'BPXDI')

    # --- Reference only: context and sanity checks, never model inputs ---
    out['alt'] = df.get('LBXSATSI')
    out['ast'] = df.get('LBXSASSI')
    out['hdl'] = df.get('LBDHDD')
    out['diagnosed_diabetes'] = ((df['DIQ010'] == 1).astype(float)
                                 if 'DIQ010' in df.columns else np.nan)
    out['diagnosed_hypertension'] = ((df['BPQ020'] == 1).astype(float)
                                     if 'BPQ020' in df.columns else np.nan)
    out['bp_medication'] = ((df['BPQ050A'] == 1).astype(float)
                            if 'BPQ050A' in df.columns else np.nan)
    return out


def fatty_liver_index(tg, bmi, ggt, waist):
    """Bedogni 2006 Fatty Liver Index, 0-100. FLI >= 60 rules in steatosis."""
    with np.errstate(divide='ignore', invalid='ignore'):
        z = (0.953 * np.log(tg) + 0.139 * bmi
             + 0.718 * np.log(ggt) + 0.053 * waist - 15.745)
    return 100.0 * np.exp(z) / (1.0 + np.exp(z))


PLAUSIBLE_RANGES = {
    'bmi': (12, 70), 'waist_cm': (50, 200), 'energy_kcal': (500, 6000),
    'sleep_hours': (2, 14), 'triglycerides': (20, 1500), 'ggt': (3, 1000),
    'hba1c': (3, 20), 'systolic_bp': (70, 260), 'diastolic_bp': (30, 160),
}


def apply_plausibility_filters(df):
    """Null out physiologically impossible values rather than let them anchor the model."""
    before = len(df)
    df = df[df['age'] >= 18].copy()
    for col, (lo, hi) in PLAUSIBLE_RANGES.items():
        if col in df.columns:
            df.loc[~df[col].between(lo, hi), col] = np.nan
    print(f"  adults 18+: {len(df)} of {before} rows")
    return df


def main():
    frames = []
    for cycle in CYCLE_SUFFIX:
        raw = build_cycle(cycle)
        if raw is not None and len(raw):
            frames.append(derive_features(raw))
            print(f"{cycle}: {len(raw)} participants")

    if not frames:
        raise SystemExit("No NHANES data found. Run 'python -m src.nhanes.download' first.")

    df = pd.concat(frames, ignore_index=True)
    df = apply_plausibility_filters(df)
    df['fli'] = fatty_liver_index(df['triglycerides'], df['bmi'], df['ggt'], df['waist_cm'])

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    df.to_csv(OUTPUT_PATH, index=False)

    print(f"\n--- NHANES dataset built: {len(df)} adults, {len(df.columns)} columns ---")
    print(f"Saved to {OUTPUT_PATH}\n")
    print("Target availability (non-null):")
    for target in ['triglycerides', 'ggt', 'hba1c', 'systolic_bp', 'diastolic_bp', 'fli']:
        n = int(df[target].notna().sum())
        print(f"  {target:16s} {n:6d}  ({100 * n / len(df):5.1f}%)")
    return df


if __name__ == '__main__':
    main()
