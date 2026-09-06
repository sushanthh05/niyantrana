import os
import sys

# Tests are run from the ml/ directory so that the relative model/scaler paths
# baked into src.predict resolve.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
sys.path.insert(0, ROOT)
