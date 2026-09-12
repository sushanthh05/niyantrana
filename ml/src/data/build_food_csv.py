"""Convert the Anuvaad INDB spreadsheet into the slim CSV the service loads.

Build step, not a runtime step. Rationale:

* CSV loads in 0.01s against 0.71s for the xlsx -- a 58x cold-start saving on a
  free tier that spins down after 15 minutes of inactivity.
* 0.19 MB against 1.01 MB.
* It removes openpyxl from the deployment image entirely.
* The recommender uses 12 of the 82 columns; the other 70 nutrient fields are
  dead weight in every request.

Run from the ml/ directory:
    python -m src.data.build_food_csv
"""
import os

import pandas as pd

SOURCE = os.environ.get("FOOD_DB_SOURCE", "data/raw/Anuvaad_INDB_2024.11.xlsx")
DESTINATION = os.environ.get("FOOD_DB_CSV", "data/raw/anuvaad_indb_2024.11.csv")

# Columns the retriever and prompt builder actually read.
COLUMNS = ["food_code", "food_name", "primarysource", "energy_kj", "energy_kcal",
           "carb_g", "protein_g", "fat_g", "freesugar_g", "fibre_g",
           "servings_unit", "unit_serving_energy_kcal"]

REQUIRED = ["food_name", "energy_kcal", "fat_g", "protein_g"]


def main():
    if not os.path.exists(SOURCE):
        raise SystemExit(f"{SOURCE} not found.")

    frame = pd.read_excel(SOURCE)
    keep = [c for c in COLUMNS if c in frame.columns]
    missing = [c for c in REQUIRED if c not in keep]
    if missing:
        raise SystemExit(f"Source is missing required column(s): {missing}")

    slim = frame[keep].dropna(subset=REQUIRED)
    slim.to_csv(DESTINATION, index=False)

    print(f"{SOURCE} ({os.path.getsize(SOURCE)/1048576:.2f} MB, {len(frame.columns)} cols)")
    print(f"  -> {DESTINATION} ({os.path.getsize(DESTINATION)/1048576:.2f} MB, "
          f"{len(keep)} cols, {len(slim)} rows)")


if __name__ == "__main__":
    main()
