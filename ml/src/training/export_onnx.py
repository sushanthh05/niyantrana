"""Convert the trained Keras model to ONNX for serving.

Serving with onnxruntime instead of TensorFlow is what makes this deployable on
a free 512 MB instance: importing TensorFlow costs ~358 MB of RSS, importing
onnxruntime costs ~33 MB. Numerical parity is exact to ~1e-7.

Run from the ml/ directory after training:
    python -m src.export_onnx
"""
import os
import shutil
import subprocess
import sys

import numpy as np

KERAS_MODEL_PATH = 'models/multimodal_model.h5'
SAVED_MODEL_DIR = 'models/saved_model'
ONNX_MODEL_PATH = 'models/multimodal_model.onnx'
OPSET = 17
PARITY_TOLERANCE = 1e-4


def export():
    import tensorflow as tf  # imported lazily: only the export path needs TF

    if not os.path.exists(KERAS_MODEL_PATH):
        raise SystemExit(f"{KERAS_MODEL_PATH} not found. Run 'python -m src.train' first.")

    model = tf.keras.models.load_model(KERAS_MODEL_PATH)
    if os.path.isdir(SAVED_MODEL_DIR):
        shutil.rmtree(SAVED_MODEL_DIR)
    model.export(SAVED_MODEL_DIR)

    subprocess.run(
        [sys.executable, '-m', 'tf2onnx.convert',
         '--saved-model', SAVED_MODEL_DIR,
         '--output', ONNX_MODEL_PATH,
         '--opset', str(OPSET)],
        check=True,
    )
    return model


def verify_parity(model, n=64, seed=7):
    """Fail loudly if the exported graph disagrees with the Keras model."""
    import onnxruntime as ort

    rng = np.random.default_rng(seed)
    X_lstm = rng.random((n, 14, 6)).astype(np.float32)
    X_mlp = rng.random((n, 8)).astype(np.float32)

    keras_out = model.predict([X_lstm, X_mlp], verbose=0)
    session = ort.InferenceSession(ONNX_MODEL_PATH, providers=['CPUExecutionProvider'])
    onnx_out = session.run(None, {'lstm_input': X_lstm, 'mlp_input': X_mlp})[0]

    max_diff = float(np.abs(keras_out - onnx_out).max())
    if max_diff > PARITY_TOLERANCE:
        raise SystemExit(f"ONNX parity check FAILED: max abs diff {max_diff:.3e}")
    print(f"Parity OK (max abs diff {max_diff:.3e})")
    return max_diff


if __name__ == '__main__':
    keras_model = export()
    verify_parity(keras_model)
    size_kb = os.path.getsize(ONNX_MODEL_PATH) / 1024
    print(f"\nExported {ONNX_MODEL_PATH} ({size_kb:.1f} KB)")
